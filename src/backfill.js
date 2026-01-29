const db = require('./database');
const { log, retrySlack, sleep } = require('./utils');

/**
 * Backfill all data for a channel: members, message history, threads, and users.
 * Called when the bot joins a channel or on startup for channels not yet backfilled.
 */
async function backfillChannel(client, channelId) {
  const existing = db.getChannel(channelId);
  if (existing?.backfilled_at) {
    log.info('backfill', `#${existing.name} already backfilled, skipping`);
    return;
  }

  // 1. Get channel info
  log.info('backfill', `Fetching channel info for ${channelId}...`);
  try {
    const info = await retrySlack(
      () => client.conversations.info({ channel: channelId }),
      { label: 'backfill:info' }
    );
    db.upsertChannel(info.channel);
  } catch (e) {
    log.error('backfill', `Failed to get channel info for ${channelId}: ${e.message}`);
    // If we can't even get info, skip this channel entirely
    return;
  }

  const channelName = db.getChannel(channelId)?.name || channelId;

  // 2. Get and store members
  log.info('backfill', `#${channelName}: Fetching members...`);
  let memberCount = 0;
  try {
    let cursor;
    do {
      const res = await retrySlack(
        () => client.conversations.members({ channel: channelId, limit: 200, cursor }),
        { label: 'backfill:members' }
      );
      for (const userId of res.members) {
        db.upsertChannelMember(channelId, userId);
        memberCount++;
        // Fetch user profile if we don't have it
        if (!db.getUser(userId)) {
          try {
            const userInfo = await retrySlack(
              () => client.users.info({ user: userId }),
              { label: 'backfill:user', maxRetries: 2 }
            );
            db.upsertUser(userInfo.user);
          } catch (_) { /* non-critical — user profile fetch failed */ }
          await sleep(100); // gentle rate limit buffer for user lookups
        }
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
  } catch (e) {
    log.error('backfill', `#${channelName}: Failed to get members: ${e.message}`);
  }

  // 3. Fetch message history (up to 1000 messages)
  log.info('backfill', `#${channelName}: Fetching message history...`);
  let totalMessages = 0;
  let totalThreads = 0;
  try {
    let cursor;
    let pages = 0;
    const MAX_PAGES = 10; // 10 pages x 100 = up to 1000 messages

    do {
      const res = await retrySlack(
        () => client.conversations.history({ channel: channelId, limit: 100, cursor }),
        { label: 'backfill:history' }
      );

      for (const msg of res.messages) {
        db.upsertMessage({ ...msg, channel_id: channelId });
        totalMessages++;

        // If this message has thread replies, fetch them
        if (msg.reply_count > 0) {
          try {
            let threadCursor;
            do {
              const threadRes = await retrySlack(
                () => client.conversations.replies({
                  channel: channelId, ts: msg.ts, limit: 200, cursor: threadCursor,
                }),
                { label: 'backfill:thread' }
              );
              for (const reply of threadRes.messages) {
                if (reply.ts !== msg.ts) { // skip parent (already stored)
                  db.upsertMessage({ ...reply, channel_id: channelId });
                  totalMessages++;
                }
              }
              threadCursor = threadRes.response_metadata?.next_cursor;
            } while (threadCursor);
            totalThreads++;
          } catch (e) {
            log.warn('backfill', `#${channelName}: Failed to fetch thread ${msg.ts}: ${e.message}`);
          }
          await sleep(300); // rate limit buffer between thread fetches
        }
      }

      cursor = res.response_metadata?.next_cursor;
      pages++;
      await sleep(200); // rate limit buffer between history pages
    } while (cursor && pages < MAX_PAGES);
  } catch (e) {
    log.error('backfill', `#${channelName}: Failed to get history: ${e.message}`);
  }

  db.markChannelBackfilled(channelId);
  log.info('backfill', `#${channelName} done — ${memberCount} members, ${totalMessages} messages, ${totalThreads} threads`);
}

/**
 * Auto-join all public channels and backfill them.
 */
async function joinAndBackfillAll(client) {
  log.info('startup', 'Discovering and joining channels...');

  let cursor;
  const channels = [];

  try {
    do {
      const res = await retrySlack(
        () => client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        }),
        { label: 'startup:list' }
      );
      channels.push(...res.channels);
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
  } catch (e) {
    log.error('startup', `Failed to list channels: ${e.message}`);
    return;
  }

  log.info('startup', `Found ${channels.length} channels`);

  for (const ch of channels) {
    db.upsertChannel(ch);

    // Join public channels we're not in
    if (!ch.is_member && !ch.is_private) {
      try {
        await retrySlack(
          () => client.conversations.join({ channel: ch.id }),
          { label: 'startup:join' }
        );
        log.info('join', `Joined #${ch.name}`);
      } catch (e) {
        log.warn('join', `Could not join #${ch.name}: ${e.message}`);
      }
      await sleep(500);
    }

    // Backfill channels we're a member of
    if (ch.is_member || !ch.is_private) {
      try {
        await backfillChannel(client, ch.id);
      } catch (e) {
        log.error('backfill', `Unexpected error backfilling #${ch.name}: ${e.message}`);
      }
      await sleep(500); // rate limit buffer between channels
    }
  }

  log.info('startup', 'Backfill complete');
}

/**
 * Sync all workspace users into the database.
 */
async function syncUsers(client) {
  log.info('startup', 'Syncing users...');
  let cursor;
  let count = 0;
  try {
    do {
      const res = await retrySlack(
        () => client.users.list({ limit: 200, cursor }),
        { label: 'startup:users' }
      );
      for (const user of res.members) {
        if (!user.deleted) {
          db.upsertUser(user);
          count++;
        }
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
  } catch (e) {
    log.error('startup', `Failed to sync users: ${e.message}`);
  }
  log.info('startup', `Synced ${count} users`);
}

module.exports = { backfillChannel, joinAndBackfillAll, syncUsers };
