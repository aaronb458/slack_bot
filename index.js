require('dotenv').config();
const { App, LogLevel } = require('@slack/bolt');
const { registerEvents } = require('./src/events');
const { registerCommands } = require('./src/commands');
const { startScheduler } = require('./src/scheduler');
const { joinAndBackfillAll, syncUsers } = require('./src/backfill');
const { runMorningScan } = require('./src/morning-scan');
const db = require('./src/database');
const { log } = require('./src/utils');

// --- Validate required environment variables ---
const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN'];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`\n  Missing required environment variables:\n    ${missing.join('\n    ')}\n`);
  console.error('  Copy .env.example to .env and fill in your values.\n');
  process.exit(1);
}

// --- Validate AI provider configuration ---
const aiProvider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
if (aiProvider === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
  console.error('\n  AI_PROVIDER is set to "openrouter" but OPENROUTER_API_KEY is missing.');
  console.error('  Get a key at https://openrouter.ai/keys\n');
  process.exit(1);
} else if (aiProvider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
  console.error('\n  AI_PROVIDER is set to "anthropic" but ANTHROPIC_API_KEY is missing.');
  console.error('  Get a key at https://console.anthropic.com/\n');
  process.exit(1);
} else if (aiProvider !== 'openrouter' && aiProvider !== 'anthropic') {
  console.error(`\n  Unknown AI_PROVIDER "${aiProvider}". Must be "openrouter" or "anthropic".\n`);
  process.exit(1);
}

// --- Warn if team user IDs are not configured ---
const teamIds = (process.env.TEAM_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const authIds = (process.env.AUTHORIZED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
if (teamIds.length === 0 && authIds.length === 0) {
  console.warn('\n  ⚠️  WARNING: TEAM_USER_IDS is not set and AUTHORIZED_USERS is empty.');
  console.warn('  The intelligence module will treat ALL users as clients.');
  console.warn('  Set TEAM_USER_IDS in your .env to your team\'s Slack user IDs.\n');
} else if (teamIds.length === 0) {
  console.warn('\n  ⚠️  NOTE: TEAM_USER_IDS is not set — falling back to AUTHORIZED_USERS for team detection.\n');
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.WARN, // reduce Bolt noise — our logger handles the rest
});

// Register all event listeners
registerEvents(app);

// Register all slash commands
registerCommands(app);

// --- Global error handler for Bolt ---
app.error(async (error) => {
  log.error('bolt', `Unhandled error: ${error.message}`);
  if (error.original) {
    log.error('bolt', `Original: ${error.original.message || error.original}`);
  }
});

// --- Process-level crash handlers ---
process.on('unhandledRejection', (reason) => {
  log.error('process', `Unhandled promise rejection: ${reason?.message || reason}`);
});

process.on('uncaughtException', (error) => {
  log.error('process', `Uncaught exception: ${error.message}`);
  log.error('process', error.stack || '');
  // Give the logger a moment to flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

process.on('SIGINT', () => {
  log.info('process', 'Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log.info('process', 'Received SIGTERM, shutting down...');
  process.exit(0);
});

// --- Start ---
(async () => {
  try {
    await app.start();
    log.info('startup', '===========================================');
    log.info('startup', '  Slack Project Tracker Bot is running!');
    log.info('startup', '===========================================');

    // Sync users first so we have names for the backfill logs
    await syncUsers(app.client);

    // Auto-join public channels and backfill history
    await joinAndBackfillAll(app.client);

    // --- Check TEAM_USER_IDS against actual workspace size ---
    const teamIdSet = new Set((process.env.TEAM_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
    const authIdSet = new Set((process.env.AUTHORIZED_USERS || '').split(',').map(s => s.trim()).filter(Boolean));
    const effectiveTeam = teamIdSet.size > 0 ? teamIdSet : authIdSet;
    const totalUsers = db.getDb().prepare('SELECT COUNT(*) as count FROM users WHERE is_bot = 0').get()?.count || 0;

    if (effectiveTeam.size > 0 && totalUsers > effectiveTeam.size + 5) {
      log.warn('startup', '===========================================');
      log.warn('startup', `  ⚠️  TEAM_USER_IDS may be incomplete!`);
      log.warn('startup', `  Your workspace has ${totalUsers} humans but only ${effectiveTeam.size} are marked as "team."`);
      log.warn('startup', `  Everyone else is treated as a CLIENT.`);
      log.warn('startup', `  If your team has more than ${effectiveTeam.size} people,`);
      log.warn('startup', `  add their IDs to TEAM_USER_IDS or the bot will`);
      log.warn('startup', `  flag your own team's messages as client issues.`);
      log.warn('startup', `  Run /team-ids in Slack to see all user IDs.`);
      log.warn('startup', '===========================================');
    }

    // Start scheduled reports
    startScheduler(app);

    // --- Run initial scan so the bot has data immediately ---
    const hasExistingScans = db.getDb().prepare('SELECT COUNT(*) as count FROM channel_analyses').get()?.count || 0;
    if (hasExistingScans === 0) {
      log.info('startup', 'No previous scans found — running initial scan...');
      try {
        const result = await runMorningScan(app);
        if (result.sent) {
          log.info('startup', `Initial scan complete — ${result.needsAttention} channels need attention (DM sent)`);
        } else {
          log.info('startup', 'Initial scan complete (no DM sent — check AUTHORIZED_USERS)');
        }
      } catch (e) {
        log.warn('startup', `Initial scan failed (non-critical): ${e.message}`);
      }
    }

    log.info('startup', 'Bot is fully operational.');
  } catch (error) {
    log.error('startup', `Failed to start: ${error.message}`);
    log.error('startup', error.stack || '');
    process.exit(1);
  }
})();
