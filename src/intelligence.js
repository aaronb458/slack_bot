'use strict';

// intelligence.js
// Channel intelligence module — ported from ClickUp assistant's content-analysis.js
// and channel-profiles.js, adapted for Slack's SQLite message store.
//
// Analyzes channel messages for: sentiment, needs-response detection,
// activity tier, topics, cancellation signals, and priority scoring.

const db = require('./database');
const { log } = require('./utils');

// ============================================================================
// Team Member Identification
// ============================================================================

/**
 * Get the set of team member Slack user IDs.
 * Uses TEAM_USER_IDS env var if set, otherwise falls back to AUTHORIZED_USERS.
 */
function getTeamUserIds() {
  const teamIds = process.env.TEAM_USER_IDS || process.env.AUTHORIZED_USERS || '';
  return new Set(teamIds.split(',').map(s => s.trim()).filter(Boolean));
}

// ============================================================================
// Helpers
// ============================================================================

function matchesAny(text, patterns) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const pattern of patterns) {
    if (lower.includes(pattern.toLowerCase())) return pattern;
  }
  return null;
}

// ============================================================================
// 1. Cancellation Detection
// ============================================================================

const CANCELLATION_PATTERNS = [
  'cancel service', 'cancel their service', 'cancel the service',
  'cancel account', 'cancel their account', 'cancel the account',
  'cancelling service', 'cancelling their service', 'cancelling account',
  'canceling service', 'canceling their service', 'canceling account',
  'cancelled their service', 'cancelled the service', 'cancelled their account',
  'canceled their service', 'canceled the service', 'canceled their account',
  'service has been cancelled', 'service has been canceled',
  'account has been cancelled', 'account has been canceled',
  'cancellation request', 'requested cancellation',
  'offboarding', 'off-boarding', 'off boarding',
  'no longer a client', 'no longer our client',
  'no longer working with us', 'parting ways',
  'ending service', 'end of service',
  'discontinuing service', 'account has been closed',
  'account closure', 'close the account', 'closing the account',
  'end the contract', 'ending the contract', 'contract ended',
  'terminating service', 'termination of service',
  'will be leaving us', 'is leaving us', 'has left us',
  'decided to leave', 'final invoice', 'final billing',
];

function detectCancellation(messages, teamUserIds) {
  if (!messages || messages.length === 0) {
    return { cancelled: false, date: null, message: null, detected_by: null };
  }

  // Scan newest-first, only look at team messages
  const sorted = [...messages].sort((a, b) => b.timestamp - a.timestamp);

  for (const msg of sorted) {
    if (!teamUserIds.has(msg.user_id)) continue;
    if (!msg.text) continue;

    const matched = matchesAny(msg.text, CANCELLATION_PATTERNS);
    if (matched) {
      return {
        cancelled: true,
        date: new Date(msg.timestamp).toISOString().split('T')[0],
        message: msg.text.length > 300 ? msg.text.substring(0, 300) + '...' : msg.text,
        detected_by: matched,
      };
    }
  }

  return { cancelled: false, date: null, message: null, detected_by: null };
}

// ============================================================================
// 2. Sentiment Analysis
// ============================================================================

const FRUSTRATED_PATTERNS = [
  'frustrated', 'frustrating', 'disappointing', 'disappointed',
  'still waiting', 'been waiting', "haven't heard", 'havent heard',
  'no one has', 'nobody has responded', 'nobody has replied',
  'no one responded', 'no one replied', 'not working',
  "doesn't work", 'doesnt work', "don't work", 'broken',
  'having issues', 'there is an issue', 'this issue', 'the issue',
  'having a problem', 'there is a problem', 'the problem',
  'when will', 'how long', 'how much longer',
  'unacceptable', 'ridiculous', 'terrible', 'awful', 'waste of',
  'not happy', 'unhappy', 'concerned', 'upset',
  'where is', 'where are', 'still no', 'still nothing',
  'never received', 'never got', 'dropped the ball',
  'falling behind', 'behind schedule', 'overdue',
  'running late', 'always late', 'too late',
];

const HAPPY_PATTERNS = [
  'thank you', 'thanks so much', 'appreciate',
  'great work', 'great job', 'awesome', 'amazing',
  'love it', 'looks great', 'perfect', 'excellent',
  'happy with', 'pleased with', 'well done',
  'fantastic', 'wonderful', 'impressive', 'beautiful',
  'exactly what', 'nailed it', 'spot on', 'blown away',
  'thrilled', 'exceeded', 'beyond expectations',
  'outstanding', 'superb', 'incredible',
  'you guys rock', 'you guys are great', 'you guys are awesome',
  'best decision', 'so glad', 'really happy', 'really pleased',
];

function analyzeSentiment(messages, teamUserIds, lastN = 10) {
  if (!messages || messages.length === 0) {
    return { mood: 'unknown', score: 0, reasons: [] };
  }

  // Only client messages, newest first, take last N
  const clientMessages = messages
    .filter(m => !teamUserIds.has(m.user_id) && m.text)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, lastN);

  if (clientMessages.length === 0) {
    return { mood: 'unknown', score: 0, reasons: [] };
  }

  let score = 0;
  const reasons = [];

  for (const msg of clientMessages) {
    const text = msg.text;

    // Check happy patterns FIRST — if the message is positive,
    // punctuation (!! / ??? / ALL CAPS) is emphasis, not frustration
    const happyMatch = matchesAny(text, HAPPY_PATTERNS);
    if (happyMatch) {
      score += 10;
      reasons.push(`happy:"${happyMatch}"`);
    }

    const frustratedMatch = matchesAny(text, FRUSTRATED_PATTERNS);
    if (frustratedMatch) {
      score -= 15;
      reasons.push(`frustrated:"${frustratedMatch}"`);
    }

    // Only apply punctuation-based penalties when the message
    // did NOT match a happy pattern — otherwise the punctuation
    // is just enthusiastic emphasis on something positive
    if (!happyMatch) {
      // Multiple question marks (3+)
      if ((text.match(/\?/g) || []).length >= 3) {
        score -= 10;
        reasons.push('excessive_questions');
      }

      // ALL CAPS shouting
      if (/\b[A-Z]{2,}(?:\s+[A-Z]{2,}){4,}\b/.test(text)) {
        score -= 12;
        reasons.push('all_caps_shouting');
      }

      if (/!!/.test(text)) score -= 5;
      if (/\?\?\?/.test(text)) score -= 8;
    }
  }

  score = Math.max(-100, Math.min(100, score));

  let mood = 'neutral';
  if (score <= -15) mood = 'frustrated';
  else if (score >= 10) mood = 'happy';

  return { mood, score, reasons };
}

// ============================================================================
// 3. Needs Response Detection
// ============================================================================

const ACKNOWLEDGMENT_PATTERNS = [
  'sounds good', 'got it', 'okay', 'ok', 'thanks', 'thank you',
  'will do', 'understood', 'perfect', 'great', 'cool', 'noted',
  'appreciate it', 'works for me', 'all good', 'no worries',
  'no problem', 'sure thing', 'roger that', 'copy that',
];

const REQUEST_STARTERS = [
  'can you', 'could you', 'will you', 'would you', 'please ',
  'can we', 'could we', 'would it be possible', 'is it possible',
  'i need', 'we need', 'i want', 'we want',
];

function detectNeedsResponse(messages, teamUserIds) {
  const defaultResult = {
    needs_response: false,
    response_type: 'none',
    urgency_boost: 0,
    reason: '',
    unanswered_count: 0,
    last_client_message: null,
  };

  if (!messages || messages.length === 0) return defaultResult;

  // Sort oldest-first
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length === 0) return defaultResult;

  const lastMsg = sorted[sorted.length - 1];

  // If last message is from team, no response needed
  if (teamUserIds.has(lastMsg.user_id)) {
    return { ...defaultResult, reason: 'Last message is from team' };
  }

  const lastText = lastMsg.text || '';

  // Check if it's purely an acknowledgment
  const normalized = lastText.toLowerCase().replace(/[.!,]/g, '').trim();
  const isAcknowledgment = ACKNOWLEDGMENT_PATTERNS.some(p =>
    normalized === p || normalized === p + '!' || normalized === p + '.'
  );
  if (isAcknowledgment && !lastText.includes('?')) {
    return { ...defaultResult, reason: 'Acknowledgment only', last_client_message: lastMsg };
  }

  // Count consecutive unanswered client messages
  let unansweredCount = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (teamUserIds.has(sorted[i].user_id)) break;
    unansweredCount++;
  }

  // Check for team @mentions in recent unanswered messages
  let mentionedTeam = false;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (teamUserIds.has(sorted[i].user_id)) break;
    const text = sorted[i].text || '';
    // Slack @mentions look like <@U12345>
    const mentions = text.match(/<@(\w+)>/g) || [];
    for (const mention of mentions) {
      const uid = mention.replace(/<@|>/g, '');
      if (teamUserIds.has(uid)) { mentionedTeam = true; break; }
    }
    if (mentionedTeam) break;
  }

  let responseType = 'none';
  let urgencyBoost = 0;
  let reason = '';

  // Priority 1: Stacked unanswered
  if (unansweredCount >= 2) {
    responseType = 'stacked_unanswered';
    urgencyBoost = Math.min(unansweredCount * 5, 25);
    reason = `${unansweredCount} consecutive client messages with no team response`;
  }

  // Priority 2: Team @mention
  if (mentionedTeam) {
    if (responseType === 'stacked_unanswered') {
      reason += '; team member @mentioned';
      urgencyBoost += 10;
    } else {
      responseType = 'mention';
      urgencyBoost = 10;
      reason = 'Client @mentioned a team member with no reply';
    }
  }

  // Priority 3: Question
  if (lastText.includes('?')) {
    if (responseType === 'none') {
      responseType = 'question';
      urgencyBoost = 5;
      reason = `Client asked a question: "${lastText.substring(0, 80)}"`;
    } else {
      reason += '; contains question';
      urgencyBoost += 3;
    }
  }

  // Priority 4: Request
  const requestMatch = matchesAny(lastText, REQUEST_STARTERS);
  if (requestMatch) {
    if (responseType === 'none') {
      responseType = 'request';
      urgencyBoost = 5;
      reason = `Client made a request: "${lastText.substring(0, 80)}"`;
    } else if (responseType === 'question') {
      urgencyBoost += 2;
      reason += '; also a request';
    }
  }

  return {
    needs_response: responseType !== 'none',
    response_type: responseType,
    urgency_boost: urgencyBoost,
    reason,
    unanswered_count: unansweredCount,
    last_client_message: lastMsg,
  };
}

// ============================================================================
// 4. Activity Tier Calculation
// ============================================================================

function calculateActivityTier(messages, teamUserIds, lookbackDays = 30) {
  if (!messages || messages.length === 0) {
    return { tier: 'chill', messages_per_week: 0, total_client_messages: 0 };
  }

  const cutoff = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
  const clientMessages = messages.filter(m =>
    !teamUserIds.has(m.user_id) && m.text && m.timestamp >= cutoff
  );

  const weeks = Math.max(lookbackDays / 7, 1);
  const messagesPerWeek = +(clientMessages.length / weeks).toFixed(2);

  let tier = 'chill';
  if (messagesPerWeek >= 10) tier = 'super_active';
  else if (messagesPerWeek >= 3) tier = 'active';

  return { tier, messages_per_week: messagesPerWeek, total_client_messages: clientMessages.length };
}

// ============================================================================
// 5. Topic Extraction
// ============================================================================

const TOPIC_KEYWORDS = {
  website: ['website', 'site', 'web page', 'webpage', 'homepage'],
  landing_page: ['landing page', 'lp', 'lead page', 'opt-in page', 'squeeze page'],
  ads: ['ads', 'ad campaign', 'facebook ads', 'meta ads', 'google ads', 'paid ads', 'ad spend', 'ad copy'],
  funnel: ['funnel', 'funnels', 'sales funnel', 'lead funnel'],
  email: ['email', 'emails', 'email sequence', 'email campaign', 'newsletter', 'drip'],
  automation: ['automation', 'automations', 'workflow', 'workflows', 'zap', 'zapier'],
  seo: ['seo', 'search engine', 'google ranking', 'organic traffic', 'keywords'],
  content: ['content', 'blog', 'blog post', 'article', 'copy', 'copywriting'],
  design: ['design', 'redesign', 'layout', 'ui', 'ux', 'mockup', 'wireframe', 'branding'],
  social_media: ['social media', 'instagram', 'facebook', 'tiktok', 'linkedin', 'social post'],
  crm: ['crm', 'ghl', 'gohighlevel', 'highlevel', 'pipeline'],
  bug: ['bug', 'error', 'broken', 'slow', 'not working', 'missing', 'glitch'],
  meeting: ['call', 'zoom', 'meeting', 'schedule', 'calendar', 'sync up', 'check in'],
  payment: ['payment', 'invoice', 'billing', 'charge', 'subscription'],
  onboarding: ['onboarding', 'getting started', 'kickoff', 'setup', 'set up'],
  reporting: ['report', 'reporting', 'analytics', 'metrics', 'dashboard', 'results'],
};

function extractTopics(messages, lastN = 15) {
  if (!messages || messages.length === 0) {
    return { topics: [], primary_topic: null };
  }

  const recent = [...messages]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, lastN);

  const topicCounts = {};

  for (const msg of recent) {
    if (!msg.text) continue;
    const lower = msg.text.toLowerCase();

    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      for (const keyword of keywords) {
        if (lower.includes(keyword)) {
          topicCounts[topic] = (topicCounts[topic] || 0) + 1;
          break;
        }
      }
    }
  }

  const sortedTopics = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([topic]) => topic);

  return {
    topics: sortedTopics,
    primary_topic: sortedTopics[0] || null,
  };
}

// ============================================================================
// 6. Trend Boost (historical analysis)
// ============================================================================

/**
 * Compute a priority boost based on historical trend data from channel_analyses.
 *
 * @param {string} channelId - Slack channel ID
 * @returns {{ boost: number, signals: string[] }}
 */
function computeTrendBoost(channelId) {
  if (!channelId) return { boost: 0, signals: [] };

  let history;
  try {
    history = db.getChannelAnalysisHistory(channelId, 14); // last 2 weeks, newest first
  } catch (err) {
    log.warn('intelligence', `Trend boost DB error for ${channelId}: ${err.message}`);
    return { boost: 0, signals: [] };
  }

  if (!history || history.length < 2) return { boost: 0, signals: [] };

  let boost = 0;
  const signals = [];

  // --- Chronic frustration: 3+ of last 5 snapshots show frustrated ---
  const last5 = history.slice(0, 5);
  const frustratedCount = last5.filter(h => h.sentiment_mood === 'frustrated').length;
  if (frustratedCount >= 3) {
    boost += 15;
    signals.push(`Chronically frustrated (${frustratedCount} of last ${last5.length} scans)`);
  }

  // --- Chronic unanswered: 3+ of last 5 snapshots need response ---
  const unansweredCount = last5.filter(h => h.needs_response === 1).length;
  if (unansweredCount >= 3) {
    boost += 10;
    signals.push('Repeatedly needs response');
  }

  // --- Trending worse / better: compare recent 3 vs previous 3 ---
  if (history.length >= 6) {
    const recent3 = history.slice(0, 3);
    const previous3 = history.slice(3, 6);
    const avgRecent = recent3.reduce((s, h) => s + (h.priority_score || 0), 0) / recent3.length;
    const avgPrevious = previous3.reduce((s, h) => s + (h.priority_score || 0), 0) / previous3.length;
    const delta = avgRecent - avgPrevious;

    if (delta >= 15) {
      boost += 10;
      signals.push('Priority trending upward');
    } else if (delta <= -15) {
      boost -= 5;
      signals.push('Improving');
    }
  }

  // --- Long-standing issue: ALL snapshots in last 7 days need response ---
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 86400);
  const last7d = history.filter(h => h.analyzed_at > sevenDaysAgo);
  if (last7d.length >= 2 && last7d.every(h => h.needs_response === 1)) {
    boost += 20;
    signals.push('Unanswered for 7+ days');
  }

  return { boost, signals };
}

// ============================================================================
// 7. Priority Score Calculation
// ============================================================================

function computePriority(analysis) {
  let score = 20; // Base: informational

  if (analysis.needs_response.needs_response) {
    const lastClientMsg = analysis.needs_response.last_client_message;
    if (lastClientMsg && lastClientMsg.timestamp) {
      const daysSince = (Date.now() - lastClientMsg.timestamp) / (1000 * 60 * 60 * 24);
      if (daysSince >= 3) score += 60;
      else if (daysSince >= 1) score += 40;
      else score += 20;
    } else {
      score += 20;
    }
  }

  if (analysis.sentiment.mood === 'frustrated') score += 20;
  if (analysis.needs_response.unanswered_count >= 3) score += 15;
  if (analysis.activity.tier === 'super_active') score += 10;
  if (analysis.cancellation.cancelled) score -= 100;
  if (!analysis.needs_response.needs_response) score -= 20;
  if (analysis.activity.tier === 'chill') score -= 10;

  // Historical trend boost
  let trend = { boost: 0, signals: [] };
  try {
    trend = computeTrendBoost(analysis.channel?.id);
  } catch (err) {
    log.warn('intelligence', `Trend boost failed for ${analysis.channel?.id}: ${err.message}`);
  }
  score += trend.boost;
  analysis.trend = trend;

  return Math.max(0, Math.min(100, score));
}

function buildPriorityReason(analysis) {
  const reasons = [];

  if (analysis.cancellation.cancelled) {
    reasons.push('Cancellation detected');
  }

  if (analysis.needs_response.needs_response) {
    const lastClientMsg = analysis.needs_response.last_client_message;
    if (lastClientMsg && lastClientMsg.timestamp) {
      const daysSince = (Date.now() - lastClientMsg.timestamp) / (1000 * 60 * 60 * 24);
      if (daysSince >= 3) reasons.push(`Client waiting ${daysSince.toFixed(1)}d (critical)`);
      else if (daysSince >= 1) reasons.push(`Client waiting ${daysSince.toFixed(1)}d`);
      else reasons.push('Recent client message needs response');
    }
  }

  if (analysis.needs_response.unanswered_count >= 3) {
    reasons.push(`${analysis.needs_response.unanswered_count} stacked unanswered messages`);
  }

  if (analysis.sentiment.mood === 'frustrated') {
    reasons.push('Client frustrated');
  }

  if (analysis.activity.tier === 'super_active') {
    reasons.push('Super active channel');
  }

  if (!analysis.needs_response.needs_response && !analysis.cancellation.cancelled) {
    reasons.push('No response needed');
  }

  // Append historical trend signals
  if (analysis.trend?.signals?.length > 0) {
    reasons.push(...analysis.trend.signals);
  }

  return reasons.join('; ') || 'Informational';
}

// ============================================================================
// 8. Master Channel Analysis
// ============================================================================

/**
 * Analyze a single channel's messages from the database.
 *
 * @param {string} channelId - Slack channel ID
 * @param {Set<string>} [teamUserIds] - Override team user IDs (defaults to env)
 * @returns {object} Full analysis: { channel, sentiment, needs_response, activity, topics, cancellation, priority_score, priority_reason }
 */
function analyzeChannel(channelId, teamUserIds) {
  const teamIds = teamUserIds || getTeamUserIds();
  const channel = db.getChannel(channelId);

  // Get last 200 messages (including threads for context)
  const rawMessages = db.getDb().prepare(`
    SELECT m.ts, m.channel_id, m.user_id, m.text, m.created_at,
           u.display_name, u.real_name, u.is_bot
    FROM messages m
    LEFT JOIN users u ON m.user_id = u.id
    WHERE m.channel_id = ?
          AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
    ORDER BY m.ts DESC
    LIMIT 200
  `).all(channelId);

  // Map to analysis-friendly format
  const messages = rawMessages
    .filter(m => m.is_bot === 0 && m.user_id) // Exclude bots (incl. NULL is_bot) and NULL user_ids
    .map(m => ({
      user_id: m.user_id || '',
      text: m.text || '',
      timestamp: (m.created_at || 0) * 1000, // Convert to ms
      sender_name: m.display_name || m.real_name || '',
      ts: m.ts,
    }));

  const cancellation = detectCancellation(messages, teamIds);
  const sentiment = analyzeSentiment(messages, teamIds);
  const needsResponse = detectNeedsResponse(messages, teamIds);
  const activity = calculateActivityTier(messages, teamIds);
  const topics = extractTopics(messages);

  const analysis = {
    channel: {
      id: channelId,
      name: channel?.name || channelId,
    },
    cancellation,
    sentiment,
    needs_response: needsResponse,
    activity,
    topics,
  };

  analysis.priority_score = computePriority(analysis);
  analysis.priority_reason = buildPriorityReason(analysis);

  // Persist analysis for historical tracking
  try {
    db.saveChannelAnalysis(analysis);
  } catch (e) {
    log.warn('intelligence', `Failed to persist analysis for ${channelId}: ${e.message}`);
  }

  return analysis;
}

/**
 * Analyze all tracked channels and return results sorted by priority.
 *
 * @param {object} [options]
 * @param {number} [options.minMessages=5] - Skip channels with fewer messages
 * @param {boolean} [options.activeOnly=true] - Only scan channels with recent activity
 * @param {number} [options.activeDays=30] - Recency window for "active"
 * @returns {Array} Array of analysis results sorted by priority_score descending
 */
function analyzeAllChannels(options = {}) {
  const { minMessages = 5, activeOnly = true, activeDays = 30, excludeChannels } = options;
  const defaultExclude = ['general', 'random'];
  const excludeSet = new Set(excludeChannels || (process.env.EXCLUDE_CHANNELS ? process.env.EXCLUDE_CHANNELS.split(',').map(s => s.trim()) : defaultExclude));
  const teamIds = getTeamUserIds();
  const channels = db.getAllChannels();
  const results = [];

  const activeCutoff = Math.floor(Date.now() / 1000) - (activeDays * 86400);

  for (const channel of channels) {
    try {
      // Skip excluded channels
      if (excludeSet.has(channel.name)) continue;

      // Skip channels with too few messages or no recent activity
      const channelStats = db.getDb().prepare(
        'SELECT COUNT(*) as count, MAX(created_at) as latest FROM messages WHERE channel_id = ?'
      ).get(channel.id);
      if ((channelStats?.count || 0) < minMessages) continue;
      if (activeOnly && (!channelStats?.latest || channelStats.latest < activeCutoff)) continue;

      const analysis = analyzeChannel(channel.id, teamIds);
      results.push(analysis);
    } catch (err) {
      log.error('intelligence', `Failed to analyze channel ${channel.name || channel.id}: ${err.message}`);
    }
  }

  results.sort((a, b) => b.priority_score - a.priority_score);
  return results;
}

module.exports = {
  analyzeChannel,
  analyzeAllChannels,
  getTeamUserIds,
  // Expose individual analyzers for testing/AI tools
  analyzeSentiment,
  detectNeedsResponse,
  calculateActivityTier,
  extractTopics,
  detectCancellation,
  computePriority,
};
