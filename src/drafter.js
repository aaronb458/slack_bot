'use strict';

// drafter.js
// Generates draft messages in Aaron's voice for channels that need a response.
// Ported from ClickUp assistant's message-drafter.js.
//
// Aaron's voice: warm, casual-professional, optimistic, encouraging.
// Greeting: "Hey @Name" (lowercase hey, never Hi/Hello)
// Sign-off: "Happy [Day]!" or "Happy happy [Day]!" (randomly alternated)
// Fridays: may also use "Have an awesome weekend!"

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
// getDayGreeting
// ============================================================================

function getDayGreeting() {
  const day = getCurrentDay();

  if (day === 'Friday') {
    return pick(['Happy Friday!', 'Happy happy Friday!', 'Have an awesome weekend!']);
  }

  const useDouble = Math.random() < 0.4;
  return useDouble ? `Happy happy ${day}!` : `Happy ${day}!`;
}

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
// Templates — 2-3 variants per situation
// ============================================================================

const TEMPLATES = {
  direct_question: [
    'Hey {name}, great question, let me check in with the team on {topic} and get you an update. I\'ll have something for you by end of day. {greeting}',
    'Hey {name}, thanks for reaching out on this! I\'m going to get with the team about {topic} and circle back to you shortly. {greeting}',
    'Hey {name}, appreciate you flagging this! Let me dig into {topic} and I\'ll get back to you with an answer today. {greeting}',
  ],

  stacked_unanswered: [
    'Hey {name}, appreciate your patience here. I see your messages and I want to make sure we get this handled. I\'m looking into {topic} right now and will get back to you shortly. {greeting}',
    'Hey {name}, no worries on the follow-ups, I\'m glad you reached out again. I\'m on top of {topic} and will have an update for you soon. {greeting}',
    'Hey {name}, I see you\'ve been waiting on us and I apologize for the delay. {topic} is on my radar and I\'m personally making sure we get you taken care of today. {greeting}',
  ],

  frustrated_client: [
    'Hey {name}, I hear you on this and I totally understand the frustration with {topic}. I\'m personally making sure this gets resolved. Let me get with the team today and I\'ll follow up with you directly. {greeting}',
    'Hey {name}, I totally understand where you\'re coming from and I appreciate your patience with {topic}. We are in your corner on this. I\'m getting with the team right now and will have a clear update for you today. {greeting}',
    'Hey {name}, I hear you and I want you to know we\'re taking this seriously. I\'m looking into {topic} myself and I\'ll make sure we get this sorted out. Expect an update from me today. {greeting}',
  ],

  general_checkin: [
    'Hey {name}, hope you\'re having a great day! Just wanted to touch base. The team is making progress on {topic} and I\'ll keep you posted as things move forward. {greeting}',
    'Hey {name}, just checking in on {topic}. We\'re moving things along and I wanted to make sure you\'re in the loop. Please let me know if you have any questions! {greeting}',
    'Hey {name}, wanted to give you a quick update. We\'re working on {topic} and things are coming together nicely. I\'ll keep you updated as we go. {greeting}',
  ],

  happy_acknowledgment: [
    'Hey {name}, that\'s awesome to hear! Really glad things are coming together. {greeting}',
    'Hey {name}, love to hear that! We\'re excited about the progress too. {greeting}',
    'Hey {name}, that\'s great news, appreciate you sharing that! You got this. {greeting}',
  ],
};

// ============================================================================
// draftMessage
// ============================================================================

/**
 * Generate a draft message based on channel analysis.
 *
 * @param {object} analysis - Output from intelligence.analyzeChannel()
 * @returns {{ draft: string, situation: string, confidence: string, note: string }}
 */
function draftMessage(analysis) {
  const { situation, confidence } = detectSituation(analysis);
  const greeting = getDayGreeting();

  // Get client name from last client message sender
  const lastClient = analysis.needs_response?.last_client_message;
  const name = firstName(lastClient?.sender_name || '');

  // Get topic
  const primaryTopic = analysis.topics?.primary_topic
    || (analysis.topics?.topics?.[0])
    || 'your project';

  // Pick template and fill placeholders
  const templateVariants = TEMPLATES[situation] || TEMPLATES.general_checkin;
  let draft = pick(templateVariants);

  draft = draft.replace(/\{name\}/g, name);
  draft = draft.replace(/\{topic\}/g, primaryTopic);
  draft = draft.replace(/\{greeting\}/g, greeting);

  // Build contextual note
  const note = buildNote(situation, analysis, primaryTopic);

  return { draft, situation, confidence, note };
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

    const { draft, situation, confidence, note } = draftMessage(analysis);

    results.push({
      channel: analysis.channel,
      priority_score: analysis.priority_score,
      priority_reason: analysis.priority_reason,
      draft,
      situation,
      confidence,
      note,
    });
  }

  results.sort((a, b) => b.priority_score - a.priority_score);
  return results;
}

module.exports = {
  draftMessage,
  draftBatch,
  getDayGreeting,
  detectSituation,
};
