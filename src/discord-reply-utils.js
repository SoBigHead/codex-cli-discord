const REPLY_TO_SYSTEM_MESSAGE_CODE = 'REPLIES_CANNOT_REPLY_TO_SYSTEM_MESSAGE';
const REPLY_TO_SYSTEM_MESSAGE_HINT = 'cannot reply to a system message';
const MESSAGE_REFERENCE_HINT = 'message_reference';
const TOKEN_MISSING_HINT = 'expected token to be set for this request';
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

export function isStaleDiscordClientError(err) {
  if (!err) return false;
  const text = [
    String(err?.message || ''),
    String(err?.rawError?.message || ''),
    String(err?.cause?.message || ''),
  ].join(' ').toLowerCase();
  return text.includes(TOKEN_MISSING_HINT);
}

export function isExpiredInteractionWebhookError(err) {
  if (!err) return false;
  if (hasDiscordValidationCode(err, 50027)) return true;

  const text = [
    String(err?.message || ''),
    String(err?.rawError?.message || ''),
    String(err?.cause?.message || ''),
  ].join(' ').toLowerCase();
  return text.includes('invalid webhook token');
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

function getChannelLike(target) {
  if (!target || typeof target !== 'object') return null;
  if (typeof target.send === 'function') return target;
  if (target.channel && typeof target.channel.send === 'function') return target.channel;
  return null;
}

function getChannelId(target) {
  const direct = String(target?.channelId || target?.id || '').trim();
  if (direct) return direct;
  const nested = String(target?.channel?.id || '').trim();
  return nested || '';
}

async function resolveLiveChannel(target, getActiveClient) {
  const client = typeof getActiveClient === 'function' ? getActiveClient() : null;
  if (!client) return null;

  const channelId = getChannelId(target);
  if (!channelId) return null;

  const cached = client.channels?.cache?.get?.(channelId);
  if (cached) return cached;

  if (typeof client.channels?.fetch !== 'function') return null;
  try {
    return await client.channels.fetch(channelId);
  } catch {
    return null;
  }
}

async function resolveLiveReplyTarget(message, getActiveClient) {
  const channel = await resolveLiveChannel(message, getActiveClient);
  if (!channel) return { channel: null, message: null };

  const messageId = String(message?.id || '').trim();
  if (!messageId || typeof channel.messages?.fetch !== 'function') {
    return { channel, message: null };
  }

  try {
    const liveMessage = await channel.messages.fetch(messageId);
    return { channel, message: liveMessage };
  } catch {
    return { channel, message: null };
  }
}

async function sendWithChannel(channel, payload, { logger = console, label = 'channel.send' } = {}) {
  if (!channel || typeof channel.send !== 'function') {
    throw new Error('Cannot send message: channel.send is unavailable');
  }
  return withDiscordNetworkRetry(
    () => channel.send(payload),
    { logger, label },
  );
}

async function recoverReplyWithLiveClient(message, payload, channelPayload, {
  logger = console,
  getActiveClient,
} = {}) {
  const target = await resolveLiveReplyTarget(message, getActiveClient);
  if (target.message && typeof target.message.reply === 'function') {
    try {
      return await withDiscordNetworkRetry(
        () => target.message.reply(payload),
        { logger, label: 'message.reply (recovered)' },
      );
    } catch (err) {
      if (!isReplyToSystemMessageError(err)) throw err;
    }
  }

  if (target.channel) {
    return sendWithChannel(target.channel, channelPayload, {
      logger,
      label: 'channel.send (recovered)',
    });
  }

  return null;
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

export async function safeChannelSend(target, payload, {
  logger = console,
  getActiveClient,
} = {}) {
  const channel = getChannelLike(target);
  if (!channel) {
    throw new Error('Cannot send message: channel.send is unavailable');
  }

  try {
    return await sendWithChannel(channel, payload, { logger, label: 'channel.send' });
  } catch (err) {
    if (!isStaleDiscordClientError(err)) throw err;

    const liveChannel = await resolveLiveChannel(target, getActiveClient);
    if (!liveChannel || liveChannel === channel) throw err;
    return sendWithChannel(liveChannel, payload, {
      logger,
      label: 'channel.send (recovered)',
    });
  }
}

export async function safeReply(message, payload, {
  logger = console,
  getActiveClient,
} = {}) {
  const channelPayload = sanitizeReplyMetadata(payload);

  if (message?.system) {
    logger.warn(`⚠️ Message ${message?.id || '(unknown)'} is a system message, sending without reply reference`);
    return safeChannelSend(message, channelPayload, {
      logger,
      getActiveClient,
    });
  }

  try {
    return await withDiscordNetworkRetry(
      () => message.reply(payload),
      { logger, label: 'message.reply' },
    );
  } catch (err) {
    if (isReplyToSystemMessageError(err)) {
      logger.warn(`⚠️ Cannot reply to system message ${message?.id || '(unknown)'}, fallback to channel.send`);
      return safeChannelSend(message, channelPayload, {
        logger,
        getActiveClient,
      });
    }

    if (isExpiredInteractionWebhookError(err)) {
      logger.warn(`⚠️ Interaction webhook expired for ${message?.id || '(unknown)'}, fallback to channel.send`);
      return safeChannelSend(message, channelPayload, {
        logger,
        getActiveClient,
      });
    }

    if (!isStaleDiscordClientError(err)) throw err;

    const recovered = await recoverReplyWithLiveClient(message, payload, channelPayload, {
      logger,
      getActiveClient,
    });
    if (recovered) return recovered;
    throw err;
  }
}
