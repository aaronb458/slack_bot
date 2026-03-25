'use strict';

// morning-scan.js
// Orchestrates the morning channel scan: analyzes all channels,
// drafts messages for those needing attention, and delivers
// a prioritized queue via Slack DM.

const { analyzeAllChannels } = require('./intelligence');
const { draftBatch, isDraftingEnabled } = require('./drafter');
const { log } = require('./utils');

/**
 * Escape special characters for Slack mrkdwn.
 */
function escapeSlackText(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let scanInProgress = false;

// ============================================================================
// Run Morning Scan
// ============================================================================

/**
 * Run the full morning scan and DM results to authorized users.
 *
 * @param {object} app - Slack Bolt app instance
 * @returns {{ sent: boolean, channelsScanned: number, needsAttention: number }}
 */
async function runMorningScan(app) {
  const authorizedUsers = (process.env.AUTHORIZED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

  if (authorizedUsers.length === 0) {
    log.warn('scan', 'No AUTHORIZED_USERS set, skipping morning scan');
    return { sent: false, channelsScanned: 0, needsAttention: 0 };
  }

  if (scanInProgress) {
    log.warn('scan', 'Scan already in progress, skipping');
    return { sent: false, channelsScanned: 0, needsAttention: 0 };
  }
  scanInProgress = true;

  try {
    log.info('scan', 'Starting morning scan...');
    const startTime = Date.now();

    // 1. Analyze all channels
    const analyses = analyzeAllChannels({
      minMessages: 5,
      activeOnly: true,
      activeDays: 30,
    });

    log.info('scan', `Analyzed ${analyses.length} active channels`);

    // 2. Draft messages for channels needing attention
    const drafts = draftBatch(analyses);

    log.info('scan', `Drafted ${drafts.length} messages for channels needing response`);

    // 3. Build stats
    const stats = {
      total_channels: analyses.length,
      needs_attention: drafts.length,
      cancelled: analyses.filter(a => a.cancellation?.cancelled).length,
      frustrated: analyses.filter(a => a.sentiment?.mood === 'frustrated').length,
      no_response_needed: analyses.filter(a => !a.needs_response?.needs_response).length,
    };

    // 4. Format the queue
    const report = formatQueueForSlack(drafts, stats);

    // 5. DM to authorized users
    for (const userId of authorizedUsers) {
      try {
        // Split if needed (Slack 4000 char limit)
        const chunks = splitMessage(report, 3900);
        for (const chunk of chunks) {
          await app.client.chat.postMessage({
            channel: userId,
            text: chunk,
            mrkdwn: true,
          });
        }
      } catch (e) {
        log.error('scan', `Failed to DM scan to ${userId}: ${e.message}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.info('scan', `Morning scan complete in ${elapsed}s — ${drafts.length} channels need attention`);

    return {
      sent: true,
      channelsScanned: analyses.length,
      needsAttention: drafts.length,
    };
  } finally {
    scanInProgress = false;
  }
}

// ============================================================================
// Format Queue for Slack
// ============================================================================

/**
 * Format the prioritized queue as a Slack mrkdwn message.
 *
 * @param {Array} drafts - Output from draftBatch()
 * @param {object} stats - Scan stats
 * @returns {string} Slack mrkdwn formatted message
 */
function formatQueueForSlack(drafts, stats) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

  const respondNow = drafts.filter(d => d.priority_score >= 70);
  const respondToday = drafts.filter(d => d.priority_score >= 40 && d.priority_score < 70);
  const lowPriority = drafts.filter(d => d.priority_score >= 20 && d.priority_score < 40);

  const lines = [];

  // Header
  lines.push(`:sunrise: *Morning Queue — ${today}*`);
  lines.push('');
  lines.push(`*${stats.needs_attention} channels need your attention* (out of ${stats.total_channels} active)`);
  if (stats.frustrated > 0) {
    lines.push(`:warning: ${stats.frustrated} frustrated client(s)`);
  }
  if (!isDraftingEnabled()) {
    lines.push('_Draft messages are disabled. Set DRAFTS_ENABLED=true to enable._');
  }
  lines.push('');

  // RESPOND NOW
  lines.push(`:red_circle: *RESPOND NOW* (${respondNow.length})`);
  lines.push('_Priority 70+, these need immediate attention._');
  lines.push('');

  if (respondNow.length === 0) {
    lines.push('_No urgent responses needed :tada:_');
    lines.push('');
  } else {
    for (let i = 0; i < respondNow.length; i++) {
      formatEntry(lines, respondNow[i], i + 1);
    }
  }

  // RESPOND TODAY
  lines.push(`:large_yellow_circle: *RESPOND TODAY* (${respondToday.length})`);
  lines.push('_Priority 40-69, should handle today._');
  lines.push('');

  if (respondToday.length === 0) {
    lines.push('_Nothing in this tier today._');
    lines.push('');
  } else {
    for (let i = 0; i < respondToday.length; i++) {
      formatEntry(lines, respondToday[i], i + 1);
    }
  }

  // LOW PRIORITY
  if (lowPriority.length > 0) {
    lines.push(`:large_green_circle: *LOW PRIORITY* (${lowPriority.length})`);
    lines.push('_Priority 20-39, can wait if needed._');
    lines.push('');
    for (let i = 0; i < lowPriority.length; i++) {
      formatEntry(lines, lowPriority[i], i + 1);
    }
  }

  // Summary footer
  lines.push('---');
  lines.push(`_Scanned ${stats.total_channels} channels | ${stats.cancelled} cancelled | ${stats.no_response_needed} no response needed_`);

  return lines.join('\n');
}

/**
 * Format a single channel entry for the Slack queue.
 */
function formatEntry(lines, d, num) {
  const channelName = d.channel?.name || 'unknown';

  lines.push(`*${num}. #${channelName}* (Priority: ${d.priority_score})`);
  lines.push(`_Why:_ ${d.priority_reason || 'Needs response'}`);
  if (d.situation) lines.push(`_Situation:_ ${d.situation}`);

  // Show last client message if available
  const lastMsg = d.note?.match(/"([^"]+)"/);
  if (lastMsg) {
    lines.push(`_Last msg:_ "${escapeSlackText(lastMsg[1])}"`);
  }

  // Only show draft if drafting is enabled and a draft was generated
  if (d.draft) {
    lines.push('');
    lines.push('*Draft message:*');
    const draftText = escapeSlackText(d.draft);
    lines.push(`> ${draftText.length > 500 ? draftText.slice(0, 500) + '...' : draftText}`);
    lines.push(`_${d.confidence} confidence | ${d.style || 'casual'} style_`);
  }

  lines.push('');
}

// ============================================================================
// Helpers
// ============================================================================

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) {
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

module.exports = {
  runMorningScan,
  formatQueueForSlack,
};
