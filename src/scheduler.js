const cron = require('node-cron');
const db = require('./database');
const { formatGlobalSummary } = require('./tasks');

/**
 * Start scheduled reports — DMs only, never posted to channels.
 * - Daily summary at 9am weekdays
 * - Weekly digest on Monday at 9am
 */
function startScheduler(app) {
  // All reports go to authorized users via DM only
  const authorizedUsers = (process.env.AUTHORIZED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

  if (authorizedUsers.length === 0) {
    console.log('[scheduler] No AUTHORIZED_USERS set, skipping scheduled reports');
    return;
  }

  async function sendDmReport(text) {
    for (const userId of authorizedUsers) {
      try {
        await app.client.chat.postMessage({
          channel: userId, // DM by user ID
          text,
          mrkdwn: true,
        });
      } catch (e) {
        console.error(`[scheduler] Failed to DM ${userId}:`, e.message);
      }
    }
  }

  // Daily summary at 9am weekdays
  cron.schedule('0 9 * * 1-5', async () => {
    console.log('[scheduler] Sending daily summary via DM...');
    const summary = formatGlobalSummary();
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    await sendDmReport(`:sunrise: *Daily Summary — ${today}*\n\n${summary}`);
  });

  // Weekly digest on Monday at 9am
  cron.schedule('0 9 * * 1', async () => {
    console.log('[scheduler] Sending weekly digest via DM...');
    const channels = db.getAllChannels();
    const sections = [':calendar: *Weekly Project Digest*\n'];

    for (const ch of channels) {
      const summary = db.getProjectSummary(ch.id);
      if (summary.tasks.open.length > 0 || summary.tasks.in_progress.length > 0 || summary.messageCount7d > 0) {
        sections.push(
          `*#${ch.name}* — ${summary.messageCount7d} msgs, ${summary.tasks.open.length} open, ${summary.tasks.in_progress.length} in progress, ${summary.tasks.done.length} done`
        );
      }
    }

    await sendDmReport(sections.join('\n'));
  });

  console.log(`[scheduler] Reports will DM ${authorizedUsers.length} authorized user(s) — daily (9am weekdays), weekly (Mon 9am)`);
}

module.exports = { startScheduler };
