const db = require('./database');
const { detectTasks, handleReaction } = require('./tasks');
const { backfillChannel } = require('./backfill');
const { chat, clearHistory } = require('./ai');
const { log, retrySlack } = require('./utils');

// Authorized user IDs that can talk to the bot via DM.
const AUTHORIZED_USERS = (process.env.AUTHORIZED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

function isAuthorized(userId) {
  return AUTHORIZED_USERS.length === 0 || AUTHORIZED_USERS.includes(userId);
}

// Track messages we've already processed to avoid duplicate handling
const recentlyProcessed = new Set();
const DEDUP_TTL_MS = 10000; // 10 seconds

function isDuplicate(key) {
  if (recentlyProcessed.has(key)) return true;
  recentlyProcessed.add(key);
  setTimeout(() => recentlyProcessed.delete(key), DEDUP_TTL_MS);
  return false;
}

/**
 * Register all event listeners with the Slack app.
 */
function registerEvents(app) {

  // --- Listen to ALL messages ---
  app.message(async ({ message, client, context }) => {
    try {
      // Skip bot messages and subtypes handled elsewhere
      if (message.bot_id || message.subtype === 'bot_message') return;
      if (message.subtype) return; // skip all subtypes here (edits, deletes, joins, etc.)

      const channelId = message.channel;
      const isDM = message.channel_type === 'im';

      // Dedup — Slack can send duplicate events
      const dedupKey = `msg:${channelId}:${message.ts}`;
      if (isDuplicate(dedupKey)) return;

      // --- DM conversation with the bot (AI-powered) ---
      if (isDM) {
        if (!isAuthorized(message.user)) {
          await retrySlack(
            () => client.chat.postMessage({
              channel: channelId,
              text: "Sorry, I'm not configured to chat with you. Ask your admin to add your user ID to AUTHORIZED_USERS.",
            }),
            { label: 'dm:unauthorized', maxRetries: 1 }
          );
          return;
        }

        // Handle reset command
        if (message.text?.trim().toLowerCase() === 'reset') {
          clearHistory(message.user);
          await retrySlack(
            () => client.chat.postMessage({
              channel: channelId,
              text: "Conversation cleared. What would you like to know?",
            }),
            { label: 'dm:reset', maxRetries: 1 }
          );
          return;
        }

        log.info('dm', `${message.user}: ${message.text?.slice(0, 100)}`);

        // Send message to Claude AI with tool access
        const reply = await chat(message.user, message.text);

        // Slack has a 4000 char limit per message — split if needed
        const chunks = splitMessage(reply, 3900);
        for (const chunk of chunks) {
          await retrySlack(
            () => client.chat.postMessage({
              channel: channelId,
              text: chunk,
              mrkdwn: true,
            }),
            { label: 'dm:reply', maxRetries: 2 }
          );
        }
        return;
      }

      // --- Channel message tracking (silent — no responses in channels) ---

      db.upsertMessage({ ...message, channel_id: channelId });

      if (message.user) {
        db.logActivity(channelId, message.user, 'message', message.ts);
      }

      // Ensure user is in our DB
      if (message.user && !db.getUser(message.user)) {
        try {
          const userInfo = await retrySlack(
            () => client.users.info({ user: message.user }),
            { label: 'event:user', maxRetries: 1 }
          );
          db.upsertUser(userInfo.user);
        } catch (_) { /* non-critical */ }
      }

      // Detect tasks
      const newTasks = detectTasks(message, channelId);
      if (newTasks.length > 0) {
        const ch = db.getChannel(channelId);
        log.info('tasks', `Detected ${newTasks.length} task(s) in #${ch?.name || channelId}: ${newTasks.map(t => t.title).join(', ')}`);
      }
    } catch (error) {
      log.error('event:message', `Unhandled error: ${error.message}`);
    }
  });

  // --- Message changed (edits) ---
  app.event('message', async ({ event }) => {
    try {
      if (event.subtype === 'message_changed' && event.message) {
        const dedupKey = `edit:${event.channel}:${event.message.ts}`;
        if (isDuplicate(dedupKey)) return;

        db.upsertMessage({ ...event.message, channel_id: event.channel, channel: event.channel });
        detectTasks(event.message, event.channel);
      }
      if (event.subtype === 'message_deleted' && event.previous_message) {
        // Mark deleted messages — don't remove from DB (keeps task references valid)
        db.getDb().prepare(
          "UPDATE messages SET text = '[deleted]' WHERE ts = ? AND channel_id = ?"
        ).run(event.previous_message.ts, event.channel);
      }
    } catch (error) {
      log.error('event:message_changed', `Error: ${error.message}`);
    }
  });

  // --- Reaction added → update task status ---
  app.event('reaction_added', async ({ event }) => {
    try {
      const dedupKey = `react:${event.item.channel}:${event.item.ts}:${event.reaction}`;
      if (isDuplicate(dedupKey)) return;

      const result = handleReaction(event.reaction, event.item.ts, event.item.channel);
      if (result) {
        log.info('tasks', `Task #${result.taskId} status: ${result.oldStatus} → ${result.newStatus} (via :${event.reaction}:)`);
      }
      if (event.user) {
        db.logActivity(event.item.channel, event.user, 'reaction', event.item.ts);
      }
    } catch (error) {
      log.error('event:reaction_added', `Error: ${error.message}`);
    }
  });

  // --- Reaction removed → revert task if needed ---
  app.event('reaction_removed', async ({ event }) => {
    try {
      const { REACTION_STATUS_MAP } = require('./tasks');
      const wasStatus = REACTION_STATUS_MAP[event.reaction];
      if (wasStatus) {
        const task = db.getDb().prepare(
          'SELECT id, status FROM tasks WHERE message_ts = ? AND channel_id = ?'
        ).get(event.item.ts, event.item.channel);
        if (task && task.status === wasStatus) {
          db.updateTaskStatus(task.id, 'open');
          log.info('tasks', `Task #${task.id} reverted to open (removed :${event.reaction}:)`);
        }
      }
    } catch (error) {
      log.error('event:reaction_removed', `Error: ${error.message}`);
    }
  });

  // --- Channel created → auto-join ---
  app.event('channel_created', async ({ event, client }) => {
    try {
      log.info('event', `New channel created: #${event.channel.name}`);
      await retrySlack(
        () => client.conversations.join({ channel: event.channel.id }),
        { label: 'join:new' }
      );
      log.info('join', `Auto-joined #${event.channel.name}`);
      db.upsertChannel({ ...event.channel, is_private: false });
    } catch (e) {
      log.error('join', `Failed to auto-join #${event.channel.name}: ${e.message}`);
    }
  });

  // --- Bot was added to a channel → backfill ---
  app.event('member_joined_channel', async ({ event, client, context }) => {
    try {
      if (event.user === context.botUserId) {
        log.info('event', `Bot added to channel ${event.channel}`);
        await backfillChannel(client, event.channel);
      } else {
        db.upsertChannelMember(event.channel, event.user);
        db.logActivity(event.channel, event.user, 'joined', event.event_ts);

        if (!db.getUser(event.user)) {
          try {
            const userInfo = await retrySlack(
              () => client.users.info({ user: event.user }),
              { label: 'event:user_join', maxRetries: 1 }
            );
            db.upsertUser(userInfo.user);
          } catch (_) { /* non-critical */ }
        }
      }
    } catch (error) {
      log.error('event:member_joined', `Error: ${error.message}`);
    }
  });

  // --- User left channel ---
  app.event('member_left_channel', async ({ event }) => {
    try {
      db.getDb().prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?')
        .run(event.channel, event.user);
      db.logActivity(event.channel, event.user, 'left', event.event_ts);
    } catch (error) {
      log.error('event:member_left', `Error: ${error.message}`);
    }
  });

  // --- Channel renamed ---
  app.event('channel_rename', async ({ event }) => {
    try {
      db.getDb().prepare('UPDATE channels SET name = ? WHERE id = ?')
        .run(event.channel.name, event.channel.id);
      log.info('event', `Channel renamed to #${event.channel.name}`);
    } catch (error) {
      log.error('event:channel_rename', `Error: ${error.message}`);
    }
  });
}

/**
 * Split a long message into chunks that fit Slack's character limit.
 */
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) {
      // No good newline — split at a space
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      // No good split point — hard cut
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

module.exports = { registerEvents };
