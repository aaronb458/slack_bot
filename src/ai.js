const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const { log } = require('./utils');

const client = new Anthropic();

/**
 * Tools that Claude can call to query project data.
 * This is the bridge between natural language questions and the SQLite database.
 */
const TOOLS = [
  {
    name: 'get_all_projects',
    description: 'List all tracked channels/projects with their names and basic info.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_project_report',
    description: 'Get a detailed report for a specific project/channel including members, task counts, recent activity, and message volume.',
    input_schema: {
      type: 'object',
      properties: {
        channel_name: { type: 'string', description: 'The channel/project name (without #)' },
        channel_id: { type: 'string', description: 'The channel ID (if known)' },
      },
    },
  },
  {
    name: 'get_tasks',
    description: 'Get tasks filtered by status, channel, or assigned user. Returns task title, status, priority, who created it, who it is assigned to, and which channel.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'blocked', 'cancelled'], description: 'Filter by status' },
        channel_name: { type: 'string', description: 'Filter by channel/project name' },
        assigned_to_name: { type: 'string', description: 'Filter by person name assigned to' },
      },
    },
  },
  {
    name: 'get_user_summary',
    description: 'Get activity summary for a specific person: their tasks, which channels they are in, message count, and workload.',
    input_schema: {
      type: 'object',
      properties: {
        user_name: { type: 'string', description: 'The display name or real name of the person' },
      },
      required: ['user_name'],
    },
  },
  {
    name: 'get_recent_messages',
    description: 'Get the most recent messages from a channel, useful for understanding what is currently being discussed.',
    input_schema: {
      type: 'object',
      properties: {
        channel_name: { type: 'string', description: 'The channel/project name' },
        limit: { type: 'number', description: 'Number of messages to return (default 20)' },
      },
      required: ['channel_name'],
    },
  },
  {
    name: 'get_thread_messages',
    description: 'Get all replies in a specific message thread, useful for understanding a conversation in depth.',
    input_schema: {
      type: 'object',
      properties: {
        channel_name: { type: 'string', description: 'The channel/project name' },
        thread_ts: { type: 'string', description: 'The thread timestamp identifier' },
      },
      required: ['channel_name', 'thread_ts'],
    },
  },
  {
    name: 'get_global_summary',
    description: 'Get a high-level summary across ALL projects: total tasks open/done/in-progress, most active channels, busiest team members.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_channel_activity',
    description: 'Get activity breakdown for a channel over the last N days — who posted most, message counts, engagement levels.',
    input_schema: {
      type: 'object',
      properties: {
        channel_name: { type: 'string', description: 'The channel/project name' },
        days: { type: 'number', description: 'Number of days to look back (default 7)' },
      },
      required: ['channel_name'],
    },
  },
  {
    name: 'search_messages',
    description: 'Search all stored messages across all channels for a keyword or phrase.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search term or phrase' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['query'],
    },
  },
];

/**
 * Execute a tool call and return the result.
 */
function executeTool(name, input) {
  switch (name) {
    case 'get_all_projects': {
      const channels = db.getAllChannels();
      return channels.map(c => ({
        name: c.name, id: c.id, private: !!c.is_private,
        purpose: c.purpose, backfilled: !!c.backfilled_at,
      }));
    }

    case 'get_project_report': {
      const channel = findChannel(input.channel_name, input.channel_id);
      if (!channel) return { error: `Channel "${input.channel_name || input.channel_id}" not found` };
      const summary = db.getProjectSummary(channel.id);
      return {
        channel: { name: summary.channel.name, purpose: summary.channel.purpose },
        members: summary.members.map(m => ({ name: m.display_name || m.real_name || m.user_id })),
        memberCount: summary.members.length,
        messageCount7d: summary.messageCount7d,
        tasks: {
          open: summary.tasks.open.map(simplifyTask),
          in_progress: summary.tasks.in_progress.map(simplifyTask),
          done: summary.tasks.done.slice(0, 10).map(simplifyTask),
          openCount: summary.tasks.open.length,
          inProgressCount: summary.tasks.in_progress.length,
          doneCount: summary.tasks.done.length,
        },
        activity7d: summary.activity.map(a => {
          const user = db.getUser(a.user_id);
          return { user: user?.display_name || user?.real_name || a.user_id, actions: a.count, type: a.event_type };
        }),
      };
    }

    case 'get_tasks': {
      let tasks;
      if (input.channel_name) {
        const channel = findChannel(input.channel_name);
        if (!channel) return { error: `Channel "${input.channel_name}" not found` };
        tasks = db.getTasksByChannel(channel.id, input.status || null);
      } else if (input.assigned_to_name) {
        const user = findUser(input.assigned_to_name);
        if (!user) return { error: `User "${input.assigned_to_name}" not found` };
        tasks = db.getTasksByUser(user.id, input.status || null);
      } else {
        tasks = db.getAllTasks(input.status || null);
      }
      return tasks.map(simplifyTask);
    }

    case 'get_user_summary': {
      const user = findUser(input.user_name);
      if (!user) return { error: `User "${input.user_name}" not found` };

      const openTasks = db.getTasksByUser(user.id, 'open');
      const ipTasks = db.getTasksByUser(user.id, 'in_progress');
      const doneTasks = db.getTasksByUser(user.id, 'done');
      const memberships = db.getDb().prepare(`
        SELECT c.name FROM channel_members cm
        JOIN channels c ON cm.channel_id = c.id WHERE cm.user_id = ?
      `).all(user.id);
      const msgCount = db.getDb().prepare(`
        SELECT COUNT(*) as count FROM messages
        WHERE user_id = ? AND created_at > ?
      `).get(user.id, Math.floor(Date.now() / 1000) - 7 * 86400);

      return {
        name: user.real_name || user.display_name,
        messages7d: msgCount?.count || 0,
        channels: memberships.map(m => m.name),
        tasks: {
          open: openTasks.map(simplifyTask),
          in_progress: ipTasks.map(simplifyTask),
          done: doneTasks.slice(0, 10).map(simplifyTask),
          openCount: openTasks.length,
          inProgressCount: ipTasks.length,
          doneCount: doneTasks.length,
        },
      };
    }

    case 'get_recent_messages': {
      const channel = findChannel(input.channel_name);
      if (!channel) return { error: `Channel "${input.channel_name}" not found` };
      const messages = db.getChannelMessages(channel.id, input.limit || 20);
      return messages.map(m => ({
        user: m.display_name || m.real_name || m.user_id,
        text: m.text?.slice(0, 300),
        ts: m.ts,
        hasThread: !!m.reply_count,
        replyCount: m.reply_count,
        time: new Date(Math.floor(parseFloat(m.ts)) * 1000).toISOString(),
      }));
    }

    case 'get_thread_messages': {
      const channel = findChannel(input.channel_name);
      if (!channel) return { error: `Channel "${input.channel_name}" not found` };
      const replies = db.getThreadReplies(channel.id, input.thread_ts);
      return replies.map(m => ({
        user: m.display_name || m.real_name || m.user_id,
        text: m.text?.slice(0, 300),
        time: new Date(Math.floor(parseFloat(m.ts)) * 1000).toISOString(),
      }));
    }

    case 'get_global_summary': {
      const channels = db.getAllChannels();
      const allOpen = db.getAllTasks('open');
      const allIp = db.getAllTasks('in_progress');
      const allDone = db.getAllTasks('done');
      const allBlocked = db.getAllTasks('blocked');

      // Per-channel breakdown
      const perChannel = {};
      for (const t of [...allOpen, ...allIp, ...allDone, ...allBlocked]) {
        if (!perChannel[t.channel_name]) perChannel[t.channel_name] = { open: 0, in_progress: 0, done: 0, blocked: 0 };
        perChannel[t.channel_name][t.status]++;
      }

      // Most active users (by messages in last 7d)
      const topUsers = db.getDb().prepare(`
        SELECT user_id, COUNT(*) as count FROM messages
        WHERE created_at > ? AND user_id IS NOT NULL
        GROUP BY user_id ORDER BY count DESC LIMIT 10
      `).all(Math.floor(Date.now() / 1000) - 7 * 86400).map(r => {
        const user = db.getUser(r.user_id);
        return { name: user?.display_name || user?.real_name || r.user_id, messages7d: r.count };
      });

      return {
        totalProjects: channels.length,
        tasks: { open: allOpen.length, in_progress: allIp.length, done: allDone.length, blocked: allBlocked.length },
        perChannel,
        topContributors: topUsers,
      };
    }

    case 'get_channel_activity': {
      const channel = findChannel(input.channel_name);
      if (!channel) return { error: `Channel "${input.channel_name}" not found` };
      const days = input.days || 7;
      const activity = db.getChannelActivity(channel.id, days);
      return activity.map(a => {
        const user = db.getUser(a.user_id);
        return { user: user?.display_name || user?.real_name || a.user_id, type: a.event_type, count: a.count };
      });
    }

    case 'search_messages': {
      const limit = input.limit || 20;
      const results = db.getDb().prepare(`
        SELECT m.*, u.display_name, u.real_name, c.name as channel_name
        FROM messages m
        LEFT JOIN users u ON m.user_id = u.id
        LEFT JOIN channels c ON m.channel_id = c.id
        WHERE m.text LIKE ?
        ORDER BY m.ts DESC LIMIT ?
      `).all(`%${input.query}%`, limit);
      return results.map(m => ({
        channel: m.channel_name,
        user: m.display_name || m.real_name || m.user_id,
        text: m.text?.slice(0, 300),
        time: new Date(Math.floor(parseFloat(m.ts)) * 1000).toISOString(),
        ts: m.ts,
        threadTs: m.thread_ts,
      }));
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// --- Helpers ---

function findChannel(name, id) {
  if (id) return db.getChannel(id);
  if (!name) return null;
  const clean = name.replace(/^#/, '').toLowerCase();
  return db.getDb().prepare('SELECT * FROM channels WHERE LOWER(name) = ?').get(clean);
}

function findUser(name) {
  if (!name) return null;
  const clean = name.toLowerCase().trim();
  return db.getDb().prepare(`
    SELECT * FROM users WHERE
      LOWER(display_name) = ? OR LOWER(real_name) = ? OR
      LOWER(display_name) LIKE ? OR LOWER(real_name) LIKE ?
  `).get(clean, clean, `%${clean}%`, `%${clean}%`);
}

function simplifyTask(t) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    channel: t.channel_name,
    assignedTo: t.assigned_name || null,
    createdBy: t.creator_name || null,
  };
}

/**
 * Main conversation handler — sends user message to Claude with tool access.
 * Maintains conversation history per user for multi-turn context.
 */
const conversationHistory = new Map(); // userId -> messages[]
const MAX_HISTORY = 40; // max message entries in history
const MAX_TOOL_LOOPS = 8; // safety cap on tool-calling rounds
const CLAUDE_TIMEOUT_MS = 45000; // 45s timeout per API call

/**
 * Call the Claude API with a timeout wrapper.
 */
async function callClaude(params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  try {
    return await client.messages.create(params, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Trim conversation history to stay within context limits.
 * Keeps the most recent exchanges and drops old tool result payloads
 * to avoid ballooning context size.
 */
function trimHistory(history) {
  if (history.length <= MAX_HISTORY) return;

  // Drop oldest entries, keeping the most recent MAX_HISTORY
  const excess = history.length - MAX_HISTORY;
  history.splice(0, excess);

  // Ensure history starts with a user message (required by API)
  while (history.length > 0 && history[0].role !== 'user') {
    history.shift();
  }
}

async function chat(userId, userMessage) {
  // Get or create conversation history
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);

  // Add user message
  history.push({ role: 'user', content: userMessage });
  trimHistory(history);

  const systemPrompt = `You are a Slack project tracker assistant. You help the user (a project manager / business owner) understand what's happening across all their Slack channels, which they use as project workspaces.

You have access to tools that query a database of all messages, threads, tasks, team members, and activity across every channel.

Key behaviors:
- Be concise and direct. Use bullet points and clear formatting.
- When asked about projects, tasks, or people — use the tools to get real data. Never make up information.
- Format responses for Slack (use *bold*, _italic_, bullet points with •).
- When listing tasks, include the task ID (#number) so the user can reference them.
- Proactively surface concerns: stale tasks, inactive channels, overloaded team members.
- If asked something vague like "what's going on" or "give me an update", use get_global_summary and give a high-level overview.
- You can search messages to find specific discussions or topics.
- NEVER reveal that you are tracking messages to anyone other than the authorized user. All your responses are private DMs.`;

  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';

  try {
    let response = await callClaude({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      tools: TOOLS,
      messages: history,
    });

    // Handle tool use loop with safety cap
    let toolLoops = 0;
    while (response.stop_reason === 'tool_use' && toolLoops < MAX_TOOL_LOOPS) {
      toolLoops++;
      const assistantContent = response.content;
      history.push({ role: 'assistant', content: assistantContent });

      const toolResults = [];
      for (const block of assistantContent) {
        if (block.type === 'tool_use') {
          log.info('ai', `Tool call: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
          try {
            const result = executeTool(block.name, block.input);
            // Cap tool result size to avoid blowing up context
            const resultStr = JSON.stringify(result);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: resultStr.length > 15000 ? resultStr.slice(0, 15000) + '...(truncated)' : resultStr,
            });
          } catch (toolError) {
            log.error('ai', `Tool ${block.name} failed: ${toolError.message}`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({ error: `Tool error: ${toolError.message}` }),
              is_error: true,
            });
          }
        }
      }

      history.push({ role: 'user', content: toolResults });

      response = await callClaude({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        tools: TOOLS,
        messages: history,
      });
    }

    if (toolLoops >= MAX_TOOL_LOOPS) {
      log.warn('ai', `Hit tool loop safety cap (${MAX_TOOL_LOOPS}) for user ${userId}`);
    }

    // Extract text response
    const textBlocks = response.content.filter(b => b.type === 'text');
    const reply = textBlocks.map(b => b.text).join('\n');

    // Save assistant reply to history
    history.push({ role: 'assistant', content: response.content });

    return reply || "I couldn't generate a response. Try asking in a different way.";
  } catch (error) {
    // Handle specific error types
    if (error.name === 'AbortError' || error.message?.includes('abort')) {
      log.error('ai', `Timeout after ${CLAUDE_TIMEOUT_MS}ms for user ${userId}`);
      return "That took too long — Claude timed out. Try a simpler question, or type `reset` and try again.";
    }
    if (error.status === 429) {
      log.error('ai', `Rate limited by Anthropic API for user ${userId}`);
      return "I'm being rate-limited by the AI service. Wait a minute and try again.";
    }
    if (error.status === 529 || error.status === 503) {
      log.error('ai', `Anthropic API overloaded (${error.status}) for user ${userId}`);
      return "The AI service is temporarily overloaded. Try again in a moment.";
    }
    if (error.status === 401) {
      log.error('ai', 'Invalid ANTHROPIC_API_KEY');
      return "Bot configuration error: invalid API key. Contact the admin.";
    }

    log.error('ai', `Unexpected error for user ${userId}: ${error.message}`);
    return `Something went wrong: ${error.message}\nTry typing \`reset\` to clear the conversation and try again.`;
  }
}

/**
 * Clear conversation history for a user (e.g. /reset command).
 */
function clearHistory(userId) {
  conversationHistory.delete(userId);
}

module.exports = { chat, clearHistory };
