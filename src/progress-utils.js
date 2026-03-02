const DEFAULT_PREVIEW_CHARS = 140;
const DEFAULT_PLAN_MAX_LINES = 4;
const DEFAULT_DONE_STEPS_MAX = 4;
const DEFAULT_ACTIVITY_MAX = 4;

function truncate(text, max) {
  const value = String(text || '');
  if (!value || value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeEventType(type) {
  return String(type || '').trim().toLowerCase().replace(/[.-]/g, '_');
}

function prettifyEventType(type) {
  const value = normalizeWhitespace(String(type || '').replace(/[._-]+/g, ' '));
  return value || 'received event';
}

function parseJsonMaybe(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!(text.startsWith('{') || text.startsWith('['))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeStatus(status) {
  const value = normalizeWhitespace(status).toLowerCase();
  if (!value) return '';
  if (['completed', 'complete', 'done', 'finished', 'success', 'ok'].includes(value)) return 'completed';
  if (['started', 'start', 'running', 'in_progress', 'in-progress', 'active'].includes(value)) return 'started';
  return value;
}

function extractEventPayload(ev) {
  if (!ev || typeof ev !== 'object') return null;
  return ev.payload && typeof ev.payload === 'object' ? ev.payload : null;
}

function compactUrl(rawUrl, previewChars = DEFAULT_PREVIEW_CHARS) {
  const text = normalizeWhitespace(rawUrl);
  if (!text) return '';

  try {
    const url = new URL(text);
    const host = url.hostname || '';
    const pathname = url.pathname && url.pathname !== '/' ? url.pathname : '';
    const summary = `${host}${pathname}` || text;
    return truncate(summary, Math.max(28, Math.floor(previewChars * 0.8)));
  } catch {
    return truncate(text, Math.max(28, Math.floor(previewChars * 0.8)));
  }
}

function extractWebSearchActionSummary(raw, options = {}) {
  const previewChars = Math.max(60, Number(options.previewChars || DEFAULT_PREVIEW_CHARS));
  if (!raw || typeof raw !== 'object') return '';

  const action = raw.action && typeof raw.action === 'object' ? raw.action : raw;
  const actionType = normalizeEventType(action.type || raw.action_type || raw.kind || '');
  const query = normalizeWhitespace(action.query || action.q || raw.query || raw.q || '');
  const queries = Array.isArray(action.queries) ? action.queries : Array.isArray(raw.queries) ? raw.queries : [];
  const firstQuery = query || normalizeWhitespace(queries[0] || '');
  const url = compactUrl(action.url || raw.url || '', previewChars);
  const pattern = normalizeWhitespace(action.pattern || raw.pattern || '');

  if (actionType.includes('search') || firstQuery) {
    return firstQuery ? `search: ${truncate(firstQuery, previewChars)}` : 'search';
  }

  if (actionType.includes('open') || (url && !pattern)) {
    return url ? `open page: ${url}` : 'open page';
  }

  if (actionType.includes('find') || pattern) {
    if (pattern && url) return `find "${truncate(pattern, Math.floor(previewChars * 0.55))}" in ${url}`;
    if (pattern) return `find "${truncate(pattern, Math.floor(previewChars * 0.7))}"`;
    if (url) return `find in ${url}`;
    return 'find in page';
  }

  if (url) return `open page: ${url}`;
  if (pattern) return `find "${truncate(pattern, Math.floor(previewChars * 0.7))}"`;
  return '';
}

function extractCommandPreview(raw, options = {}) {
  const previewChars = Math.max(60, Number(options.previewChars || DEFAULT_PREVIEW_CHARS));
  if (!raw || typeof raw !== 'object') return '';

  const candidates = [
    raw.command,
    raw.cmd,
    raw.parsed_cmd,
    raw.parsedCmd,
    raw.invocation?.command,
    raw.input?.command,
    raw.output?.command,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const joined = normalizeWhitespace(candidate.join(' '));
      if (joined) return truncate(joined, previewChars);
      continue;
    }

    const text = normalizeWhitespace(candidate);
    if (text) return truncate(text, previewChars);
  }

  return '';
}

function extractItemToolName(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = item.tool_name || item.name || item.call?.name || item.tool?.name || null;
  const normalized = normalizeWhitespace(raw);
  return normalized || null;
}

function extractToolCallArguments(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = item.call?.arguments ?? item.call?.args ?? item.arguments ?? item.args ?? null;
  if (!raw) return null;

  if (typeof raw === 'string') {
    const parsed = parseJsonMaybe(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  }

  return raw && typeof raw === 'object' ? raw : null;
}

function summarizeKnownArgObject(args, options = {}) {
  if (!args || typeof args !== 'object') return '';

  const webSearch = extractWebSearchActionSummary(args, options);
  if (webSearch) return webSearch;

  const command = extractCommandPreview(args, options);
  if (command) return `run: ${command}`;

  const scalarKeys = ['query', 'q', 'url', 'pattern', 'location', 'ticker', 'path', 'team', 'ref_id', 'name', 'title'];
  for (const key of scalarKeys) {
    const value = normalizeWhitespace(args[key]);
    if (!value) continue;
    if (key === 'url') return `open page: ${compactUrl(value, options.previewChars)}`;
    if (key === 'pattern') return `find "${truncate(value, Math.floor((options.previewChars || DEFAULT_PREVIEW_CHARS) * 0.7))}"`;
    return `${key}: ${truncate(value, options.previewChars || DEFAULT_PREVIEW_CHARS)}`;
  }

  const list = Array.isArray(args.search_query) ? args.search_query : null;
  if (list?.length) {
    const first = list[0] && typeof list[0] === 'object' ? list[0] : null;
    const query = normalizeWhitespace(first?.q);
    if (query) return `search: ${truncate(query, options.previewChars || DEFAULT_PREVIEW_CHARS)}`;
  }

  return '';
}

function extractPayloadTextPreview(payload, options = {}) {
  const previewChars = Math.max(60, Number(options.previewChars || DEFAULT_PREVIEW_CHARS));
  if (!payload || typeof payload !== 'object') return '';

  const textCandidates = [];
  if (typeof payload.text === 'string') textCandidates.push(payload.text);

  if (Array.isArray(payload.content)) {
    for (const part of payload.content) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') textCandidates.push(part.text);
      if (typeof part.output_text === 'string') textCandidates.push(part.output_text);
      if (typeof part.input_text === 'string') textCandidates.push(part.input_text);
      if (typeof part.reasoning_text === 'string') textCandidates.push(part.reasoning_text);
    }
  }

  const normalized = normalizeWhitespace(textCandidates.join(' '));
  if (!normalized) return '';
  return truncate(normalized, previewChars);
}

function extractDeltaTextPreview(ev, payload, options = {}) {
  const previewChars = Math.max(60, Number(options.previewChars || DEFAULT_PREVIEW_CHARS));
  const textCandidates = [];
  const pushText = (value) => {
    if (typeof value !== 'string') return;
    const normalized = normalizeWhitespace(value);
    if (!normalized) return;
    textCandidates.push(normalized);
  };

  pushText(ev?.delta);
  pushText(ev?.text_delta);
  pushText(ev?.output_text_delta);
  pushText(ev?.reasoning_delta);
  pushText(payload?.delta);
  pushText(payload?.text_delta);
  pushText(payload?.output_text_delta);
  pushText(payload?.reasoning_delta);
  pushText(payload?.text);

  if (Array.isArray(payload?.content)) {
    for (const part of payload.content) {
      if (!part || typeof part !== 'object') continue;
      pushText(part.delta);
      pushText(part.text);
      pushText(part.output_text);
      pushText(part.input_text);
      pushText(part.reasoning_text);
    }
  }

  if (!textCandidates.length) {
    const preview = extractPayloadTextPreview(payload, { previewChars });
    if (preview) textCandidates.push(preview);
  }

  const merged = normalizeWhitespace(textCandidates.join(' '));
  return merged ? truncate(merged, previewChars) : '';
}

function summarizeResponseItem(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return '';
  const payloadType = normalizeEventType(payload.type || '');
  const status = normalizeStatus(payload.status || '');

  if (payloadType === 'web_search_call') {
    const detail = extractWebSearchActionSummary(payload.action || payload, options);
    const phase = status || 'updated';
    return detail ? `web search ${phase}: ${detail}` : `web search ${phase}`;
  }

  if (payloadType === 'local_shell_call') {
    const command = extractCommandPreview(payload, options);
    const phase = status || 'updated';
    return command ? `command ${phase}: ${command}` : `command ${phase}`;
  }

  if (payloadType === 'message') {
    const preview = extractPayloadTextPreview(payload, options);
    return preview ? `agent message: ${preview}` : 'agent message';
  }

  if (payloadType === 'reasoning') {
    if (!options.showReasoning) return status ? `reasoning ${status}` : 'reasoning';
    const preview = extractPayloadTextPreview(payload, options);
    return preview ? `reasoning: ${preview}` : status ? `reasoning ${status}` : 'reasoning';
  }

  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const toolName = extractItemToolName(payload) || normalizeWhitespace(payload.name || payload.tool_name || payload.call?.name || 'tool');
    const detail = summarizeKnownArgObject(extractToolCallArguments(payload) || payload, options);
    const phase = status || 'updated';
    return detail ? `tool ${toolName} ${phase}: ${detail}` : `tool ${toolName} ${phase}`;
  }

  return '';
}

export function summarizeCodexEvent(ev, options = {}) {
  const previewChars = Math.max(60, Number(options.previewChars || DEFAULT_PREVIEW_CHARS));
  const showReasoning = Boolean(options.showReasoning);
  const opts = { previewChars, showReasoning };

  if (!ev || typeof ev !== 'object') return 'received event';

  const rawType = normalizeWhitespace(ev.type || '');
  if (!rawType) return 'received event';

  const type = normalizeEventType(rawType);
  const payload = extractEventPayload(ev);

  if (type === 'response_item' && payload) {
    const summary = summarizeResponseItem(payload, opts);
    if (summary) return summary;
  }

  if (type.endsWith('_delta')) {
    const delta = extractDeltaTextPreview(ev, payload, opts);
    if (type.includes('reasoning')) {
      if (!showReasoning) return 'reasoning delta';
      return delta ? `reasoning: ${delta}` : 'reasoning delta';
    }
    if (type.includes('output_text') || type.includes('message') || type.includes('content_part')) {
      return delta ? `agent message: ${delta}` : 'agent message delta';
    }
    return delta ? `${prettifyEventType(rawType)}: ${delta}` : prettifyEventType(rawType);
  }

  switch (type) {
    case 'thread_started':
      return ev.thread_id ? `session started: ${ev.thread_id}` : 'session started';
    case 'turn_started':
      return 'turn started';
    case 'turn_completed': {
      const input = extractInputTokensFromUsage(ev.usage);
      return input === null ? 'turn completed' : `turn completed (input tokens: ${input})`;
    }
    case 'error': {
      let detail = '';
      if (typeof ev.error === 'string') {
        detail = ev.error;
      } else {
        try {
          detail = JSON.stringify(ev.error);
        } catch {
          detail = String(ev.error || 'unknown');
        }
      }
      return `error: ${truncate(String(detail || 'unknown'), previewChars)}`;
    }
    case 'item_started':
    case 'item_completed': {
      const item = ev.item || {};
      const action = type === 'item_started' ? 'started' : 'completed';
      const itemType = normalizeEventType(item.type || 'item');

      if (itemType === 'agent_message') {
        const preview = extractEventTextPreview(item, { previewChars });
        return preview ? `agent message ${action}: ${preview}` : `agent message ${action}`;
      }

      if (itemType === 'reasoning') {
        if (!showReasoning) return `reasoning ${action}`;
        const preview = extractEventTextPreview(item, { previewChars });
        return preview ? `reasoning ${action}: ${preview}` : `reasoning ${action}`;
      }

      if (itemType === 'web_search_call') {
        const detail = extractWebSearchActionSummary(item.action || item, opts);
        return detail ? `web search ${action}: ${detail}` : `web search ${action}`;
      }

      if (itemType === 'local_shell_call') {
        const command = extractCommandPreview(item, opts);
        return command ? `command ${action}: ${command}` : `command ${action}`;
      }

      const toolName = extractItemToolName(item);
      if (toolName) {
        const detail = summarizeKnownArgObject(extractToolCallArguments(item) || item, opts);
        return detail ? `tool ${toolName} ${action}: ${detail}` : `tool ${toolName} ${action}`;
      }

      const preview = extractEventTextPreview(item, { previewChars });
      if (preview) return `${itemType} ${action}: ${preview}`;
      return `${itemType} ${action}`;
    }
    default:
      break;
  }

  if (type.startsWith('web_search_')) {
    const detail = extractWebSearchActionSummary(ev, opts) || extractWebSearchActionSummary(payload || {}, opts);
    const phase = type.endsWith('completed') || type.endsWith('end')
      ? 'completed'
      : type.endsWith('begin') || type.endsWith('started')
        ? 'started'
        : 'updated';
    return detail ? `web search ${phase}: ${detail}` : `web search ${phase}`;
  }

  if (type.startsWith('exec_command_')) {
    const command = extractCommandPreview(ev, opts) || extractCommandPreview(payload || {}, opts);
    const phase = type.endsWith('end') ? 'completed' : 'started';
    return command ? `command ${phase}: ${command}` : `command ${phase}`;
  }

  return prettifyEventType(rawType);
}

function pickFirstRawText(values) {
  if (!Array.isArray(values)) return '';
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.replace(/\r/g, '').trim();
    if (text) return text;
  }
  return '';
}

function pickFirstRawTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const text = pickFirstRawText([
      part.delta,
      part.text,
      part.output_text,
      part.input_text,
      part.reasoning_text,
    ]);
    if (text) return text;
  }
  return '';
}

export function extractRawProgressTextFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const type = normalizeEventType(ev.type || '');
  const payload = extractEventPayload(ev);
  const item = ev.item && typeof ev.item === 'object' ? ev.item : null;

  if (type.endsWith('_delta')) {
    const text = pickFirstRawText([
      ev.delta,
      ev.text_delta,
      ev.output_text_delta,
      ev.reasoning_delta,
      payload?.delta,
      payload?.text_delta,
      payload?.output_text_delta,
      payload?.reasoning_delta,
      payload?.text,
    ]) || pickFirstRawTextFromContent(payload?.content);
    return text || '';
  }

  if (type === 'item_completed' || type === 'item_started') {
    const itemType = normalizeEventType(item?.type || '');
    if (itemType === 'agent_message') {
      const text = pickFirstRawText([item?.text]) || pickFirstRawTextFromContent(item?.content);
      if (text) return text;
      return '';
    }
    if (itemType === 'reasoning') {
      const text = pickFirstRawText([item?.text]) || pickFirstRawTextFromContent(item?.content);
      if (text) return text;
    }
    if (itemType === 'message') {
      const text = pickFirstRawTextFromContent(item?.content);
      if (text) return text;
    }
    return '';
  }

  if (type === 'response_item' && payload && typeof payload === 'object') {
    const payloadType = normalizeEventType(payload.type || '');
    if (payloadType === 'reasoning') {
      const text = pickFirstRawText([payload.text]) || pickFirstRawTextFromContent(payload.content);
      if (text) return text;
      return '';
    }
    if (payloadType === 'message') {
      const text = pickFirstRawTextFromContent(payload.content);
      if (text) return text;
      return '';
    }
    if (payloadType === 'agent_message') {
      const text = pickFirstRawText([payload.text]) || pickFirstRawTextFromContent(payload.content);
      if (text) return text;
      return '';
    }
  }

  return '';
}

export function extractEventTextPreview(item, options = {}) {
  const previewChars = Math.max(60, Number(options.previewChars || DEFAULT_PREVIEW_CHARS));
  const raw = typeof item?.text === 'string'
    ? item.text
    : Array.isArray(item?.content)
      ? item.content
        .map((x) => (typeof x?.text === 'string'
          ? x.text
          : typeof x?.output_text === 'string'
            ? x.output_text
            : typeof x?.input_text === 'string'
              ? x.input_text
              : ''))
        .join(' ')
      : '';
  const normalized = normalizeWhitespace(raw);
  if (!normalized) return '';
  return truncate(normalized, previewChars);
}

export function cloneProgressPlan(planState, options = {}) {
  const previewChars = Math.max(60, Number(options.previewChars || DEFAULT_PREVIEW_CHARS));
  if (!planState || typeof planState !== 'object' || !Array.isArray(planState.steps)) return null;
  const steps = planState.steps
    .map((item) => ({
      status: normalizePlanStatus(item?.status),
      step: truncate(normalizeWhitespace(item?.step || ''), previewChars),
    }))
    .filter((item) => item.step);
  if (!steps.length) return null;

  const completed = steps.filter((item) => item.status === 'completed').length;
  const inProgress = steps.filter((item) => item.status === 'in_progress').length;
  return {
    explanation: truncate(normalizeWhitespace(planState.explanation || ''), previewChars),
    steps,
    total: steps.length,
    completed,
    inProgress,
  };
}

export function normalizePlanStatus(value) {
  const raw = normalizeWhitespace(value).toLowerCase();
  if (!raw) return 'pending';
  if (['completed', 'complete', 'done', 'finished', 'success', 'ok'].includes(raw)) return 'completed';
  if (['in_progress', 'in-progress', 'progress', 'running', 'active', 'doing', 'current'].includes(raw)) return 'in_progress';
  if (['pending', 'todo', 'not_started', 'queued', 'planned', 'next'].includes(raw)) return 'pending';
  return 'pending';
}

function normalizePlanEntries(raw, options = {}) {
  const previewChars = Math.max(60, Number(options.previewChars || DEFAULT_PREVIEW_CHARS));
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const step = normalizeWhitespace(
      item.step || item.title || item.task || item.name || item.label || '',
    );
    if (!step) continue;
    out.push({
      status: normalizePlanStatus(item.status || item.state || item.phase),
      step: truncate(step, previewChars),
    });
  }
  return out;
}

function buildPlanStateFromUnknown(raw, options = {}, depth = 0) {
  if (depth > 3 || raw === null || raw === undefined) return null;

  if (typeof raw === 'string') {
    const parsed = parseJsonMaybe(raw);
    return parsed ? buildPlanStateFromUnknown(parsed, options, depth + 1) : null;
  }

  if (Array.isArray(raw)) {
    const direct = normalizePlanEntries(raw, options);
    if (direct.length) return cloneProgressPlan({ explanation: '', steps: direct }, options);
    for (const item of raw) {
      const nested = buildPlanStateFromUnknown(item, options, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  if (typeof raw !== 'object') return null;

  const direct = normalizePlanEntries(Array.isArray(raw.plan) ? raw.plan : raw.steps, options);
  if (direct.length) {
    return cloneProgressPlan({
      explanation: raw.explanation || raw.summary || raw.note || '',
      steps: direct,
    }, options);
  }

  const keys = ['arguments', 'input', 'output', 'result', 'data', 'payload', 'value', 'content'];
  for (const key of keys) {
    if (!(key in raw)) continue;
    const nested = buildPlanStateFromUnknown(raw[key], options, depth + 1);
    if (nested) return nested;
  }

  return null;
}

export function extractPlanStateFromEvent(ev, options = {}) {
  if (!ev || typeof ev !== 'object') return null;
  const item = ev.item && typeof ev.item === 'object' ? ev.item : null;
  const payload = extractEventPayload(ev);
  const candidates = [
    ev.plan,
    ev.result,
    ev.output,
    ev.data,
    ev.payload,
    payload?.plan,
    payload?.result,
    payload?.output,
    payload?.input,
    payload?.call?.arguments,
    payload?.call?.args,
    payload?.content,
    item?.plan,
    item?.result,
    item?.output,
    item?.input,
    item?.call?.arguments,
    item?.call?.args,
    item?.content,
  ];

  for (const candidate of candidates) {
    const plan = buildPlanStateFromUnknown(candidate, options);
    if (plan) return plan;
  }

  const toolName = extractItemToolName(item || payload || {});
  if (toolName && toolName.toLowerCase().includes('update_plan')) {
    return buildPlanStateFromUnknown(item?.call?.arguments || payload?.call?.arguments, options);
  }
  return null;
}

function isCompletedLikeEvent(type) {
  return type === 'item_completed'
    || type.endsWith('_completed')
    || type.endsWith('_end')
    || type === 'turn_completed';
}

function summarizeCompletedPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return '';
  const payloadType = normalizeEventType(payload.type || '');
  if (payloadType === 'message' || payloadType === 'reasoning') return '';

  if (payloadType === 'web_search_call') {
    const detail = extractWebSearchActionSummary(payload.action || payload, options);
    return detail ? `web search: ${detail}` : 'web search';
  }

  if (payloadType === 'local_shell_call') {
    const command = extractCommandPreview(payload, options);
    return command ? `command: ${command}` : 'command completed';
  }

  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const toolName = extractItemToolName(payload) || normalizeWhitespace(payload.name || payload.tool_name || 'tool');
    if (toolName.toLowerCase().includes('update_plan')) return '';
    const detail = summarizeKnownArgObject(extractToolCallArguments(payload) || payload, options);
    return detail ? `${toolName}: ${detail}` : `tool ${toolName}`;
  }

  const preview = extractPayloadTextPreview(payload, options);
  if (preview) return `${payloadType || 'item'}: ${preview}`;
  return payloadType ? `${payloadType} completed` : '';
}

export function extractCompletedStepFromEvent(ev, options = {}) {
  const previewChars = Math.max(60, Number(options.previewChars || DEFAULT_PREVIEW_CHARS));
  const opts = { previewChars };

  if (!ev || typeof ev !== 'object') return '';
  const type = normalizeEventType(ev.type || '');
  const payload = extractEventPayload(ev);

  if (type === 'response_item' && payload) {
    const status = normalizeStatus(payload.status || '');
    if (status === 'completed') return summarizeCompletedPayload(payload, opts);
    return '';
  }

  if (type.startsWith('web_search_') && isCompletedLikeEvent(type)) {
    const detail = extractWebSearchActionSummary(ev, opts) || extractWebSearchActionSummary(payload || {}, opts);
    return detail ? `web search: ${detail}` : 'web search';
  }

  if (type !== 'item_completed') {
    if (isCompletedLikeEvent(type)) {
      const command = extractCommandPreview(ev, opts) || extractCommandPreview(payload || {}, opts);
      if (command) return `command: ${command}`;
    }
    return '';
  }

  const item = ev.item || {};
  const itemType = normalizeEventType(item.type || '');
  if (!itemType || itemType === 'agent_message' || itemType === 'reasoning') return '';

  if (itemType === 'web_search_call') {
    const detail = extractWebSearchActionSummary(item.action || item, opts);
    return detail ? `web search: ${detail}` : 'web search';
  }

  if (itemType === 'local_shell_call') {
    const command = extractCommandPreview(item, opts);
    return command ? `command: ${command}` : 'command completed';
  }

  const toolName = extractItemToolName(item);
  if (toolName) {
    if (toolName.toLowerCase().includes('update_plan')) return '';
    const detail = summarizeKnownArgObject(extractToolCallArguments(item) || item, opts);
    return detail ? `${toolName}: ${detail}` : `tool ${toolName}`;
  }

  const preview = extractEventTextPreview(item, opts);
  if (preview) return `${itemType}: ${preview}`;
  return `${itemType} completed`;
}

export function appendCompletedStep(list, stepText, options = {}) {
  const previewChars = Math.max(60, Number(options.previewChars || DEFAULT_PREVIEW_CHARS));
  const doneStepsMax = Math.max(1, Number(options.doneStepsMax || DEFAULT_DONE_STEPS_MAX));

  const text = normalizeWhitespace(stepText);
  if (!text) return;

  const normalized = truncate(text, previewChars);
  const key = normalized.toLowerCase();
  const existing = list.findIndex((item) => normalizeWhitespace(String(item || '')).toLowerCase() === key);
  if (existing >= 0) list.splice(existing, 1);
  list.push(normalized);

  const maxKeep = Math.max(doneStepsMax + 2, doneStepsMax * 3);
  if (list.length > maxKeep) {
    list.splice(0, list.length - maxKeep);
  }
}

export function appendRecentActivity(list, activityText, options = {}) {
  if (!Array.isArray(list)) return;
  const previewChars = Math.max(60, Number(options.previewChars || DEFAULT_PREVIEW_CHARS));
  const maxSteps = Math.max(1, Number(options.maxSteps || DEFAULT_ACTIVITY_MAX));
  const preserveWhitespace = options.preserveWhitespace === true;
  const truncateText = options.truncateText !== false;
  const text = preserveWhitespace
    ? String(activityText || '').replace(/\r/g, '').trim()
    : normalizeWhitespace(activityText);
  if (!text) return;

  const normalized = truncateText ? truncate(text, previewChars) : text;
  const key = normalizeWhitespace(normalized).toLowerCase();
  const existing = list.findIndex((item) => String(item || '').toLowerCase() === key);
  if (existing >= 0) list.splice(existing, 1);
  list.push(normalized);

  const maxKeep = Math.max(maxSteps + 3, maxSteps * 4);
  if (list.length > maxKeep) {
    list.splice(0, list.length - maxKeep);
  }
}

export function formatRecentActivitiesSummary(activities, options = {}) {
  if (!Array.isArray(activities) || !activities.length) return '';
  const maxSteps = Math.max(1, Number(options.maxSteps || DEFAULT_ACTIVITY_MAX));
  return activities.slice(-maxSteps).join(' | ');
}

export function renderRecentActivitiesLines(activities, options = {}) {
  if (!Array.isArray(activities) || !activities.length) return [];
  const maxSteps = Math.max(1, Number(options.maxSteps || DEFAULT_ACTIVITY_MAX));
  const visible = activities.slice(-maxSteps);
  const lines = [];
  for (let i = 0; i < visible.length; i += 1) {
    lines.push(`• activity ${i + 1}: ${visible[i]}`);
  }
  return lines;
}

export function formatProgressPlanSummary(planState) {
  if (!planState || !Array.isArray(planState.steps) || !planState.steps.length) return '';
  const inProgressPart = planState.inProgress > 0 ? `, ${planState.inProgress} in progress` : '';
  return `${planState.completed}/${planState.total} completed${inProgressPart}`;
}

export function renderProgressPlanLines(planState, maxLines = DEFAULT_PLAN_MAX_LINES) {
  if (!planState || !Array.isArray(planState.steps) || !planState.steps.length) return [];

  const lines = [];
  const summary = formatProgressPlanSummary(planState);
  lines.push(summary ? `• plan: ${summary}` : '• plan: received');
  if (planState.explanation) lines.push(`  note: ${planState.explanation}`);

  const limit = Math.max(1, maxLines);
  const visible = planState.steps.slice(0, limit);
  for (const step of visible) {
    const icon = step.status === 'completed'
      ? '✓'
      : step.status === 'in_progress'
        ? '…'
        : '○';
    lines.push(`  ${icon} ${step.step}`);
  }
  if (planState.steps.length > visible.length) {
    lines.push(`  … +${planState.steps.length - visible.length} more`);
  }
  return lines;
}

export function formatCompletedStepsSummary(steps, maxSteps = DEFAULT_DONE_STEPS_MAX) {
  if (!Array.isArray(steps) || !steps.length) return '';
  const limit = Math.max(1, maxSteps);
  const visible = steps.slice(-limit);
  return visible.join(' | ');
}

export function renderCompletedStepsLines(steps, maxSteps = DEFAULT_DONE_STEPS_MAX) {
  const summary = formatCompletedStepsSummary(steps, maxSteps);
  if (!summary) return [];
  return [`• completed steps: ${summary}`];
}

function toOptionalInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function extractInputTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;

  const directKeys = [
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
    'input_token_count',
    'prompt_token_count',
  ];

  for (const key of directKeys) {
    const n = toOptionalInt(usage[key]);
    if (n !== null) return n;
  }

  const queue = [usage];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') {
        queue.push(value);
        continue;
      }

      const n = toOptionalInt(value);
      if (n === null) continue;
      if (/input.*token|token.*input|prompt.*token|token.*prompt/i.test(key)) {
        return n;
      }
    }
  }

  return null;
}
