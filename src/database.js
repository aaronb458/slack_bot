const Database = require('better-sqlite3');
const path = require('path');

// Railway mounts persistent volume at /app/data — fallback to local ./data for dev
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'tracker.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    -- Channels (projects)
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_private INTEGER DEFAULT 0,
      topic TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      created_at INTEGER,
      backfilled_at INTEGER DEFAULT NULL
    );

    -- Channel members
    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER,
      PRIMARY KEY (channel_id, user_id),
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );

    -- Users
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      real_name TEXT,
      avatar_url TEXT,
      is_bot INTEGER DEFAULT 0,
      updated_at INTEGER
    );

    -- Messages
    CREATE TABLE IF NOT EXISTS messages (
      ts TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT,
      text TEXT,
      thread_ts TEXT DEFAULT NULL,
      is_thread_parent INTEGER DEFAULT 0,
      reply_count INTEGER DEFAULT 0,
      reactions TEXT DEFAULT '[]',
      created_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (ts, channel_id),
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );

    -- Tasks (extracted from messages)
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      message_ts TEXT NOT NULL,
      thread_ts TEXT,
      assigned_to TEXT,
      created_by TEXT,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      priority TEXT DEFAULT 'normal',
      detected_via TEXT DEFAULT 'keyword',
      created_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );

    -- Activity log for efficiency tracking
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      ts TEXT,
      created_at INTEGER
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_ts);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_activity_channel ON activity_log(channel_id);
    CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id);

    -- Channel analyses (intelligence scan history)
    CREATE TABLE IF NOT EXISTS channel_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      analyzed_at INTEGER NOT NULL,
      priority_score INTEGER,
      sentiment_mood TEXT,
      sentiment_score INTEGER,
      needs_response INTEGER,
      unanswered_count INTEGER,
      response_type TEXT,
      activity_tier TEXT,
      topics TEXT,
      cancelled INTEGER DEFAULT 0,
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );

    CREATE INDEX IF NOT EXISTS idx_analyses_channel ON channel_analyses(channel_id);
    CREATE INDEX IF NOT EXISTS idx_analyses_time ON channel_analyses(analyzed_at);
  `);
}

// --- Channel helpers ---

const upsertChannel = (channel) => {
  getDb().prepare(`
    INSERT INTO channels (id, name, is_private, topic, purpose, created_at)
    VALUES (@id, @name, @is_private, @topic, @purpose, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      name = @name, topic = @topic, purpose = @purpose
  `).run({
    id: channel.id,
    name: channel.name,
    is_private: channel.is_private ? 1 : 0,
    topic: channel.topic?.value || '',
    purpose: channel.purpose?.value || '',
    created_at: channel.created || Math.floor(Date.now() / 1000),
  });
};

const markChannelBackfilled = (channelId) => {
  getDb().prepare(`UPDATE channels SET backfilled_at = ? WHERE id = ?`)
    .run(Math.floor(Date.now() / 1000), channelId);
};

const getChannel = (channelId) => {
  return getDb().prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
};

const getAllChannels = () => {
  return getDb().prepare('SELECT * FROM channels ORDER BY name').all();
};

// --- User helpers ---

const upsertUser = (user) => {
  getDb().prepare(`
    INSERT INTO users (id, display_name, real_name, avatar_url, is_bot, updated_at)
    VALUES (@id, @display_name, @real_name, @avatar_url, @is_bot, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      display_name = @display_name, real_name = @real_name,
      avatar_url = @avatar_url, updated_at = @updated_at
  `).run({
    id: user.id,
    display_name: user.profile?.display_name || user.name || '',
    real_name: user.real_name || user.profile?.real_name || '',
    avatar_url: user.profile?.image_72 || '',
    is_bot: user.is_bot ? 1 : 0,
    updated_at: Math.floor(Date.now() / 1000),
  });
};

const getUser = (userId) => {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
};

// --- Channel member helpers ---

const upsertChannelMember = (channelId, userId) => {
  getDb().prepare(`
    INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at)
    VALUES (?, ?, ?)
  `).run(channelId, userId, Math.floor(Date.now() / 1000));
};

const getChannelMembers = (channelId) => {
  return getDb().prepare(`
    SELECT cm.*, u.display_name, u.real_name
    FROM channel_members cm
    LEFT JOIN users u ON cm.user_id = u.id
    WHERE cm.channel_id = ?
  `).all(channelId);
};

// --- Message helpers ---

const upsertMessage = (msg) => {
  getDb().prepare(`
    INSERT INTO messages (ts, channel_id, user_id, text, thread_ts, is_thread_parent, reply_count, reactions, created_at, updated_at)
    VALUES (@ts, @channel_id, @user_id, @text, @thread_ts, @is_thread_parent, @reply_count, @reactions, @created_at, @updated_at)
    ON CONFLICT(ts, channel_id) DO UPDATE SET
      text = @text, reply_count = @reply_count, reactions = @reactions, updated_at = @updated_at
  `).run({
    ts: msg.ts,
    channel_id: msg.channel_id || msg.channel,
    user_id: msg.user || msg.bot_id || null,
    text: msg.text || '',
    thread_ts: msg.thread_ts || null,
    is_thread_parent: msg.reply_count > 0 ? 1 : 0,
    reply_count: msg.reply_count || 0,
    reactions: JSON.stringify(msg.reactions || []),
    created_at: Math.floor(parseFloat(msg.ts)),
    updated_at: Math.floor(Date.now() / 1000),
  });
};

const getChannelMessages = (channelId, limit = 50) => {
  return getDb().prepare(`
    SELECT m.*, u.display_name, u.real_name
    FROM messages m
    LEFT JOIN users u ON m.user_id = u.id
    WHERE m.channel_id = ? AND m.thread_ts IS NULL
    ORDER BY m.ts DESC LIMIT ?
  `).all(channelId, limit);
};

const getThreadReplies = (channelId, threadTs) => {
  return getDb().prepare(`
    SELECT m.*, u.display_name, u.real_name
    FROM messages m
    LEFT JOIN users u ON m.user_id = u.id
    WHERE m.channel_id = ? AND m.thread_ts = ?
    ORDER BY m.ts ASC
  `).all(channelId, threadTs);
};

// --- Task helpers ---

const createTask = (task) => {
  return getDb().prepare(`
    INSERT INTO tasks (channel_id, message_ts, thread_ts, assigned_to, created_by, title, status, priority, detected_via, created_at)
    VALUES (@channel_id, @message_ts, @thread_ts, @assigned_to, @created_by, @title, @status, @priority, @detected_via, @created_at)
  `).run({
    channel_id: task.channel_id,
    message_ts: task.message_ts,
    thread_ts: task.thread_ts || null,
    assigned_to: task.assigned_to || null,
    created_by: task.created_by || null,
    title: task.title,
    status: task.status || 'open',
    priority: task.priority || 'normal',
    detected_via: task.detected_via || 'keyword',
    created_at: Math.floor(Date.now() / 1000),
  });
};

const updateTaskStatus = (taskId, status) => {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?
  `).run(status, status === 'done' ? now : null, taskId);
};

const getTasksByChannel = (channelId, status = null) => {
  if (status) {
    return getDb().prepare(`
      SELECT t.*, u1.display_name as assigned_name, u2.display_name as creator_name, c.name as channel_name
      FROM tasks t
      LEFT JOIN users u1 ON t.assigned_to = u1.id
      LEFT JOIN users u2 ON t.created_by = u2.id
      LEFT JOIN channels c ON t.channel_id = c.id
      WHERE t.channel_id = ? AND t.status = ?
      ORDER BY t.created_at DESC
    `).all(channelId, status);
  }
  return getDb().prepare(`
    SELECT t.*, u1.display_name as assigned_name, u2.display_name as creator_name, c.name as channel_name
    FROM tasks t
    LEFT JOIN users u1 ON t.assigned_to = u1.id
    LEFT JOIN users u2 ON t.created_by = u2.id
    LEFT JOIN channels c ON t.channel_id = c.id
    WHERE t.channel_id = ?
    ORDER BY t.created_at DESC
  `).all(channelId);
};

const getAllTasks = (status = null) => {
  if (status) {
    return getDb().prepare(`
      SELECT t.*, u1.display_name as assigned_name, u2.display_name as creator_name, c.name as channel_name
      FROM tasks t
      LEFT JOIN users u1 ON t.assigned_to = u1.id
      LEFT JOIN users u2 ON t.created_by = u2.id
      LEFT JOIN channels c ON t.channel_id = c.id
      WHERE t.status = ?
      ORDER BY t.created_at DESC
    `).all(status);
  }
  return getDb().prepare(`
    SELECT t.*, u1.display_name as assigned_name, u2.display_name as creator_name, c.name as channel_name
    FROM tasks t
    LEFT JOIN users u1 ON t.assigned_to = u1.id
    LEFT JOIN users u2 ON t.created_by = u2.id
    LEFT JOIN channels c ON t.channel_id = c.id
    ORDER BY t.created_at DESC
  `).all();
};

const getTasksByUser = (userId, status = null) => {
  if (status) {
    return getDb().prepare(`
      SELECT t.*, c.name as channel_name
      FROM tasks t LEFT JOIN channels c ON t.channel_id = c.id
      WHERE t.assigned_to = ? AND t.status = ?
      ORDER BY t.created_at DESC
    `).all(userId, status);
  }
  return getDb().prepare(`
    SELECT t.*, c.name as channel_name
    FROM tasks t LEFT JOIN channels c ON t.channel_id = c.id
    WHERE t.assigned_to = ?
    ORDER BY t.created_at DESC
  `).all(userId);
};

// --- Activity log helpers ---

const logActivity = (channelId, userId, eventType, ts) => {
  getDb().prepare(`
    INSERT INTO activity_log (channel_id, user_id, event_type, ts, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(channelId, userId, eventType, ts, Math.floor(Date.now() / 1000));
};

const getChannelActivity = (channelId, sinceDays = 7) => {
  const since = Math.floor(Date.now() / 1000) - (sinceDays * 86400);
  return getDb().prepare(`
    SELECT user_id, event_type, COUNT(*) as count
    FROM activity_log
    WHERE channel_id = ? AND created_at > ?
    GROUP BY user_id, event_type
    ORDER BY count DESC
  `).all(channelId, since);
};

const getProjectSummary = (channelId) => {
  const channel = getChannel(channelId);
  const members = getChannelMembers(channelId);
  const openTasks = getTasksByChannel(channelId, 'open');
  const doneTasks = getTasksByChannel(channelId, 'done');
  const inProgressTasks = getTasksByChannel(channelId, 'in_progress');
  const recentMessages = getDb().prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE channel_id = ? AND created_at > ?
  `).get(channelId, Math.floor(Date.now() / 1000) - 7 * 86400);
  const activity = getChannelActivity(channelId, 7);

  return {
    channel,
    members,
    tasks: { open: openTasks, in_progress: inProgressTasks, done: doneTasks },
    messageCount7d: recentMessages?.count || 0,
    activity,
  };
};

// --- Channel analysis helpers ---

const saveChannelAnalysis = (analysis) => {
  getDb().prepare(`
    INSERT INTO channel_analyses (channel_id, analyzed_at, priority_score, sentiment_mood, sentiment_score, needs_response, unanswered_count, response_type, activity_tier, topics, cancelled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    analysis.channel.id,
    Math.floor(Date.now() / 1000),
    analysis.priority_score,
    analysis.sentiment.mood,
    analysis.sentiment.score,
    analysis.needs_response.needs_response ? 1 : 0,
    analysis.needs_response.unanswered_count || 0,
    analysis.needs_response.response_type || 'none',
    analysis.activity.tier,
    JSON.stringify(analysis.topics.topics || []),
    analysis.cancellation.cancelled ? 1 : 0
  );
};

const getChannelAnalysisHistory = (channelId, days = 30) => {
  const since = Math.floor(Date.now() / 1000) - (days * 86400);
  return getDb().prepare(`
    SELECT * FROM channel_analyses
    WHERE channel_id = ? AND analyzed_at > ?
    ORDER BY analyzed_at DESC
  `).all(channelId, since);
};

const getLatestAnalyses = () => {
  return getDb().prepare(`
    SELECT ca.* FROM channel_analyses ca
    INNER JOIN (
      SELECT channel_id, MAX(analyzed_at) as max_at
      FROM channel_analyses
      GROUP BY channel_id
    ) latest ON ca.channel_id = latest.channel_id AND ca.analyzed_at = latest.max_at
    ORDER BY ca.priority_score DESC
  `).all();
};

module.exports = {
  getDb,
  upsertChannel, markChannelBackfilled, getChannel, getAllChannels,
  upsertUser, getUser,
  upsertChannelMember, getChannelMembers,
  upsertMessage, getChannelMessages, getThreadReplies,
  createTask, updateTaskStatus, getTasksByChannel, getAllTasks, getTasksByUser,
  logActivity, getChannelActivity, getProjectSummary,
  saveChannelAnalysis, getChannelAnalysisHistory, getLatestAnalyses,
};
