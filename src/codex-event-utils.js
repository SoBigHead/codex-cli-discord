function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePhase(value) {
  return normalizeWhitespace(value).toLowerCase().replace(/[.-]/g, '_');
}

function pickFirstText(values) {
  if (!Array.isArray(values)) return '';
  for (const value of values) {
    const text = normalizeWhitespace(value);
    if (text) return text;
  }
  return '';
}

function pickFirstTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const text = pickFirstText([
      part.text,
      part.output_text,
      part.input_text,
      part.reasoning_text,
      part.message,
    ]);
    if (text) return text;
  }
  return '';
}

function normalizeTextList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean);
}

function normalizeDedupeText(value) {
  return normalizeWhitespace(value).toLowerCase();
}

export function extractAgentMessageText(item) {
  if (!item || typeof item !== 'object') return '';
  return pickFirstText([
    item.text,
    item.message,
    item.output_text,
    item.input_text,
  ]) || pickFirstTextFromContent(item.content);
}

export function getAgentMessagePhase(item) {
  if (!item || typeof item !== 'object') return '';
  return normalizePhase(
    item.phase
      || item.message_phase
      || item.payload?.phase
      || item.metadata?.phase
      || '',
  );
}

export function isFinalAnswerLikeAgentMessage(item) {
  if (!item || typeof item !== 'object') return false;
  const phase = getAgentMessagePhase(item);
  return phase !== 'commentary';
}

export function composeFinalAnswerText({ messages = [], finalAnswerMessages = [] } = {}) {
  const preferred = normalizeTextList(finalAnswerMessages);
  if (preferred.length) return preferred.join('\n\n');

  const fallback = normalizeTextList(messages);
  if (!fallback.length) return '';
  return fallback[fallback.length - 1];
}

export function buildProgressEventDedupeKey({
  rawActivity = '',
  completedStep = '',
  planSummary = '',
  summaryStep = '',
} = {}) {
  const raw = normalizeDedupeText(rawActivity);
  if (raw) return `raw:${raw}`;

  const completed = normalizeDedupeText(completedStep);
  if (completed) return `completed:${completed}`;

  const plan = normalizeDedupeText(planSummary);
  if (plan) return `plan:${plan}`;

  const summary = normalizeDedupeText(summaryStep);
  if (summary) return `summary:${summary}`;

  return '';
}

export function createProgressEventDeduper({ ttlMs = 2500, maxKeys = 600 } = {}) {
  const ttl = Math.max(200, Number(ttlMs) || 2500);
  const max = Math.max(32, Number(maxKeys) || 600);
  const seenAt = new Map();

  return (key, now = Date.now()) => {
    const normalizedKey = normalizeDedupeText(key);
    if (!normalizedKey) return false;

    const previous = seenAt.get(normalizedKey);
    if (Number.isFinite(previous) && now - previous < ttl) {
      seenAt.set(normalizedKey, now);
      return true;
    }

    seenAt.set(normalizedKey, now);
    if (seenAt.size > max) {
      for (const [entryKey, entryAt] of seenAt) {
        if (now - entryAt >= ttl) seenAt.delete(entryKey);
        if (seenAt.size <= max) break;
      }
    }
    while (seenAt.size > max) {
      const oldestKey = seenAt.keys().next().value;
      if (!oldestKey) break;
      seenAt.delete(oldestKey);
    }

    return false;
  };
}
