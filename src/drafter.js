'use strict';

// drafter.js
// Generates draft messages for channels that need a response.
// Supports multiple tone styles via DRAFT_STYLE env var.
// Can be disabled entirely via DRAFTS_ENABLED=false.
// Now includes AI-powered draft generation with template fallback.

const { getProvider, resolveModel } = require('./ai-provider');
const db = require('./database');
const { log } = require('./utils');

const DRAFT_AI_TIMEOUT_MS = 15000; // 15 seconds — drafts should be fast

// ============================================================================
// Configuration
// ============================================================================

/**
 * Check if drafting is enabled.
 * Set DRAFTS_ENABLED=false in .env to disable draft message generation.
 */
function isDraftingEnabled() {
  const val = (process.env.DRAFTS_ENABLED || 'true').toLowerCase().trim();
  return val !== 'false' && val !== '0' && val !== 'no';
}

/**
 * Get the active draft style.
 * Options: casual (default), professional, friendly
 */
function getDraftStyle() {
  const style = (process.env.DRAFT_STYLE || 'casual').toLowerCase().trim();
  if (STYLES[style]) return style;
  return 'casual';
}

// ============================================================================
// Helpers
// ============================================================================

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function firstName(fullName) {
  if (!fullName) return 'there';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length > 1 && /^dr\.?$/i.test(parts[0])) return parts[1];
  return parts[0];
}

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen).trimEnd() + '...';
}

function getCurrentDay() {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[new Date().getDay()];
}

// ============================================================================
// Style Definitions
// ============================================================================

const STYLES = {
  // Warm, casual-professional. "Hey {name}" greeting, "Happy [Day]!" sign-off.
  casual: {
    greeting: (name) => `Hey ${name}`,
    signoff: () => {
      const day = getCurrentDay();
      if (day === 'Friday') {
        return pick(['Happy Friday!', 'Happy happy Friday!', 'Have an awesome weekend!']);
      }
      return Math.random() < 0.4 ? `Happy happy ${day}!` : `Happy ${day}!`;
    },
    templates: {
      direct_question: [
        '{greeting}, great question, let me check in with the team on {topic} and get you an update. I\'ll have something for you by end of day. {signoff}',
        '{greeting}, thanks for reaching out on this! I\'m going to get with the team about {topic} and circle back to you shortly. {signoff}',
        '{greeting}, appreciate you flagging this! Let me dig into {topic} and I\'ll get back to you with an answer today. {signoff}',
      ],
      stacked_unanswered: [
        '{greeting}, appreciate your patience here. I see your messages and I want to make sure we get this handled. I\'m looking into {topic} right now and will get back to you shortly. {signoff}',
        '{greeting}, no worries on the follow-ups, I\'m glad you reached out again. I\'m on top of {topic} and will have an update for you soon. {signoff}',
        '{greeting}, I see you\'ve been waiting on us and I apologize for the delay. {topic} is on my radar and I\'m personally making sure we get you taken care of today. {signoff}',
      ],
      frustrated_client: [
        '{greeting}, I hear you on this and I totally understand the frustration with {topic}. I\'m personally making sure this gets resolved. Let me get with the team today and I\'ll follow up with you directly. {signoff}',
        '{greeting}, I totally understand where you\'re coming from and I appreciate your patience with {topic}. We are in your corner on this. I\'m getting with the team right now and will have a clear update for you today. {signoff}',
        '{greeting}, I hear you and I want you to know we\'re taking this seriously. I\'m looking into {topic} myself and I\'ll make sure we get this sorted out. Expect an update from me today. {signoff}',
      ],
      general_checkin: [
        '{greeting}, hope you\'re having a great day! Just wanted to touch base. The team is making progress on {topic} and I\'ll keep you posted as things move forward. {signoff}',
        '{greeting}, just checking in on {topic}. We\'re moving things along and I wanted to make sure you\'re in the loop. Please let me know if you have any questions! {signoff}',
        '{greeting}, wanted to give you a quick update. We\'re working on {topic} and things are coming together nicely. I\'ll keep you updated as we go. {signoff}',
      ],
      happy_acknowledgment: [
        '{greeting}, that\'s awesome to hear! Really glad things are coming together. {signoff}',
        '{greeting}, love to hear that! We\'re excited about the progress too. {signoff}',
        '{greeting}, that\'s great news, appreciate you sharing that! You got this. {signoff}',
      ],
    },
  },

  // Polished and buttoned-up. "Hi {name}" greeting, "Best regards" sign-off.
  professional: {
    greeting: (name) => `Hi ${name}`,
    signoff: () => pick(['Best regards.', 'Thank you.', 'Best.']),
    templates: {
      direct_question: [
        '{greeting}, thank you for your question regarding {topic}. I\'m coordinating with the team and will have an update for you by end of day. {signoff}',
        '{greeting}, I\'ve noted your inquiry about {topic}. I\'ll follow up with the team and provide you with a detailed response shortly. {signoff}',
        '{greeting}, thank you for bringing this to our attention. I\'m looking into {topic} and will get back to you with an answer today. {signoff}',
      ],
      stacked_unanswered: [
        '{greeting}, I apologize for the delayed response. I\'ve reviewed your messages regarding {topic} and am prioritizing this now. You\'ll have an update from me today. {signoff}',
        '{greeting}, thank you for your patience. I want to assure you that {topic} is being addressed. I\'m following up with the team and will provide a comprehensive update shortly. {signoff}',
        '{greeting}, I sincerely apologize for the delay in getting back to you on {topic}. This is now my top priority and I will personally ensure you receive an update today. {signoff}',
      ],
      frustrated_client: [
        '{greeting}, I understand your frustration with {topic} and I take this seriously. I\'m personally overseeing the resolution and will follow up with you directly today. {signoff}',
        '{greeting}, I appreciate your patience and understand your concerns regarding {topic}. I\'m escalating this with the team now and will provide you with a clear resolution timeline today. {signoff}',
        '{greeting}, your concerns about {topic} are completely valid. I\'m taking personal ownership of this and will ensure we have a path forward for you by end of day. {signoff}',
      ],
      general_checkin: [
        '{greeting}, I wanted to provide a brief update. The team is making steady progress on {topic} and I\'ll keep you informed as things develop. {signoff}',
        '{greeting}, just a quick check-in regarding {topic}. Things are progressing well and I\'ll share a more detailed update soon. {signoff}',
        '{greeting}, I wanted to touch base on {topic}. We\'re on track and I\'ll continue to keep you updated on our progress. {signoff}',
      ],
      happy_acknowledgment: [
        '{greeting}, that\'s wonderful to hear. We\'re pleased with the progress as well. {signoff}',
        '{greeting}, thank you for sharing that feedback. It\'s great to know things are moving in the right direction. {signoff}',
        '{greeting}, glad to hear the positive update. We\'ll keep the momentum going. {signoff}',
      ],
    },
  },

  // Warm and upbeat but less personal than casual. "Hi {name}" greeting, cheerful sign-off.
  friendly: {
    greeting: (name) => `Hi ${name}`,
    signoff: () => {
      const day = getCurrentDay();
      if (day === 'Friday') return pick(['Have a great weekend!', 'Enjoy your weekend!']);
      return pick(['Have a great day!', `Have a wonderful ${day}!`, 'Talk soon!']);
    },
    templates: {
      direct_question: [
        '{greeting}! Great question about {topic}. Let me check with the team and I\'ll get back to you with an update today. {signoff}',
        '{greeting}! Thanks for reaching out about {topic}. I\'m looking into this and will have an answer for you shortly. {signoff}',
        '{greeting}! I\'m on it — let me check in with the team about {topic} and circle back to you today. {signoff}',
      ],
      stacked_unanswered: [
        '{greeting}! Sorry for the wait on this. I see your messages about {topic} and I\'m making sure we get you taken care of. I\'ll have an update for you soon. {signoff}',
        '{greeting}! Thanks for your patience. I\'m catching up on {topic} and will have a response for you today. {signoff}',
        '{greeting}! Apologies for the delay. {topic} is at the top of my list and I\'ll follow up with you shortly. {signoff}',
      ],
      frustrated_client: [
        '{greeting}, I completely understand your frustration with {topic}. I\'m making this a priority and will personally follow up with you today. {signoff}',
        '{greeting}, I hear you on {topic} and I\'m sorry for the trouble. I\'m working with the team to get this resolved and will keep you updated. {signoff}',
        '{greeting}, your concerns about {topic} are totally valid. I\'m on it and will make sure we get this sorted out for you today. {signoff}',
      ],
      general_checkin: [
        '{greeting}! Just wanted to check in. The team is making good progress on {topic} and I\'ll keep you in the loop. {signoff}',
        '{greeting}! Quick update — we\'re moving forward on {topic} and everything is looking good. Let me know if you have any questions! {signoff}',
        '{greeting}! Wanted to let you know we\'re working on {topic} and things are coming along nicely. More updates soon! {signoff}',
      ],
      happy_acknowledgment: [
        '{greeting}! That\'s great to hear! Really glad things are going well. {signoff}',
        '{greeting}! Love hearing that! We\'re excited about the progress too. {signoff}',
        '{greeting}! Awesome news — thanks for sharing! {signoff}',
      ],
    },
  },
};

// ============================================================================
// Situation Detection
// ============================================================================

/**
 * Determine which response situation best fits the channel analysis.
 *
 * Situations (in priority order):
 *   - frustrated_client: Client mood is frustrated
 *   - stacked_unanswered: Multiple unanswered messages (3+)
 *   - direct_question: Client asked a specific question
 *   - happy_acknowledgment: Client is happy
 *   - general_checkin: Default
 */
function detectSituation(analysis) {
  const mood = analysis.sentiment?.mood || 'neutral';
  const responseType = analysis.needs_response?.response_type || 'none';
  const unansweredCount = analysis.needs_response?.unanswered_count || 0;

  if (mood === 'frustrated') {
    return { situation: 'frustrated_client', confidence: 'high' };
  }

  if (unansweredCount >= 3) {
    return { situation: 'stacked_unanswered', confidence: 'high' };
  }

  if (responseType === 'question' || responseType === 'request') {
    return { situation: 'direct_question', confidence: 'high' };
  }

  if (mood === 'happy') {
    return { situation: 'happy_acknowledgment', confidence: 'high' };
  }

  if (analysis.needs_response?.needs_response) {
    return { situation: 'general_checkin', confidence: 'medium' };
  }

  return { situation: 'general_checkin', confidence: 'low' };
}

// ============================================================================
// draftMessage
// ============================================================================

/**
 * Generate a draft message based on channel analysis.
 * Returns null if drafting is disabled via DRAFTS_ENABLED=false.
 *
 * @param {object} analysis - Output from intelligence.analyzeChannel()
 * @returns {{ draft: string, situation: string, confidence: string, note: string, style: string } | null}
 */
function draftMessage(analysis) {
  if (!isDraftingEnabled()) return null;

  const styleName = getDraftStyle();
  const style = STYLES[styleName];
  const { situation, confidence } = detectSituation(analysis);

  // Get client name from last client message sender
  const lastClient = analysis.needs_response?.last_client_message;
  const name = firstName(lastClient?.sender_name || '');

  // Get topic
  const primaryTopic = analysis.topics?.primary_topic
    || (analysis.topics?.topics?.[0])
    || 'your project';

  // Build greeting and sign-off from style
  const greetingText = style.greeting(name);
  const signoffText = style.signoff();

  // Pick template and fill placeholders
  const templateVariants = style.templates[situation] || style.templates.general_checkin;
  let draft = pick(templateVariants);

  draft = draft.replace(/\{greeting\}/g, greetingText);
  draft = draft.replace(/\{topic\}/g, primaryTopic);
  draft = draft.replace(/\{signoff\}/g, signoffText);

  // Build contextual note
  const note = buildNote(situation, analysis, primaryTopic);

  return { draft, situation, confidence, note, style: styleName };
}

function buildNote(situation, analysis, topic) {
  const parts = [];
  const lastMsg = analysis.needs_response?.last_client_message;
  const lastText = lastMsg?.text;

  switch (situation) {
    case 'frustrated_client':
      parts.push('Client mood: frustrated');
      if (analysis.sentiment?.reasons?.length > 0) {
        parts.push(analysis.sentiment.reasons[0]);
      }
      parts.push('consider calling them directly');
      break;

    case 'stacked_unanswered':
      parts.push(`${analysis.needs_response.unanswered_count} unanswered messages`);
      if (lastText) parts.push(`latest: "${truncate(lastText, 80)}"`);
      break;

    case 'direct_question':
      if (lastText) parts.push(`Client asked: "${truncate(lastText, 100)}"`);
      else parts.push(`Client asked about ${topic}`);
      parts.push('check with team first');
      break;

    case 'happy_acknowledgment':
      parts.push('Client is positive');
      if (lastText) parts.push(`said: "${truncate(lastText, 80)}"`);
      parts.push('quick ack is fine');
      break;

    case 'general_checkin':
      parts.push(`General check-in on ${topic}`);
      break;

    default:
      parts.push(`Topic: ${topic}`);
  }

  return parts.join(' - ');
}

// ============================================================================
// draftBatch
// ============================================================================

/**
 * Draft messages for multiple channel analyses, sorted by priority.
 *
 * @param {Array} analyses - Array of analysis objects from intelligence.analyzeAllChannels()
 * @returns {Array} Array of { channel, priority_score, priority_reason, draft, situation, confidence, note }
 */
function draftBatch(analyses) {
  const results = [];

  for (const analysis of analyses) {
    // Only draft for channels that need a response
    if (!analysis.needs_response?.needs_response) continue;
    if (analysis.cancellation?.cancelled) continue;

    const draftResult = draftMessage(analysis);

    const entry = {
      channel: analysis.channel,
      priority_score: analysis.priority_score,
      priority_reason: analysis.priority_reason,
    };

    if (draftResult) {
      entry.draft = draftResult.draft;
      entry.situation = draftResult.situation;
      entry.confidence = draftResult.confidence;
      entry.note = draftResult.note;
      entry.style = draftResult.style;
    } else {
      entry.draft = null;
      entry.situation = detectSituation(analysis).situation;
      entry.confidence = detectSituation(analysis).confidence;
      entry.note = null;
    }

    results.push(entry);
  }

  results.sort((a, b) => b.priority_score - a.priority_score);
  return results;
}

// ============================================================================
// AI-Powered Draft Generation
// ============================================================================

/**
 * Format historical analysis snapshots into a concise summary for the AI prompt.
 */
function formatHistoryForPrompt(history) {
  if (!history || history.length < 2) return '';

  const lines = ['Recent channel history:'];

  // Show last 5 snapshots as brief summary
  const recent = history.slice(0, 5);
  for (const h of recent) {
    const date = new Date(h.analyzed_at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const responded = h.needs_response ? `needs response (${h.unanswered_count} unanswered)` : 'no response needed';
    lines.push(`- ${date}: mood ${h.sentiment_mood}, priority ${h.priority_score}/100, ${responded}`);
  }

  // Add trend summary
  const moods = recent.map(h => h.sentiment_mood);
  const frustratedCount = moods.filter(m => m === 'frustrated').length;
  if (frustratedCount >= 3) {
    lines.push(`NOTE: Client has been frustrated in ${frustratedCount} of last ${recent.length} check-ins. This is a chronic issue, not a one-time complaint.`);
  }

  const avgPriority = recent.reduce((sum, h) => sum + h.priority_score, 0) / recent.length;
  if (avgPriority >= 60) {
    lines.push(`NOTE: This channel has been consistently high-priority (avg ${Math.round(avgPriority)}/100). Treat with extra urgency.`);
  }

  return lines.join('\n');
}

/**
 * Describe the situation in plain English for the AI prompt.
 */
function describeSituation(situation) {
  const descriptions = {
    frustrated_client: 'The client is frustrated and unhappy. They may have expressed dissatisfaction, complained, or shown signs of impatience.',
    stacked_unanswered: 'Multiple client messages have gone unanswered. They have been waiting for a response and may be feeling ignored.',
    direct_question: 'The client asked a direct question or made a specific request that needs an answer.',
    happy_acknowledgment: 'The client expressed something positive — good news, satisfaction, or excitement. A brief, warm acknowledgment is appropriate.',
    general_checkin: 'A general check-in is needed. The client may be waiting for an update or just needs to hear from you.',
  };
  return descriptions[situation] || descriptions.general_checkin;
}

/**
 * Describe the draft style in plain English for the AI prompt.
 */
function describeStyle(styleName) {
  const descriptions = {
    casual: 'Warm and casual-professional. Use "Hey {Name}" greetings. Sign off with something upbeat like "Happy Monday!" or "Have an awesome weekend!" Be personable and genuine, not stiff.',
    professional: 'Polished and buttoned-up. Use "Hi {Name}" greetings. Sign off with "Best regards." or "Thank you." Be respectful and formal but not cold.',
    friendly: 'Warm and upbeat but slightly less personal than casual. Use "Hi {Name}!" greetings. Sign off with "Have a great day!" or "Talk soon!" Be cheerful and encouraging.',
  };
  return descriptions[styleName] || descriptions.casual;
}

/**
 * Generate an AI-powered draft message based on channel analysis.
 * Falls back to template-based draftMessage() if the AI call fails.
 * Returns null if drafting is disabled via DRAFTS_ENABLED=false.
 *
 * @param {object} analysis - Output from intelligence.analyzeChannel()
 * @returns {Promise<{ draft: string, situation: string, confidence: string, note: string, style: string } | null>}
 */
async function generateAIDraft(analysis) {
  if (!isDraftingEnabled()) return null;

  const { situation, confidence } = detectSituation(analysis);
  const styleName = getDraftStyle();
  const ownerName = process.env.BOT_OWNER_NAME || 'the owner';

  // Get client name
  const lastClient = analysis.needs_response?.last_client_message;
  const name = firstName(lastClient?.sender_name || '');

  // Get topic
  const primaryTopic = analysis.topics?.primary_topic
    || (analysis.topics?.topics?.[0])
    || 'your project';

  // Get mood info
  const mood = analysis.sentiment?.mood || 'neutral';
  const moodReasons = (analysis.sentiment?.reasons || []).slice(0, 3).join(', ') || 'no specific signals';
  const unansweredCount = analysis.needs_response?.unanswered_count || 0;

  // Fetch recent messages for context
  let recentMessages = [];
  try {
    const channelId = analysis.channel?.id;
    if (channelId) {
      recentMessages = db.getChannelMessages(channelId, 15);
    }
  } catch (e) {
    log.warn('drafter', `Failed to fetch recent messages for AI draft: ${e.message}`);
  }

  // Fetch historical context
  let historyContext = '';
  try {
    const channelId = analysis.channel?.id;
    if (channelId) {
      const history = db.getChannelAnalysisHistory(channelId, 14);
      if (history.length >= 2) {
        historyContext = formatHistoryForPrompt(history);
      }
    }
  } catch (e) {
    log.warn('drafter', `Failed to fetch history for AI draft: ${e.message}`);
  }

  // Format messages for the prompt
  const formattedMessages = recentMessages
    .map(m => {
      const senderName = m.display_name || m.real_name || 'Unknown';
      const text = (m.text || '').slice(0, 200);
      return `${senderName}: ${text}`;
    })
    .join('\n') || '(No recent messages available)';

  const currentDay = getCurrentDay();

  const prompt = `You are drafting a short message for ${ownerName} to send to a client in Slack.

Context:
- Client: ${name}
- Situation: ${describeSituation(situation)}
- Client mood: ${mood} (${moodReasons})
- Unanswered messages: ${unansweredCount}
- Topic: ${primaryTopic}

Recent conversation (newest first):
${formattedMessages}
${historyContext ? `\n${historyContext}\n` : ''}
Style: ${styleName}
${describeStyle(styleName)}

Rules:
- Address the client by first name
- Reference their SPECIFIC concern, not generic platitudes
- 2-4 sentences maximum
- Include a concrete next step or commitment
- Match the ${styleName} tone exactly
- Today is ${currentDay}
- End with an appropriate sign-off
- If history shows a chronic issue, acknowledge the ongoing nature (don't treat it as a new problem)
- If the client has been waiting across multiple check-ins, show extra empathy and urgency

Write ONLY the message. No explanations, alternatives, or quotation marks.`;

  try {
    const provider = getProvider();
    const model = process.env.DRAFT_MODEL || resolveModel();

    // Use AbortController for a separate 15s timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DRAFT_AI_TIMEOUT_MS);

    let response;
    try {
      response = await provider.createMessage({
        model,
        max_tokens: 300,
        system: 'You are a helpful assistant that writes short, natural Slack messages. Output only the message text, nothing else.',
        messages: [{ role: 'user', content: prompt }],
      });
    } finally {
      clearTimeout(timeout);
    }

    // Extract text from response
    const textBlocks = (response.content || []).filter(b => b.type === 'text');
    const draft = textBlocks.map(b => b.text).join('\n').trim();

    if (!draft) {
      log.warn('drafter', `AI returned empty draft for #${analysis.channel?.name || 'unknown'}, falling back to template`);
      return draftMessage(analysis);
    }

    // Build contextual note (same as template version)
    const note = buildNote(situation, analysis, primaryTopic);

    log.info('drafter', `AI draft generated for #${analysis.channel?.name || 'unknown'} (${situation}, ${model})`);

    return { draft, situation, confidence, note, style: styleName };
  } catch (err) {
    log.warn('drafter', `AI draft failed for #${analysis.channel?.name || 'unknown'}: ${err.message} — falling back to template`);
    return draftMessage(analysis);
  }
}

/**
 * Generate AI-powered draft messages for multiple channel analyses, sorted by priority.
 * Falls back to template-based drafts per-channel if AI fails.
 * If drafting is disabled, returns template-style results (nulls).
 *
 * @param {Array} analyses - Array of analysis objects from intelligence.analyzeAllChannels()
 * @returns {Promise<Array>} Array of { channel, priority_score, priority_reason, draft, situation, confidence, note, style }
 */
async function generateAIDraftBatch(analyses) {
  const results = [];

  for (const analysis of analyses) {
    if (!analysis.needs_response?.needs_response) continue;
    if (analysis.cancellation?.cancelled) continue;

    // Try AI draft, fall back to template
    const draftResult = await generateAIDraft(analysis);

    results.push({
      channel: analysis.channel,
      priority_score: analysis.priority_score,
      priority_reason: analysis.priority_reason,
      trend: analysis.trend || null,
      ...(draftResult || {}),
    });
  }

  results.sort((a, b) => b.priority_score - a.priority_score);
  return results;
}

module.exports = {
  draftMessage,
  draftBatch,
  generateAIDraft,
  generateAIDraftBatch,
  isDraftingEnabled,
  getDraftStyle,
  detectSituation,
};
