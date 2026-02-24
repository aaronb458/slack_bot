const db = require('./database');
const { formatTaskList, formatProjectReport, formatGlobalSummary } = require('./tasks');
const { getUptime } = require('./utils');
const { analyzeChannel } = require('./intelligence');
const { runMorningScan } = require('./morning-scan');

/**
 * Register all slash commands with the Slack app.
 */
function registerCommands(app) {

  // /ping — health check
  app.command('/ping', async ({ command, ack, respond }) => {
    await ack();
    const channels = db.getAllChannels();
    const msgCount = db.getDb().prepare('SELECT COUNT(*) as count FROM messages').get();
    const taskCount = db.getDb().prepare('SELECT COUNT(*) as count FROM tasks').get();
    const userCount = db.getDb().prepare('SELECT COUNT(*) as count FROM users').get();

    await respond({
      response_type: 'ephemeral',
      text: [
        ':white_check_mark: *Bot is running*',
        `*Uptime:* ${getUptime()}`,
        `*Channels tracked:* ${channels.length}`,
        `*Messages stored:* ${msgCount?.count || 0}`,
        `*Tasks tracked:* ${taskCount?.count || 0}`,
        `*Users known:* ${userCount?.count || 0}`,
      ].join('\n'),
    });
  });

  // /tasks [channel] [status] — list tasks
  app.command('/tasks', async ({ command, ack, respond }) => {
    await ack();

    const args = (command.text || '').trim().split(/\s+/);
    const channelId = command.channel_id;

    // /tasks — show current channel tasks
    if (!args[0] || args[0] === '') {
      const tasks = db.getTasksByChannel(channelId);
      await respond({
        response_type: 'ephemeral',
        text: formatTaskList(tasks, `Tasks in <#${channelId}>`),
      });
      return;
    }

    // /tasks all — show all tasks across all channels
    if (args[0] === 'all') {
      const status = args[1] || null;
      const tasks = db.getAllTasks(status);
      await respond({
        response_type: 'ephemeral',
        text: formatTaskList(tasks, `All Tasks${status ? ` (${status})` : ''}`),
      });
      return;
    }

    // /tasks open|done|in_progress|blocked — filter by status
    if (['open', 'done', 'in_progress', 'blocked', 'cancelled'].includes(args[0])) {
      const tasks = db.getTasksByChannel(channelId, args[0]);
      await respond({
        response_type: 'ephemeral',
        text: formatTaskList(tasks, `${args[0]} tasks in <#${channelId}>`),
      });
      return;
    }

    // /tasks mine — show tasks assigned to me
    if (args[0] === 'mine') {
      const status = args[1] || null;
      const tasks = db.getTasksByUser(command.user_id, status);
      await respond({
        response_type: 'ephemeral',
        text: formatTaskList(tasks, `Your Tasks${status ? ` (${status})` : ''}`),
      });
      return;
    }

    // /tasks @user — show tasks for a user
    if (args[0].startsWith('<@')) {
      const userId = args[0].replace(/[<@>]/g, '').split('|')[0];
      const status = args[1] || null;
      const tasks = db.getTasksByUser(userId, status);
      const user = db.getUser(userId);
      await respond({
        response_type: 'ephemeral',
        text: formatTaskList(tasks, `Tasks for ${user?.display_name || userId}${status ? ` (${status})` : ''}`),
      });
      return;
    }

    await respond({
      response_type: 'ephemeral',
      text: '*Usage:* `/tasks [all|open|done|in_progress|blocked|mine|@user]`',
    });
  });

  // /project — show project report for current channel
  app.command('/project', async ({ command, ack, respond }) => {
    await ack();
    const summary = db.getProjectSummary(command.channel_id);
    await respond({
      response_type: 'ephemeral',
      text: formatProjectReport(summary),
    });
  });

  // /summary — global summary across all projects
  app.command('/summary', async ({ command, ack, respond }) => {
    await ack();
    await respond({
      response_type: 'ephemeral',
      text: formatGlobalSummary(),
    });
  });

  // /task add <title> — manually add a task
  app.command('/task', async ({ command, ack, respond }) => {
    await ack();

    const args = (command.text || '').trim();

    // /task add <title>
    if (args.startsWith('add ')) {
      const title = args.slice(4).trim();
      if (!title) {
        await respond({ response_type: 'ephemeral', text: 'Please provide a task title: `/task add Fix the login bug`' });
        return;
      }

      db.createTask({
        channel_id: command.channel_id,
        message_ts: Date.now().toString(),
        created_by: command.user_id,
        title,
        detected_via: 'manual',
      });

      await respond({
        response_type: 'in_channel',
        text: `:radio_button: *New task added:* ${title} (by <@${command.user_id}>)`,
      });
      return;
    }

    // /task done <id>
    if (args.startsWith('done ')) {
      const taskId = parseInt(args.slice(5).trim(), 10);
      if (isNaN(taskId)) {
        await respond({ response_type: 'ephemeral', text: 'Please provide a task ID: `/task done 42`' });
        return;
      }
      db.updateTaskStatus(taskId, 'done');
      await respond({
        response_type: 'in_channel',
        text: `:white_check_mark: Task #${taskId} marked as *done* by <@${command.user_id}>`,
      });
      return;
    }

    // /task progress <id>
    if (args.startsWith('progress ')) {
      const taskId = parseInt(args.slice(9).trim(), 10);
      if (isNaN(taskId)) {
        await respond({ response_type: 'ephemeral', text: 'Please provide a task ID: `/task progress 42`' });
        return;
      }
      db.updateTaskStatus(taskId, 'in_progress');
      await respond({
        response_type: 'in_channel',
        text: `:hourglass: Task #${taskId} marked as *in progress* by <@${command.user_id}>`,
      });
      return;
    }

    // /task assign <id> @user
    if (args.startsWith('assign ')) {
      const parts = args.slice(7).trim().split(/\s+/);
      const taskId = parseInt(parts[0], 10);
      const userMatch = parts[1]?.match(/<@(\w+)/);
      if (isNaN(taskId) || !userMatch) {
        await respond({ response_type: 'ephemeral', text: 'Usage: `/task assign 42 @user`' });
        return;
      }
      const userId = userMatch[1];
      db.getDb().prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(userId, taskId);
      await respond({
        response_type: 'in_channel',
        text: `:point_right: Task #${taskId} assigned to <@${userId}> by <@${command.user_id}>`,
      });
      return;
    }

    await respond({
      response_type: 'ephemeral',
      text: [
        '*Usage:*',
        '`/task add <title>` — Create a new task',
        '`/task done <id>` — Mark task as done',
        '`/task progress <id>` — Mark task as in progress',
        '`/task assign <id> @user` — Assign a task',
      ].join('\n'),
    });
  });

  // /whois @user — show user activity summary
  app.command('/whois', async ({ command, ack, respond }) => {
    await ack();
    const text = (command.text || '').trim();
    const userMatch = text.match(/<@(\w+)/);
    const userId = userMatch ? userMatch[1] : command.user_id;
    const user = db.getUser(userId);

    const openTasks = db.getTasksByUser(userId, 'open');
    const ipTasks = db.getTasksByUser(userId, 'in_progress');
    const doneTasks = db.getTasksByUser(userId, 'done');

    // Channels they're in
    const memberships = db.getDb().prepare(`
      SELECT c.name FROM channel_members cm
      JOIN channels c ON cm.channel_id = c.id
      WHERE cm.user_id = ?
      ORDER BY c.name
    `).all(userId);

    // Recent message count
    const msgCount = db.getDb().prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE user_id = ? AND created_at > ?
    `).get(userId, Math.floor(Date.now() / 1000) - 7 * 86400);

    const sections = [
      `*:bust_in_silhouette: ${user?.real_name || user?.display_name || userId}*`,
      '',
      `*Messages (7d):* ${msgCount?.count || 0}`,
      `*Open tasks:* ${openTasks.length}`,
      `*In progress:* ${ipTasks.length}`,
      `*Completed:* ${doneTasks.length}`,
      '',
      `*Active in:* ${memberships.map(m => `#${m.name}`).join(', ') || 'No channels tracked'}`,
    ];

    if (openTasks.length > 0) {
      sections.push('', formatTaskList(openTasks.slice(0, 5), 'Open Tasks'));
    }

    await respond({ response_type: 'ephemeral', text: sections.join('\n') });
  });

  // /scan — run morning scan on demand
  app.command('/scan', async ({ command, ack, respond }) => {
    await ack();

    const AUTHORIZED_USERS = (process.env.AUTHORIZED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!AUTHORIZED_USERS.includes(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: 'Only authorized users can run the scan.' });
      return;
    }

    await respond({
      response_type: 'ephemeral',
      text: ':hourglass: Running morning scan... This will be DM\'d to you when ready.',
    });

    try {
      const result = await runMorningScan(app);
      if (!result.sent) {
        await respond({ response_type: 'ephemeral', text: ':warning: Scan completed but no results were sent. Check AUTHORIZED_USERS.' });
      }
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: `:x: Scan failed: ${e.message}` });
    }
  });

  // /analyze — analyze the current channel
  app.command('/analyze', async ({ command, ack, respond }) => {
    await ack();

    try {
      const analysis = analyzeChannel(command.channel_id);
      const ch = db.getChannel(command.channel_id);

      const lines = [
        `:mag: *Channel Analysis: #${ch?.name || command.channel_id}*`,
        '',
        `*Mood:* ${analysis.sentiment.mood} (score: ${analysis.sentiment.score})`,
        `*Activity:* ${analysis.activity.tier} (${analysis.activity.messages_per_week} msgs/week)`,
        `*Needs Response:* ${analysis.needs_response.needs_response ? 'Yes' : 'No'}`,
      ];

      if (analysis.needs_response.needs_response) {
        lines.push(`_${analysis.needs_response.reason}_`);
        lines.push(`*Unanswered:* ${analysis.needs_response.unanswered_count}`);
      }

      if (analysis.topics.primary_topic) {
        lines.push(`*Topics:* ${analysis.topics.topics.join(', ')}`);
      }

      lines.push('');
      lines.push(`*Priority Score:* ${analysis.priority_score}/100`);
      lines.push(`_${analysis.priority_reason}_`);

      if (analysis.cancellation.cancelled) {
        lines.push('');
        lines.push(`:warning: *Cancellation detected:* ${analysis.cancellation.detected_by}`);
      }

      await respond({ response_type: 'ephemeral', text: lines.join('\n') });
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: `:x: Analysis failed: ${e.message}` });
    }
  });

  // /team-ids — list known users with their Slack IDs (for configuring TEAM_USER_IDS)
  app.command('/team-ids', async ({ command, ack, respond }) => {
    await ack();

    const AUTHORIZED_USERS = (process.env.AUTHORIZED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!AUTHORIZED_USERS.includes(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: 'Only authorized users can view team IDs.' });
      return;
    }

    const users = db.getDb().prepare(`
      SELECT id, display_name, real_name, is_bot
      FROM users
      WHERE is_bot = 0 OR is_bot IS NULL
      ORDER BY real_name
    `).all();

    if (users.length === 0) {
      await respond({ response_type: 'ephemeral', text: 'No users found. Run the bot first to sync users.' });
      return;
    }

    const teamIds = (process.env.TEAM_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const teamSet = new Set(teamIds);

    const lines = [
      ':busts_in_silhouette: *Known Users — Copy IDs for TEAM_USER_IDS*',
      '',
    ];

    for (const u of users) {
      const name = u.real_name || u.display_name || 'Unknown';
      const isTeam = teamSet.has(u.id) ? ' :white_check_mark:' : '';
      lines.push(`\`${u.id}\` — ${name}${isTeam}`);
    }

    lines.push('');
    lines.push('_Copy the IDs of your team members and set them as TEAM_USER_IDS in your .env (comma-separated)._');
    if (teamIds.length > 0) {
      lines.push(`_Current TEAM_USER_IDS: ${teamIds.join(', ')}_`);
    } else {
      lines.push('_Warning: TEAM_USER_IDS is not set — falling back to AUTHORIZED_USERS._');
    }

    await respond({ response_type: 'ephemeral', text: lines.join('\n') });
  });
}

module.exports = { registerCommands };
