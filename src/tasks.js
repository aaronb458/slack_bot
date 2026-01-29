const db = require('./database');

/**
 * Task detection patterns.
 * Scans message text for keywords/patterns that indicate a task or action item.
 */

const TASK_PATTERNS = [
  // Direct task keywords
  { regex: /\b(?:TODO|TO-DO|ACTION ITEM|ACTION REQUIRED)\b[:\s]*(.+)/i, priority: 'high' },
  // "need to" / "needs to" patterns
  { regex: /\b(?:need(?:s)?\s+to|have\s+to|must)\b\s+(.+)/i, priority: 'normal' },
  // "@person please" / "@person can you" patterns
  { regex: /<@(\w+)>\s+(?:please|can you|could you|would you)\s+(.+)/i, priority: 'normal', hasAssignee: true },
  // Checkbox-style [ ] items
  { regex: /\[\s?\]\s+(.+)/i, priority: 'normal' },
  // "Deadline" / "Due by" patterns
  { regex: /\b(?:deadline|due\s+by|due\s+date|by\s+EOD|by\s+end\s+of\s+day)\b[:\s]*(.+)/i, priority: 'high' },
  // "Follow up" / "Follow-up"
  { regex: /\b(?:follow[\s-]?up)\b[:\s]*(.+)/i, priority: 'normal' },
  // "Waiting on" / "Blocked by"
  { regex: /\b(?:waiting\s+on|blocked\s+by|depends\s+on)\b[:\s]*(.+)/i, priority: 'high' },
];

// Reactions that mark task status
const REACTION_STATUS_MAP = {
  // Done / completed
  'white_check_mark': 'done',
  'heavy_check_mark': 'done',
  'check': 'done',
  'ballot_box_with_check': 'done',
  // In progress
  'eyes': 'in_progress',
  'hourglass': 'in_progress',
  'hourglass_flowing_sand': 'in_progress',
  'construction': 'in_progress',
  // Blocked
  'no_entry': 'blocked',
  'octagonal_sign': 'blocked',
  'red_circle': 'blocked',
  // Cancelled
  'x': 'cancelled',
  'no_entry_sign': 'cancelled',
};

/**
 * Scan a message for task-like content and create task records.
 */
function detectTasks(message, channelId) {
  const text = message.text || '';
  const created = [];

  for (const pattern of TASK_PATTERNS) {
    const match = text.match(pattern.regex);
    if (match) {
      const task = {
        channel_id: channelId,
        message_ts: message.ts,
        thread_ts: message.thread_ts || null,
        created_by: message.user,
        title: (pattern.hasAssignee ? match[2] : match[1]).trim().slice(0, 200),
        priority: pattern.priority,
        detected_via: 'keyword',
      };

      if (pattern.hasAssignee && match[1]) {
        task.assigned_to = match[1];
      }

      // Don't create duplicate tasks for the same message
      const existing = db.getDb().prepare(
        'SELECT id FROM tasks WHERE message_ts = ? AND channel_id = ?'
      ).get(message.ts, channelId);

      if (!existing) {
        db.createTask(task);
        created.push(task);
      }
    }
  }

  return created;
}

/**
 * Update task status based on a reaction event.
 */
function handleReaction(reaction, messageTs, channelId) {
  const newStatus = REACTION_STATUS_MAP[reaction];
  if (!newStatus) return null;

  const task = db.getDb().prepare(
    'SELECT id, status FROM tasks WHERE message_ts = ? AND channel_id = ?'
  ).get(messageTs, channelId);

  if (task && task.status !== newStatus) {
    db.updateTaskStatus(task.id, newStatus);
    return { taskId: task.id, oldStatus: task.status, newStatus };
  }
  return null;
}

/**
 * Format a task list for Slack display.
 */
function formatTaskList(tasks, title) {
  if (!tasks.length) return `*${title}*\nNo tasks found.`;

  const statusEmoji = {
    open: ':radio_button:',
    in_progress: ':hourglass:',
    done: ':white_check_mark:',
    blocked: ':no_entry:',
    cancelled: ':x:',
  };

  const lines = tasks.map((t, i) => {
    const emoji = statusEmoji[t.status] || ':grey_question:';
    const assigned = t.assigned_name ? ` → ${t.assigned_name}` : '';
    const channel = t.channel_name ? ` (#${t.channel_name})` : '';
    const priority = t.priority === 'high' ? ' :fire:' : '';
    return `${emoji} *${i + 1}.* ${t.title}${assigned}${channel}${priority}`;
  });

  return `*${title}* (${tasks.length})\n${lines.join('\n')}`;
}

/**
 * Generate a full project/channel report.
 */
function formatProjectReport(summary) {
  const { channel, members, tasks, messageCount7d, activity } = summary;
  const name = channel?.name || 'Unknown';

  const sections = [
    `*:clipboard: Project Report: #${name}*`,
    `_${channel?.purpose || 'No description'}_`,
    '',
    `*Team Members:* ${members.length}`,
    members.map(m => `  • ${m.display_name || m.real_name || m.user_id}`).join('\n'),
    '',
    `*Messages (last 7 days):* ${messageCount7d}`,
    '',
    formatTaskList(tasks.open, ':radio_button: Open Tasks'),
    '',
    formatTaskList(tasks.in_progress, ':hourglass: In Progress'),
    '',
    formatTaskList(tasks.done.slice(0, 10), ':white_check_mark: Recently Completed'),
  ];

  // Activity breakdown
  if (activity.length > 0) {
    const userActivity = {};
    for (const a of activity) {
      if (!userActivity[a.user_id]) userActivity[a.user_id] = 0;
      userActivity[a.user_id] += a.count;
    }
    const actLines = Object.entries(userActivity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([uid, count]) => {
        const user = db.getUser(uid);
        return `  • ${user?.display_name || user?.real_name || uid}: ${count} actions`;
      });
    sections.push('', `*:bar_chart: Activity (7d):*`, ...actLines);
  }

  return sections.join('\n');
}

/**
 * Global summary across all projects.
 */
function formatGlobalSummary() {
  const allOpen = db.getAllTasks('open');
  const allInProgress = db.getAllTasks('in_progress');
  const allDone = db.getAllTasks('done');
  const channels = db.getAllChannels();

  const sections = [
    `*:globe_with_meridians: Global Project Summary*`,
    `Tracking *${channels.length}* channels/projects`,
    '',
    `*Tasks Overview:*`,
    `  :radio_button: Open: *${allOpen.length}*`,
    `  :hourglass: In Progress: *${allInProgress.length}*`,
    `  :white_check_mark: Done: *${allDone.length}*`,
    '',
  ];

  // Per-channel breakdown
  const channelTasks = {};
  for (const t of [...allOpen, ...allInProgress]) {
    const key = t.channel_id;
    if (!channelTasks[key]) channelTasks[key] = { name: t.channel_name, open: 0, ip: 0 };
    if (t.status === 'open') channelTasks[key].open++;
    else channelTasks[key].ip++;
  }

  if (Object.keys(channelTasks).length > 0) {
    sections.push('*Per-Project Breakdown:*');
    for (const [, ct] of Object.entries(channelTasks).sort((a, b) => (b[1].open + b[1].ip) - (a[1].open + a[1].ip))) {
      sections.push(`  • *#${ct.name}*: ${ct.open} open, ${ct.ip} in progress`);
    }
  }

  return sections.join('\n');
}

module.exports = {
  detectTasks, handleReaction,
  formatTaskList, formatProjectReport, formatGlobalSummary,
  REACTION_STATUS_MAP,
};
