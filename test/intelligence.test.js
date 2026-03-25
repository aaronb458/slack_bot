'use strict';

/**
 * Unit tests for the intelligence module.
 * Run: node test/intelligence.test.js
 *
 * No test framework required — uses Node's built-in assert.
 */

const assert = require('assert');

// Set up env so database initializes in a temp location
const path = require('path');
const fs = require('fs');
const tmpDir = path.join(__dirname, '..', 'data', 'test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
process.env.DATA_DIR_OVERRIDE = tmpDir; // Won't actually be used — we test pure functions

const {
  analyzeSentiment,
  detectNeedsResponse,
  calculateActivityTier,
  extractTopics,
  detectCancellation,
  computePriority,
} = require('../src/intelligence');

const teamIds = new Set(['TEAM1', 'TEAM2']);

function makeMsg(userId, text, daysAgo = 0) {
  return {
    user_id: userId,
    text,
    timestamp: Date.now() - (daysAgo * 86400 * 1000),
    sender_name: userId === 'TEAM1' ? 'Team Member' : 'Client Person',
  };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
  }
}

// ============================================================
// Sentiment Analysis
// ============================================================
console.log('\nSentiment Analysis:');

test('empty messages returns unknown', () => {
  const result = analyzeSentiment([], teamIds);
  assert.strictEqual(result.mood, 'unknown');
});

test('happy message scores positive', () => {
  const result = analyzeSentiment([makeMsg('CLIENT', 'This looks great, thank you!')], teamIds);
  assert.strictEqual(result.mood, 'happy');
  assert(result.score > 0, `Score should be positive, got ${result.score}`);
});

test('frustrated message scores negative', () => {
  const result = analyzeSentiment([makeMsg('CLIENT', 'Still waiting on this, very frustrated')], teamIds);
  assert.strictEqual(result.mood, 'frustrated');
  assert(result.score < 0, `Score should be negative, got ${result.score}`);
});

test('neutral message stays neutral', () => {
  const result = analyzeSentiment([makeMsg('CLIENT', 'Here is the file you requested')], teamIds);
  assert.strictEqual(result.mood, 'neutral');
});

test('team messages are excluded from sentiment', () => {
  const result = analyzeSentiment([makeMsg('TEAM1', 'This is very frustrating for the client')], teamIds);
  assert.strictEqual(result.mood, 'unknown');
});

test('happy message with !!! is NOT penalized (false positive fix)', () => {
  const result = analyzeSentiment([makeMsg('CLIENT', 'Amazing work!!!')], teamIds);
  assert.strictEqual(result.mood, 'happy');
  assert(result.score >= 10, `Score should be >= 10, got ${result.score}`);
});

test('happy message with ??? is NOT penalized (false positive fix)', () => {
  const result = analyzeSentiment([makeMsg('CLIENT', 'Really impressed??? Wow this is perfect')], teamIds);
  assert(result.score >= 0, `Score should be >= 0, got ${result.score}`);
});

test('happy message with ALL CAPS is NOT penalized (false positive fix)', () => {
  const result = analyzeSentiment([makeMsg('CLIENT', 'THIS IS AMAZING WORK YOU GUYS DID')], teamIds);
  assert.strictEqual(result.mood, 'happy');
});

test('frustrated message with !!! IS penalized', () => {
  const result = analyzeSentiment([makeMsg('CLIENT', 'This is broken!! Nothing works!!')], teamIds);
  assert(result.score < -10, `Score should be heavily negative, got ${result.score}`);
});

test('mixed signals use net score', () => {
  const messages = [
    makeMsg('CLIENT', 'Thank you for the update'),
    makeMsg('CLIENT', 'But still waiting on the other items, frustrated'),
  ];
  const result = analyzeSentiment(messages, teamIds);
  // Both happy and frustrated detected — net result depends on relative weights
  assert(result.reasons.length >= 2, `Should have multiple reasons, got ${result.reasons.length}`);
});

// ============================================================
// Needs Response Detection
// ============================================================
console.log('\nNeeds Response Detection:');

test('last message from team = no response needed', () => {
  const messages = [makeMsg('CLIENT', 'Hello'), makeMsg('TEAM1', 'Hi there!')];
  const result = detectNeedsResponse(messages, teamIds);
  assert.strictEqual(result.needs_response, false);
});

test('last message from client = response needed', () => {
  const messages = [makeMsg('TEAM1', 'Hi'), makeMsg('CLIENT', 'When can I see the design?')];
  const result = detectNeedsResponse(messages, teamIds);
  assert.strictEqual(result.needs_response, true);
});

test('question mark detected as question', () => {
  const messages = [makeMsg('CLIENT', 'What is the timeline for this?')];
  const result = detectNeedsResponse(messages, teamIds);
  assert.strictEqual(result.response_type, 'question');
});

test('acknowledgment only = no response needed', () => {
  const messages = [makeMsg('CLIENT', 'sounds good')];
  const result = detectNeedsResponse(messages, teamIds);
  assert.strictEqual(result.needs_response, false);
});

test('stacked unanswered messages detected', () => {
  const messages = [
    makeMsg('CLIENT', 'Hello?'),
    makeMsg('CLIENT', 'Anyone there?'),
    makeMsg('CLIENT', 'Still waiting...'),
  ];
  const result = detectNeedsResponse(messages, teamIds);
  assert.strictEqual(result.unanswered_count, 3);
  assert(result.urgency_boost > 0, 'Urgency should be boosted');
});

test('empty messages = no response needed', () => {
  const result = detectNeedsResponse([], teamIds);
  assert.strictEqual(result.needs_response, false);
});

// ============================================================
// Activity Tier
// ============================================================
console.log('\nActivity Tier:');

test('no messages = chill', () => {
  const result = calculateActivityTier([], teamIds);
  assert.strictEqual(result.tier, 'chill');
});

test('few messages = chill', () => {
  const messages = [makeMsg('CLIENT', 'Hello'), makeMsg('CLIENT', 'World')];
  const result = calculateActivityTier(messages, teamIds);
  assert.strictEqual(result.tier, 'chill');
});

// ============================================================
// Topic Extraction
// ============================================================
console.log('\nTopic Extraction:');

test('detects website topic', () => {
  const messages = [makeMsg('CLIENT', 'Can you update the website homepage?')];
  const result = extractTopics(messages);
  assert(result.topics.includes('website'), `Should include website, got ${result.topics}`);
});

test('detects multiple topics', () => {
  const messages = [
    makeMsg('CLIENT', 'The website needs SEO work'),
    makeMsg('CLIENT', 'Also update the email campaign'),
  ];
  const result = extractTopics(messages);
  assert(result.topics.length >= 2, `Should have 2+ topics, got ${result.topics.length}`);
});

test('no topics = empty array', () => {
  const messages = [makeMsg('CLIENT', 'Sounds good')];
  const result = extractTopics(messages);
  assert.strictEqual(result.primary_topic, null);
});

// ============================================================
// Cancellation Detection
// ============================================================
console.log('\nCancellation Detection:');

test('detects cancellation from team message', () => {
  const messages = [makeMsg('TEAM1', 'Client wants to cancel service effective immediately')];
  const result = detectCancellation(messages, teamIds);
  assert.strictEqual(result.cancelled, true);
});

test('client message does not trigger cancellation', () => {
  const messages = [makeMsg('CLIENT', 'I want to cancel service')];
  const result = detectCancellation(messages, teamIds);
  assert.strictEqual(result.cancelled, false);
});

test('no cancellation signal = false', () => {
  const messages = [makeMsg('TEAM1', 'Great meeting today, moving forward on design')];
  const result = detectCancellation(messages, teamIds);
  assert.strictEqual(result.cancelled, false);
});

// ============================================================
// Priority Scoring
// ============================================================
console.log('\nPriority Scoring:');

test('frustrated + needs response = high priority', () => {
  const analysis = {
    sentiment: { mood: 'frustrated' },
    needs_response: { needs_response: true, unanswered_count: 4, last_client_message: { timestamp: Date.now() - 86400000 * 2 } },
    activity: { tier: 'active' },
    cancellation: { cancelled: false },
  };
  const score = computePriority(analysis);
  assert(score >= 70, `Should be high priority (70+), got ${score}`);
});

test('cancelled = very low priority', () => {
  const analysis = {
    sentiment: { mood: 'neutral' },
    needs_response: { needs_response: false, unanswered_count: 0 },
    activity: { tier: 'chill' },
    cancellation: { cancelled: true },
  };
  const score = computePriority(analysis);
  assert(score <= 10, `Cancelled should be very low priority, got ${score}`);
});

test('no response needed = low priority', () => {
  const analysis = {
    sentiment: { mood: 'neutral' },
    needs_response: { needs_response: false, unanswered_count: 0 },
    activity: { tier: 'active' },
    cancellation: { cancelled: false },
  };
  const score = computePriority(analysis);
  assert(score <= 30, `No response needed should be low, got ${score}`);
});

// ============================================================
// Results
// ============================================================
console.log(`\n${passed} passed, ${failed} failed\n`);

// Cleanup
try {
  fs.rmSync(tmpDir, { recursive: true });
} catch (e) { /* ignore */ }

process.exit(failed > 0 ? 1 : 0);
