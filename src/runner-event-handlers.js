import { createClaudeProviderAdapter } from './providers/claude.js';
import { createCodexProviderAdapter } from './providers/codex.js';
import { createGeminiProviderAdapter } from './providers/gemini.js';
import { createProviderAdapterRegistry } from './providers/index.js';

export function createRunnerEventParser({
  normalizeProvider = (value) => String(value || '').trim().toLowerCase(),
  extractAgentMessageText = () => '',
  isFinalAnswerLikeAgentMessage = () => true,
} = {}) {
  const providerAdapters = createProviderAdapterRegistry([
    createCodexProviderAdapter({
      parseEvent: (event, state, ensureSessionBridge) => handleCodexRunnerEvent(event, state, ensureSessionBridge, {
        extractAgentMessageText,
        isFinalAnswerLikeAgentMessage,
      }),
    }),
    createClaudeProviderAdapter({
      parseEvent: (event, state, ensureSessionBridge) => handleClaudeRunnerEvent(event, state, ensureSessionBridge),
    }),
    createGeminiProviderAdapter({
      parseEvent: (event, state, ensureSessionBridge) => handleGeminiRunnerEvent(event, state, ensureSessionBridge),
    }),
  ]);

  return function handleRunnerEvent(provider, event, state, ensureSessionBridge) {
    const adapter = providerAdapters.get(normalizeProvider(provider));
    adapter.runtime.parseEvent(event, state, ensureSessionBridge);
  };
}

export function handleCodexRunnerEvent(event, state, ensureSessionBridge, {
  extractAgentMessageText = () => '',
  isFinalAnswerLikeAgentMessage = () => true,
} = {}) {
  switch (event.type) {
    case 'thread.started':
    case 'thread.created':
    case 'thread.resumed':
      state.threadId = event.thread_id || state.threadId;
      if (state.threadId) ensureSessionBridge(state.threadId);
      break;
    case 'item.completed':
    case 'item.delta':
    case 'item.updated': {
      const item = event.item;
      const itemType = String(item?.type || '').trim().toLowerCase();
      if (itemType === 'reasoning') {
        const text = String(item?.text || item?.summary || '').trim();
        if (text) state.reasonings.push(text);
        break;
      }
      if (!['agent_message', 'assistant_message', 'message'].includes(itemType)) break;
      const text = extractAgentMessageText(item);
      if (!text) break;
      if (isFinalAnswerLikeAgentMessage(item)) state.finalAnswerMessages.push(text);
      else state.messages.push(text);
      break;
    }
    case 'assistant.message.delta':
    case 'assistant.message': {
      const text = extractAgentMessageText(event);
      if (!text) break;
      if (isFinalAnswerLikeAgentMessage(event)) state.finalAnswerMessages.push(text);
      else state.messages.push(text);
      break;
    }
    case 'reasoning.delta':
    case 'reasoning': {
      const text = String(event.text || '').trim();
      if (text) state.reasonings.push(text);
      break;
    }
    case 'usage':
      state.usage = event;
      break;
    case 'turn.completed':
      state.usage = event;
      break;
    default:
      break;
  }
}

export function handleGeminiRunnerEvent(event, state, ensureSessionBridge) {
  switch (String(event?.type || '').trim().toLowerCase()) {
    case 'init':
      state.threadId = event.session_id || event.sessionId || state.threadId;
      if (state.threadId) ensureSessionBridge(state.threadId);
      break;
    case 'message': {
      if (String(event.role || '').trim().toLowerCase() !== 'assistant') break;
      const text = String(event.content || '');
      if (!text) break;
      if (event.delta === true) {
        state.meta.geminiDeltaBuffer = `${state.meta.geminiDeltaBuffer || ''}${text}`;
      } else {
        state.messages.push(text.trim());
      }
      break;
    }
    case 'result':
      state.usage = event.stats && typeof event.stats === 'object' ? event.stats : event;
      break;
    default:
      break;
  }
}

export function handleClaudeRunnerEvent(event, state, ensureSessionBridge) {
  switch (event.type) {
    case 'stream_event': {
      const block = event.event?.content_block;
      if (event.event?.type === 'content_block_start' && block?.type === 'tool_use') {
        const toolName = String(block.name || '').trim().toLowerCase();
        if (toolName === 'agent') state.meta.claudeSawAgentToolUse = true;
      }
      break;
    }
    case 'session.created':
    case 'session.resumed':
      state.threadId = event.session_id || event.sessionId || state.threadId;
      if (state.threadId) ensureSessionBridge(state.threadId);
      break;
    case 'message':
    case 'assistant': {
      const text = extractClaudeText(event);
      if (!text) break;
      if (isClaudeFinalAnswerEvent(event)) appendUniqueText(state.finalAnswerMessages, text);
      else appendUniqueText(state.messages, text);
      const nextThreadId = event.session_id || event.sessionId || state.threadId;
      if (nextThreadId && nextThreadId !== state.threadId) {
        state.threadId = nextThreadId;
        ensureSessionBridge(state.threadId);
      }
      break;
    }
    case 'result': {
      const text = extractClaudeText(event);
      if (text) appendUniqueText(state.finalAnswerMessages, text);
      state.meta.claudeStopReason = extractClaudeStopReason(event);
      const nextThreadId = event.session_id || event.sessionId || state.threadId;
      if (nextThreadId) {
        state.threadId = nextThreadId;
        ensureSessionBridge(state.threadId);
      }
      if (event.usage) state.usage = event.usage;
      break;
    }
    default:
      break;
  }
}

function appendUniqueText(list, text) {
  const next = String(text || '').trim();
  if (!next) return;
  const previous = String(list?.[list.length - 1] || '').trim();
  if (normalizeComparableText(previous) === normalizeComparableText(next)) return;
  list.push(next);
}

function normalizeComparableText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function collectClaudeTextParts(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectClaudeTextParts(item));
  }
  if (typeof value !== 'object') return [];

  const type = String(value.type || '').trim().toLowerCase();
  if (type === 'tool_use' || type === 'tool_result' || type === 'server_tool_use' || type === 'thinking') {
    return [];
  }

  const parts = [
    ...collectClaudeTextParts(value.text),
    ...collectClaudeTextParts(value.output_text),
    ...collectClaudeTextParts(value.input_text),
    ...collectClaudeTextParts(value.reasoning_text),
  ];

  if (typeof value.message === 'string') {
    parts.push(...collectClaudeTextParts(value.message));
  } else if (value.message && typeof value.message === 'object') {
    parts.push(...collectClaudeTextParts(value.message));
  }

  if (Array.isArray(value.content)) {
    parts.push(...collectClaudeTextParts(value.content));
  }

  return parts;
}

function extractClaudeStopReason(event) {
  const candidates = [
    event?.stop_reason,
    event?.stopReason,
    event?.message?.stop_reason,
    event?.message?.stopReason,
    event?.result?.stop_reason,
    event?.result?.stopReason,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text;
  }
  return '';
}

function isClaudeFinalAnswerEvent(event) {
  return extractClaudeStopReason(event).toLowerCase() === 'end_turn';
}

function extractClaudeText(event) {
  if (!event || typeof event !== 'object') return '';
  const parts = collectClaudeTextParts([
    event.text,
    event.message,
    event.content,
    event.result,
  ]);
  return parts.join('\n\n').trim();
}
