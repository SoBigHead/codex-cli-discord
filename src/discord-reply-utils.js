const REPLY_TO_SYSTEM_MESSAGE_CODE = 'REPLIES_CANNOT_REPLY_TO_SYSTEM_MESSAGE';
const REPLY_TO_SYSTEM_MESSAGE_HINT = 'cannot reply to a system message';
const MESSAGE_REFERENCE_HINT = 'message_reference';
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

function collectErrorCodes(node, out = new Set(), depth = 0) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectErrorCodes(item, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;

  const code = node.code;
  if (typeof code === 'string' && code.trim()) {
    out.add(code.trim());
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      collectErrorCodes(value, out, depth + 1);
    }
  }
  return out;
}

function hasDiscordValidationCode(err, code) {
  const direct = Number(err?.code);
  const raw = Number(err?.rawError?.code);
  return direct === code || raw === code;
}

function sanitizeReplyMetadata(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (!('message_reference' in payload) && !('messageReference' in payload) && !('reply' in payload)) {
    return payload;
  }

  const next = { ...payload };
  delete next.message_reference;
  delete next.messageReference;
  delete next.reply;
  return next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientDiscordNetworkError(err) {
  if (!err) return false;
  const code = String(err?.code || err?.cause?.code || '').trim().toUpperCase();
  if (code && TRANSIENT_NETWORK_ERROR_CODES.has(code)) return true;

  const status = Number(err?.status || err?.rawError?.status);
  if (Number.isFinite(status) && status >= 500 && status <= 599) return true;

  const text = [
    String(err?.message || ''),
    String(err?.rawError?.message || ''),
    String(err?.cause?.message || ''),
  ].join(' ').toLowerCase();
  return text.includes('client network socket disconnected before secure tls connection was established')
    || text.includes('socket hang up')
    || text.includes('fetch failed');
}

export async function withDiscordNetworkRetry(action, {
  logger = console,
  label = 'discord call',
  maxAttempts = 3,
  baseDelayMs = 350,
} = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (err) {
      lastErr = err;
      if (!isTransientDiscordNetworkError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const waitMs = baseDelayMs * attempt;
      logger.warn(`⚠️ ${label} transient network error (attempt ${attempt}/${maxAttempts}): ${err?.message || err}; retry in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

export function isReplyToSystemMessageError(err) {
  if (!err) return false;

  const text = [
    String(err.message || ''),
    String(err.rawError?.message || ''),
  ].join(' ').toLowerCase();
  if (text.includes(REPLY_TO_SYSTEM_MESSAGE_CODE.toLowerCase())) return true;
  if (text.includes(REPLY_TO_SYSTEM_MESSAGE_HINT)) return true;

  const nestedCodes = collectErrorCodes(err.rawError?.errors);
  if (nestedCodes.has(REPLY_TO_SYSTEM_MESSAGE_CODE)) return true;

  // Discord may change error payload shape; treat message_reference + 50035 as same class.
  return hasDiscordValidationCode(err, 50035) && text.includes(MESSAGE_REFERENCE_HINT);
}

export async function safeReply(message, payload, { logger = console } = {}) {
  const channel = message?.channel;
  const channelPayload = sanitizeReplyMetadata(payload);

  if (message?.system) {
    if (!channel || typeof channel.send !== 'function') {
      throw new Error('Cannot send message: channel.send is unavailable for system message fallback');
    }
    logger.warn(`⚠️ Message ${message?.id || '(unknown)'} is a system message, sending without reply reference`);
    return await withDiscordNetworkRetry(
      () => channel.send(channelPayload),
      { logger, label: 'channel.send (system message)' },
    );
  }

  try {
    return await withDiscordNetworkRetry(
      () => message.reply(payload),
      { logger, label: 'message.reply' },
    );
  } catch (err) {
    if (!isReplyToSystemMessageError(err)) throw err;
    if (!channel || typeof channel.send !== 'function') throw err;

    logger.warn(`⚠️ Cannot reply to system message ${message?.id || '(unknown)'}, fallback to channel.send`);
    return await withDiscordNetworkRetry(
      () => channel.send(channelPayload),
      { logger, label: 'channel.send (safeReply fallback)' },
    );
  }
}
