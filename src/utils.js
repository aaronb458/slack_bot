const fs = require('fs');
const path = require('path');

// --- File Logger ---

// Railway mounts persistent volume at /app/data — fallback to local ./data for dev
const LOG_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function formatLogLine(level, tag, message) {
  const ts = new Date().toISOString();
  return `${ts} [${level}] [${tag}] ${message}`;
}

function writeLog(line) {
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, line + '\n');
}

const log = {
  info(tag, msg) {
    const line = formatLogLine('INFO', tag, msg);
    console.log(line);
    writeLog(line);
  },
  warn(tag, msg) {
    const line = formatLogLine('WARN', tag, msg);
    console.warn(line);
    writeLog(line);
  },
  error(tag, msg) {
    const line = formatLogLine('ERROR', tag, msg);
    console.error(line);
    writeLog(line);
  },
};

// --- Retry with Exponential Backoff ---

/**
 * Wraps a Slack API call with retry logic and rate-limit handling.
 *
 * @param {Function} fn - Async function to call (should return a Slack API response)
 * @param {object} opts
 * @param {number} opts.maxRetries - Max retry attempts (default 3)
 * @param {number} opts.baseDelay - Base delay in ms (default 1000)
 * @param {string} opts.label - Label for logging
 * @returns {Promise<any>} The result of fn()
 */
async function retrySlack(fn, { maxRetries = 3, baseDelay = 1000, label = 'api' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Slack rate limit: error code 429 or error with retryAfter
      const retryAfter = error.retryAfter || error.data?.retry_after;
      const isRateLimit = error.code === 429 || error.statusCode === 429 || retryAfter;
      const isTransient = isRateLimit || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET' ||
        error.code === 'EPIPE' || error.message?.includes('timeout') ||
        error.data?.error === 'internal_error' || error.data?.error === 'service_unavailable';

      if (!isTransient || attempt === maxRetries) {
        log.error(label, `Failed after ${attempt + 1} attempt(s): ${error.message}`);
        throw error;
      }

      // Calculate delay: use Slack's retry-after header if present, otherwise exponential backoff
      const delay = retryAfter
        ? (retryAfter * 1000) + 100
        : baseDelay * Math.pow(2, attempt) + Math.random() * 500;

      log.warn(label, `Attempt ${attempt + 1} failed (${isRateLimit ? 'rate limited' : error.code || error.message}), retrying in ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
  }
  throw lastError;
}

// --- Sleep ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Uptime tracker ---

const startedAt = Date.now();

function getUptime() {
  const diff = Date.now() - startedAt;
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  return `${hours}h ${mins}m ${secs}s`;
}

module.exports = { log, retrySlack, sleep, getUptime };
