/**
 * AI Provider Abstraction Layer
 *
 * Supports two backends:
 *   - "anthropic" (default): Uses @anthropic-ai/sdk directly
 *   - "openrouter": Uses the openai package pointed at OpenRouter's API
 *
 * Set AI_PROVIDER env var to switch. Both return Anthropic-normalized responses
 * so ai.js needs minimal changes.
 */

const { log } = require('./utils');

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const TIMEOUT_MS = 45000; // 45 seconds

// --- Model resolution ---

function resolveModel() {
  // AI_MODEL takes priority, then CLAUDE_MODEL for backward compat
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;

  // Provider-specific defaults
  if (PROVIDER === 'openrouter') return 'anthropic/claude-sonnet-4-5';
  return 'claude-sonnet-4-5-20250929';
}

// ============================================================
// Anthropic Provider
// ============================================================

function createAnthropicProvider() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. You chose the "anthropic" provider but forgot the key. ' +
      'Set it in your .env file or environment variables.'
    );
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();

  return {
    getProviderName() {
      return 'anthropic';
    },

    async createMessage({ model, max_tokens, system, tools, messages }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const params = {
          model: model || resolveModel(),
          max_tokens: max_tokens || 2048,
          messages,
        };
        if (system) params.system = system;
        if (tools && tools.length > 0) params.tools = tools;

        const response = await client.messages.create(params, {
          signal: controller.signal,
        });

        // Already in Anthropic format -- pass through
        return {
          content: response.content,
          stop_reason: response.stop_reason,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

// ============================================================
// OpenRouter Provider (OpenAI-compatible)
// ============================================================

function createOpenRouterProvider() {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. You chose the "openrouter" provider but forgot the key. ' +
      'Set it in your .env file or environment variables.'
    );
  }

  let OpenAI;
  try {
    OpenAI = require('openai');
  } catch (e) {
    throw new Error(
      'The "openai" npm package is not installed. Run: npm install openai'
    );
  }

  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  });

  // --- Conversion helpers: Anthropic format -> OpenAI format ---

  /**
   * Convert Anthropic tool definitions to OpenAI function-calling format.
   *   { name, description, input_schema } -> { type: 'function', function: { name, description, parameters } }
   */
  function convertTools(anthropicTools) {
    if (!anthropicTools || anthropicTools.length === 0) return undefined;
    return anthropicTools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  /**
   * Convert a single Anthropic content array (assistant message) into
   * OpenAI assistant message format.
   *
   * Anthropic: { role: 'assistant', content: [ {type:'text',...}, {type:'tool_use',...} ] }
   * OpenAI:    { role: 'assistant', content: '...', tool_calls: [...] }
   */
  function convertAssistantContent(contentBlocks) {
    if (typeof contentBlocks === 'string') {
      return { content: contentBlocks, tool_calls: undefined };
    }
    if (!Array.isArray(contentBlocks)) {
      return { content: contentBlocks ? String(contentBlocks) : '', tool_calls: undefined };
    }

    const textParts = [];
    const toolCalls = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }

    return {
      content: textParts.length > 0 ? textParts.join('\n') : null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  /**
   * Convert Anthropic message history to OpenAI messages.
   *
   * Key translations:
   *   - system prompt becomes { role: 'system', content: '...' }
   *   - user messages with tool_result arrays become separate { role: 'tool' } messages
   *   - assistant messages with mixed content blocks get split into content + tool_calls
   */
  function convertMessages(systemPrompt, anthropicMessages) {
    const openaiMessages = [];

    // System prompt -> system message
    if (systemPrompt) {
      openaiMessages.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of anthropicMessages) {
      if (msg.role === 'user') {
        // Check if this is a tool_result array (Anthropic sends tool results as user messages)
        if (Array.isArray(msg.content)) {
          const hasToolResults = msg.content.some((b) => b.type === 'tool_result');
          if (hasToolResults) {
            // Convert each tool_result into a separate { role: 'tool' } message
            for (const block of msg.content) {
              if (block.type === 'tool_result') {
                openaiMessages.push({
                  role: 'tool',
                  tool_call_id: block.tool_use_id,
                  content: typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content),
                });
              }
            }
          } else {
            // Regular user content array -- join text blocks
            const text = msg.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
            openaiMessages.push({ role: 'user', content: text || '' });
          }
        } else {
          // Simple string content
          openaiMessages.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'assistant') {
        const { content, tool_calls } = convertAssistantContent(msg.content);
        const assistantMsg = { role: 'assistant' };
        // OpenAI requires content to be string or null
        assistantMsg.content = content || null;
        if (tool_calls) assistantMsg.tool_calls = tool_calls;
        openaiMessages.push(assistantMsg);
      }
    }

    return openaiMessages;
  }

  // --- Conversion helpers: OpenAI response -> Anthropic normalized format ---

  /**
   * Convert an OpenAI chat completion response to Anthropic's normalized format.
   */
  function normalizeResponse(openaiResponse) {
    const choice = openaiResponse.choices?.[0];
    if (!choice) {
      return { content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' };
    }

    const message = choice.message;
    const contentBlocks = [];

    // Text content
    if (message.content) {
      contentBlocks.push({ type: 'text', text: message.content });
    }

    // Tool calls -> tool_use blocks
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const tc of message.tool_calls) {
        let parsedInput = {};
        try {
          parsedInput = JSON.parse(tc.function.arguments || '{}');
        } catch (e) {
          log.warn('ai-provider', `Failed to parse tool call arguments for ${tc.function.name}: ${e.message}`);
          parsedInput = {};
        }

        contentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parsedInput,
        });
      }
    }

    // If somehow we got zero blocks, put an empty text block
    if (contentBlocks.length === 0) {
      contentBlocks.push({ type: 'text', text: '' });
    }

    // Map finish_reason
    let stop_reason = 'end_turn';
    if (choice.finish_reason === 'tool_calls') {
      stop_reason = 'tool_use';
    } else if (choice.finish_reason === 'stop') {
      stop_reason = 'end_turn';
    } else if (choice.finish_reason === 'length') {
      stop_reason = 'max_tokens';
    }

    return {
      content: contentBlocks,
      stop_reason,
    };
  }

  return {
    getProviderName() {
      return 'openrouter';
    },

    async createMessage({ model, max_tokens, system, tools, messages }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const openaiMessages = convertMessages(system, messages);
        const openaiTools = convertTools(tools);

        const params = {
          model: model || resolveModel(),
          max_tokens: max_tokens || 2048,
          messages: openaiMessages,
        };
        if (openaiTools) params.tools = openaiTools;

        const response = await client.chat.completions.create(params, {
          signal: controller.signal,
        });

        return normalizeResponse(response);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

// ============================================================
// Factory — create and cache the provider singleton
// ============================================================

let _provider = null;

function getProvider() {
  if (_provider) return _provider;

  if (PROVIDER === 'openrouter') {
    _provider = createOpenRouterProvider();
  } else if (PROVIDER === 'anthropic') {
    _provider = createAnthropicProvider();
  } else {
    throw new Error(
      `Unknown AI_PROVIDER "${PROVIDER}". Valid options: "anthropic" (default), "openrouter".`
    );
  }

  const model = resolveModel();
  log.info('ai-provider', `Active provider: ${_provider.getProviderName()} | model: ${model}`);

  return _provider;
}

module.exports = { getProvider, resolveModel };
