import { randomUUID } from 'node:crypto';

const FORKABLE_PROVIDERS = new Set(['codex', 'claude']);

function normalizeForkProvider(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || 'codex';
}

export function providerSupportsNativeFork(provider) {
  return FORKABLE_PROVIDERS.has(normalizeForkProvider(provider));
}

export function normalizeForkSessionId(value) {
  const text = String(value || '').trim();
  return text || null;
}

export function normalizeForkThreadName(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 100) : '';
}

function normalizeForkWorkspaceDir(value) {
  const text = String(value || '').trim();
  return text || null;
}

function shortenId(value) {
  const text = normalizeForkSessionId(value);
  if (!text) return 'new';
  return text.length <= 12 ? text : text.slice(0, 8);
}

function getForkRequesterId(source) {
  return String(source?.user?.id || source?.author?.id || '').trim() || null;
}

export function parseForkTextInput(input) {
  return { threadName: normalizeForkThreadName(input) };
}

export function formatForkThreadName({ forkedSessionId, parentSessionId, provider = 'codex' } = {}) {
  const providerLabel = normalizeForkProvider(provider);
  const forkShort = shortenId(forkedSessionId);
  const parentShort = shortenId(parentSessionId);
  return `${providerLabel} fork ${forkShort} from ${parentShort}`.slice(0, 100);
}

function resolveThreadCreateChannel(channel) {
  if (channel?.threads && typeof channel.threads.create === 'function') return channel;
  if (typeof channel?.isThread === 'function' && channel.isThread() && channel.parent?.threads && typeof channel.parent.threads.create === 'function') {
    return channel.parent;
  }
  if (channel?.parent?.threads && typeof channel.parent.threads.create === 'function') return channel.parent;
  return null;
}

export function canCreateDiscordForkThread(source) {
  return Boolean(resolveThreadCreateChannel(source?.channel));
}

async function createDiscordForkThread(source, { parentSessionId, forkedSessionId, threadName = '', provider = 'codex' } = {}) {
  const targetChannel = resolveThreadCreateChannel(source?.channel);
  if (!targetChannel) {
    throw new Error('当前频道不支持创建 Discord thread，无法放置 fork。');
  }
  const requestedName = normalizeForkThreadName(threadName);
  const thread = await targetChannel.threads.create({
    name: requestedName || formatForkThreadName({ forkedSessionId, parentSessionId, provider }),
    autoArchiveDuration: 1440,
    reason: `${normalizeForkProvider(provider)} fork from ${parentSessionId}`,
  });
  try {
    await thread.join?.();
  } catch {
  }
  return thread;
}

export function createSyntheticForkMessage(source, childThread) {
  const author = source?.user || source?.author || {};
  const client = source?.client || source?.channel?.client || childThread?.client || null;
  const reactions = {
    cache: {
      get: () => ({ users: { remove: async () => {} } }),
    },
  };
  return {
    id: String(source?.id || `fork-${Date.now()}`),
    channelId: childThread?.id,
    channel: childThread,
    author,
    client,
    system: false,
    content: '',
    attachments: { size: 0 },
    reactions,
    react: async () => {},
    reply: async (payload) => childThread.send(payload),
  };
}

function formatForkProviderLabel(provider) {
  const normalizedProvider = normalizeForkProvider(provider);
  if (normalizedProvider === 'claude') return 'Claude';
  if (normalizedProvider === 'antigravity') return 'Antigravity';
  return 'Codex';
}

function formatForkOriginNotice({ userId, provider, parentSessionId, forkedSessionId, language = 'zh' } = {}) {
  const mention = userId ? `<@${userId}> ` : '';
  const providerLabel = formatForkProviderLabel(provider);
  if (language === 'en') {
    return `${mention}This thread was forked from ${providerLabel} session \`${parentSessionId}\`. Fork session: \`${forkedSessionId}\`.`;
  }
  return `${mention}这是从 ${providerLabel} session \`${parentSessionId}\` fork 过来的。fork session：\`${forkedSessionId}\`。`;
}

async function sendForkOriginNotice(childThread, {
  source,
  provider,
  parentSessionId,
  forkedSessionId,
  language,
} = {}) {
  if (typeof childThread?.send !== 'function') {
    return { ok: false, skipped: true, error: 'child thread cannot send messages' };
  }
  const userId = getForkRequesterId(source);
  const payload = {
    content: formatForkOriginNotice({
      userId,
      provider,
      parentSessionId,
      forkedSessionId,
      language,
    }),
  };
  if (userId) {
    payload.allowedMentions = { users: [userId] };
  }
  try {
    const message = await childThread.send(payload);
    return { ok: true, message, userId };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      userId,
      error: String(err?.message || err || 'unknown error'),
    };
  }
}

export async function createCodexForkThread({
  ...options
} = {}) {
  return createProviderForkThread({
    ...options,
    provider: 'codex',
  });
}

export async function createProviderForkThread({
  key,
  session,
  source,
  parentSessionId,
  threadName = '',
  prompt = '',
  provider = 'codex',
  getRuntimeSnapshot = () => ({ running: false, queued: 0 }),
  getSession,
  commandActions = {},
  forkCodexThread,
  enqueuePrompt,
  resolveSecurityContext,
  createThread = createDiscordForkThread,
  generateSessionId = randomUUID,
  resolveForkWorkspace = () => null,
} = {}) {
  const normalizedProvider = normalizeForkProvider(provider);
  const normalizedParentSessionId = normalizeForkSessionId(parentSessionId);
  if (!normalizedParentSessionId) {
    return { ok: false, reason: 'missing_parent_session' };
  }
  if (!providerSupportsNativeFork(normalizedProvider)) {
    return { ok: false, reason: 'fork_unsupported', provider: normalizedProvider };
  }
  const runtime = getRuntimeSnapshot(key) || {};
  if (runtime.running) {
    return { ok: false, reason: 'parent_running' };
  }
  if (!canCreateDiscordForkThread(source)) {
    return { ok: false, reason: 'thread_unavailable' };
  }
  if (normalizedProvider === 'codex' && typeof forkCodexThread !== 'function') {
    return { ok: false, reason: 'fork_unavailable' };
  }
  if (typeof getSession !== 'function') {
    throw new Error('getSession is required for provider fork');
  }
  if (typeof commandActions.bindForkedSession !== 'function') {
    throw new Error('bindForkedSession is required for provider fork');
  }

  const plannedForkedSessionId = normalizedProvider === 'claude'
    ? normalizeForkSessionId(generateSessionId())
    : null;
  if (normalizedProvider === 'claude' && !plannedForkedSessionId) {
    throw new Error('Claude fork did not receive a generated session id');
  }
  const forkWorkspaceDir = normalizedProvider === 'claude'
    ? normalizeForkWorkspaceDir(resolveForkWorkspace({
      provider: normalizedProvider,
      parentSessionId: normalizedParentSessionId,
      parentSession: session,
      source,
    }))
    : null;
  if (normalizedProvider === 'claude' && !forkWorkspaceDir) {
    return {
      ok: false,
      reason: 'fork_workspace_unavailable',
      provider: normalizedProvider,
      parentSessionId: normalizedParentSessionId,
    };
  }

  const childThread = await createThread(source, {
    parentSessionId: normalizedParentSessionId,
    forkedSessionId: plannedForkedSessionId,
    threadName,
    provider: normalizedProvider,
  });
  if (!childThread?.id) {
    throw new Error('Discord thread creation did not return a thread id');
  }

  let forkResult = null;
  let forkedSessionId = plannedForkedSessionId;
  if (normalizedProvider === 'codex') {
    try {
      forkResult = await forkCodexThread({
        threadId: normalizedParentSessionId,
      });
    } catch (err) {
      try {
        await childThread.delete?.('Codex fork failed before session binding');
      } catch {
      }
      throw err;
    }
    forkedSessionId = normalizeForkSessionId(forkResult?.threadId || forkResult?.thread?.id);
    if (!forkedSessionId) {
      try {
        await childThread.delete?.('Codex fork did not return a session id');
      } catch {
      }
      throw new Error('Codex fork did not return a session id');
    }
  }
  if (!normalizeForkThreadName(threadName) && typeof childThread.setName === 'function') {
    try {
      await childThread.setName(
        formatForkThreadName({ parentSessionId: normalizedParentSessionId, forkedSessionId, provider: normalizedProvider }),
        `${normalizedProvider} fork session assigned`,
      );
    } catch {
    }
  }

  const childSession = getSession(childThread.id, {
    channel: childThread,
    parentChannelId: key,
  });
  if (forkWorkspaceDir) {
    childSession.workspaceDir = forkWorkspaceDir;
  }
  const binding = commandActions.bindForkedSession(childSession, {
    sessionId: forkedSessionId,
    parentSessionId: normalizedParentSessionId,
    parentChannelId: key,
    provider: normalizedProvider,
    pendingForkFromSessionId: normalizedProvider === 'claude' ? normalizedParentSessionId : null,
  });
  const notice = await sendForkOriginNotice(childThread, {
    source,
    provider: normalizedProvider,
    parentSessionId: normalizedParentSessionId,
    forkedSessionId,
    language: session?.language || childSession?.language || 'zh',
  });

  const normalizedPrompt = String(prompt || '').trim();
  let promptQueue = null;
  if (normalizedPrompt) {
    if (typeof enqueuePrompt !== 'function') {
      promptQueue = { ok: false, enqueued: false, error: 'enqueuePrompt is unavailable' };
    } else {
      try {
        const syntheticMessage = createSyntheticForkMessage(source, childThread);
        const securityContext = typeof resolveSecurityContext === 'function'
          ? resolveSecurityContext(childThread, childSession)
          : null;
        promptQueue = await enqueuePrompt(syntheticMessage, childThread.id, normalizedPrompt, securityContext);
      } catch (err) {
        promptQueue = {
          ok: false,
          enqueued: false,
          error: String(err?.message || err || 'unknown error'),
        };
      }
    }
  }

  return {
    ok: true,
    provider: normalizedProvider,
    parentSessionId: normalizedParentSessionId,
    forkedSessionId,
    forkedFromId: normalizeForkSessionId(forkResult?.forkedFromId) || normalizedParentSessionId,
    childThread,
    childSession,
    binding,
    notice,
    promptQueue,
  };
}

export function formatCodexForkResult(result, language = 'zh') {
  return formatProviderForkResult(result, language);
}

export function formatProviderForkResult(result, language = 'zh') {
  const providerLabel = formatForkProviderLabel(result?.provider || 'codex');
  if (!result?.ok) {
    if (result?.reason === 'missing_parent_session') {
      return language === 'en'
        ? `❌ No ${providerLabel} session is bound here yet. Run one task first.`
        : `❌ 当前频道还没有绑定 ${providerLabel} session。先跑一轮。`;
    }
    if (result?.reason === 'parent_running') {
      return language === 'en'
        ? '⏳ The parent channel is running. Fork after the current task finishes.'
        : '⏳ 父频道正在运行任务，等这轮结束后再 fork。';
    }
    if (result?.reason === 'fork_unsupported') {
      return language === 'en'
        ? `❌ Native fork is unavailable for ${providerLabel}.`
        : `❌ ${providerLabel} 不支持原生 fork。`;
    }
    if (result?.reason === 'fork_unavailable') {
      return language === 'en'
        ? `❌ ${providerLabel} native fork is unavailable in this runtime.`
        : `❌ 当前运行环境没有接入 ${providerLabel} 原生 fork。`;
    }
    if (result?.reason === 'fork_workspace_unavailable') {
      return language === 'en'
        ? `❌ Cannot resolve the parent ${providerLabel} workspace for fork.`
        : `❌ 无法解析父 ${providerLabel} session 的工作目录，fork 已取消。`;
    }
    if (result?.reason === 'thread_unavailable') {
      return language === 'en'
        ? '❌ This Discord channel cannot create a fork thread.'
        : '❌ 当前 Discord 频道不能创建 fork thread。';
    }
    return language === 'en' ? `❌ ${providerLabel} fork failed.` : `❌ ${providerLabel} fork 失败。`;
  }

  const channelLabel = result.childThread?.id ? `<#${result.childThread.id}>` : result.childThread?.name || '(new thread)';
  const promptQueued = result.promptQueue?.enqueued;
  const queuedAhead = Number(result.promptQueue?.queuedAhead || 0);
  const promptError = String(result.promptQueue?.error || '').trim();
  const noticeError = result.notice && !result.notice.ok && !result.notice.skipped
    ? String(result.notice.error || '').trim()
    : '';
  if (language === 'en') {
    return [
      promptError
        ? `⚠️ Created ${providerLabel} fork in ${channelLabel}, but the prompt was not queued`
        : `✅ Created ${providerLabel} fork in ${channelLabel}`,
      `• fork session: \`${result.forkedSessionId}\``,
      `• parent session: \`${result.parentSessionId}\``,
      promptQueued ? `• prompt queued in fork${queuedAhead > 0 ? ` (${queuedAhead} ahead)` : ''}` : null,
      promptError ? `• error: ${promptError}` : null,
      noticeError ? `• notice failed: ${noticeError}` : null,
    ].filter(Boolean).join('\n');
  }
  return [
    promptError
      ? `⚠️ 已创建 ${providerLabel} fork：${channelLabel}，但 prompt 没有入队`
      : `✅ 已创建 ${providerLabel} fork：${channelLabel}`,
    `• fork session: \`${result.forkedSessionId}\``,
    `• parent session: \`${result.parentSessionId}\``,
    promptQueued ? `• prompt 已进入 fork 队列${queuedAhead > 0 ? `，前面还有 ${queuedAhead} 条` : ''}` : null,
    promptError ? `• 错误：${promptError}` : null,
    noticeError ? `• 通知发送失败：${noticeError}` : null,
  ].filter(Boolean).join('\n');
}
