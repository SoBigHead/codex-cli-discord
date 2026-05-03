export const DEFAULT_EXTRA_INFO_TEMPLATE = '[Via agents-in-discord; discord_thread={thread}; parent={parent}]';
const PER_MESSAGE_PLACEHOLDER_RE = /\{(?:msg|message|message_id)\}/i;

export function normalizeExtraInfoTemplate(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

export function normalizeExtraInfoEnabled(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'enable', 'enabled', 'yes', '开启', '启用', '打开'].includes(raw)) return true;
  if (['0', 'false', 'off', 'disable', 'disabled', 'no', '关闭', '禁用'].includes(raw)) return false;
  return null;
}

export function buildExtraInfoValues({ message = null, channel = null, key = '', messageId = '' } = {}) {
  const currentChannel = channel || message?.channel || null;
  return {
    thread: String(currentChannel?.id || key || '').trim(),
    parent: String(currentChannel?.parentId || '').trim(),
    msg: String(messageId || message?.id || '').trim(),
  };
}

function renderDefaultExtraInfoLine(values) {
  const parts = ['Via agents-in-discord'];
  if (values.thread) parts.push(`discord_thread=${values.thread}`);
  if (values.parent) parts.push(`parent=${values.parent}`);
  return `[${parts.join('; ')}]`;
}

export function extraInfoTemplateUsesPerMessageData(template) {
  const normalized = normalizeExtraInfoTemplate(template) || DEFAULT_EXTRA_INFO_TEMPLATE;
  return PER_MESSAGE_PLACEHOLDER_RE.test(normalized);
}

export function renderExtraInfoTemplate(template, values = {}) {
  const normalized = normalizeExtraInfoTemplate(template) || DEFAULT_EXTRA_INFO_TEMPLATE;
  if (normalized === DEFAULT_EXTRA_INFO_TEMPLATE) return renderDefaultExtraInfoLine(values);

  return normalized
    .replaceAll('{thread}', values.thread || '')
    .replaceAll('{thread_id}', values.thread || '')
    .replaceAll('{discord_thread}', values.thread || '')
    .replaceAll('{parent}', values.parent || '')
    .replaceAll('{parent_id}', values.parent || '')
    .replaceAll('{msg}', values.msg || '')
    .replaceAll('{message}', values.msg || '')
    .replaceAll('{message_id}', values.msg || '')
    .trim();
}

export function buildExtraInfoPromptLine({
  setting = null,
  message = null,
  channel = null,
  key = '',
  messageId = '',
} = {}) {
  if (setting?.enabled === false) return '';
  const values = buildExtraInfoValues({ message, channel, key, messageId });
  return renderExtraInfoTemplate(setting?.text || setting?.template || DEFAULT_EXTRA_INFO_TEMPLATE, values);
}

export function estimatePromptTokenCount(text) {
  const value = String(text || '');
  if (!value) return 0;

  let tokens = 0;
  let asciiRun = '';
  const flushAscii = () => {
    if (!asciiRun) return;
    tokens += Math.max(1, Math.ceil(asciiRun.length / 4));
    asciiRun = '';
  };

  for (const char of value) {
    if (/\s/.test(char)) {
      flushAscii();
      continue;
    }
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(char)) {
      flushAscii();
      tokens += 1;
      continue;
    }
    if (/[\x20-\x7e]/.test(char)) {
      asciiRun += char;
      continue;
    }
    flushAscii();
    tokens += 1;
  }
  flushAscii();
  return tokens;
}
