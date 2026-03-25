const cron = require('node-cron');
const db = require('./database');
const { runMorningScan } = require('./morning-scan');
const { log } = require('./utils');

/**
 * Start scheduled reports — DMs only, never posted to channels.
 * - Morning scan at 7am PST (14:00 UTC) weekdays — prioritized queue with draft messages
 * - Weekly digest on Monday at 9am
 */
function startScheduler(app) {
  const authorizedUsers = (process.env.AUTHORIZED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

  if (authorizedUsers.length === 0) {
    log.info('scheduler', 'No AUTHORIZED_USERS set, skipping scheduled reports');
    return;
  }

  async function sendDmReport(text) {
    for (const userId of authorizedUsers) {
      try {
        await app.client.chat.postMessage({
          channel: userId,
          text,
          mrkdwn: true,
        });
      } catch (e) {
        log.error('scheduler', `Failed to DM ${userId}: ${e.message}`);
      }
    }
  }

  // Morning scan at 7am Pacific weekdays
  cron.schedule('0 7 * * 1-5', async () => {
    log.info('scheduler', 'Running morning scan...');
    try {
      await runMorningScan(app);
    } catch (e) {
      log.error('scheduler', `Morning scan failed: ${e.message}`);
      await sendDmReport(`:x: *Morning scan failed*\n\n${e.message}`);
    }
  }, { timezone: 'America/Los_Angeles' });

  // Weekly digest on Monday at 9am Pacific
  cron.schedule('0 9 * * 1', async () => {
    log.info('scheduler', 'Sending weekly digest via DM...');
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
  }, { timezone: 'America/Los_Angeles' });

  log.info('scheduler', `Reports will DM ${authorizedUsers.length} user(s) — morning scan (7am PT weekdays), weekly (Mon 9am PT)`);
}

module.exports = { startScheduler };
