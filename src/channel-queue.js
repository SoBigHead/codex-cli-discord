import { withRetryAction } from './retry-action-button.js';

export function createChannelQueue({
  getChannelState,
  getSession,
  resolveSecurityContext,
  resolveBusyPromptModeSetting = () => ({ mode: 'queue', canSteer: false }),
  slashRef = (name) => `/${name}`,
  safeReply,
  safeError,
  getCurrentUserId,
  handlePrompt,
  steerPrompt = null,
  rememberFailedPrompt = () => null,
  clearLastFailedPrompt = () => {},
  getLastFailedPrompt = () => null,
} = {}) {
  function resolveCurrentUserId(message) {
    const explicit = String(getCurrentUserId?.() || '').trim();
    if (explicit) return explicit;
    const fromClient = String(
      message?.client?.user?.id
      || message?.channel?.client?.user?.id
      || '',
    ).trim();
    return fromClient || null;
  }

  function hasMessageAttachments(message) {
    const attachments = message?.attachments;
    if (!attachments) return false;
    if (typeof attachments.size === 'number') return attachments.size > 0;
    if (Array.isArray(attachments)) return attachments.length > 0;
    if (typeof attachments.length === 'number') return attachments.length > 0;
    if (typeof attachments.values === 'function') return !attachments.values().next().done;
    return false;
  }

  function formatSteerFailure(reason) {
    const text = String(reason || '').trim();
    return text || 'steer unavailable';
  }

  async function trySteerRunningPrompt({ state, message, key, content, session }) {
    if (!state.running) return null;
    const busyPrompt = resolveBusyPromptModeSetting(session);
    if (busyPrompt?.mode !== 'steer_if_possible' || !busyPrompt?.canSteer) return null;
    if (typeof steerPrompt !== 'function') return null;

    if (hasMessageAttachments(message)) {
      return {
        ok: false,
        steered: false,
        fallbackReason: '带附件的消息暂不支持运行中插入',
      };
    }

    try {
      const outcome = await steerPrompt({
        message,
        key,
        content,
        session,
        channelState: state,
      });
      if (outcome?.steered) {
        await safeReply(message, '↪️ 已插入当前 Codex 任务。');
        return { ok: true, steered: true };
      }
      return {
        ok: false,
        steered: false,
        fallbackReason: outcome?.error || outcome?.reason || 'steer failed',
      };
    } catch (err) {
      return {
        ok: false,
        steered: false,
        fallbackReason: safeError(err),
      };
    }
  }

  async function enqueuePrompt(message, key, content, securityContext = null) {
    const state = getChannelState(key);
    const session = getSession(key, { channel: message.channel || null });
    const security = securityContext || resolveSecurityContext(message.channel, session);
    const steerAttempt = await trySteerRunningPrompt({
      state,
      message,
      key,
      content,
      session,
    });
    if (steerAttempt?.steered) {
      return { ok: true, enqueued: false, steered: true };
    }

    const maxQueue = security.maxQueuePerChannel;
    if (maxQueue > 0 && state.queue.length >= maxQueue) {
      await safeReply(
        message,
        `🚧 当前频道队列已满（上限 ${maxQueue}）。请稍后重试，或用 \`${slashRef('status')}\` 查看状态，必要时用 \`!c\` 清空当前任务与积压。`,
      );
      return { ok: false, enqueued: false, reason: 'queue_full', maxQueue };
    }

    const queuedAhead = (state.running ? 1 : 0) + state.queue.length;
    state.queue.push({
      message,
      key,
      content,
      enqueuedAt: Date.now(),
    });

    if (queuedAhead > 0) {
      const steerFailure = steerAttempt && !steerAttempt.steered
        ? `插入当前任务失败（${formatSteerFailure(steerAttempt.fallbackReason)}），`
        : '';
      await safeReply(
        message,
        `⏳ ${steerFailure}已加入队列，前面还有 ${queuedAhead} 条。可用 \`${slashRef('status')}\` 查看状态，必要时用 \`!c\` 中断当前任务。`,
      );
    }

    void processPromptQueue(key);
    return { ok: true, enqueued: true, queuedAhead };
  }

  function createFailedPromptRecord(job, err = null, reason = null) {
    return {
      message: job.message,
      key: job.key,
      content: job.content,
      authorId: String(job?.message?.author?.id || '').trim() || null,
      failedAt: Date.now(),
      reason: reason || null,
      error: err ? safeError(err) : null,
    };
  }

  async function retryLastPrompt(key, requesterUserId = null) {
    const failedPrompt = getLastFailedPrompt(key);
    if (!failedPrompt) {
      return { ok: false, enqueued: false, reason: 'missing_failed_prompt' };
    }
    if (requesterUserId && failedPrompt.authorId && failedPrompt.authorId !== requesterUserId) {
      return { ok: false, enqueued: false, reason: 'missing_failed_prompt' };
    }

    clearLastFailedPrompt(key);
    try {
      const result = await enqueuePrompt(failedPrompt.message, failedPrompt.key, failedPrompt.content, null);
      if (!result?.enqueued) {
        rememberFailedPrompt(key, failedPrompt);
        return {
          ok: false,
          enqueued: false,
          reason: result?.reason || 'enqueue_failed',
          maxQueue: result?.maxQueue || null,
        };
      }

      return { ok: true, enqueued: true, queuedAhead: result.queuedAhead || 0 };
    } catch (err) {
      rememberFailedPrompt(key, failedPrompt);
      throw err;
    }
  }

  async function processPromptQueue(key) {
    const state = getChannelState(key);
    if (state.running) return;

    state.running = true;
    try {
      while (state.queue.length) {
        const job = state.queue.shift();
        if (!job) continue;
        await runPromptJob(state, job);
      }
    } finally {
      state.running = false;
      state.activeRun = null;
      state.cancelRequested = false;
    }
  }

  async function runPromptJob(channelState, job) {
    const { message, key, content } = job;
    channelState.cancelRequested = false;

    try {
      await message.react('⚡').catch(() => {});
      const outcome = await handlePrompt(message, key, content, channelState);
      const currentUserId = resolveCurrentUserId(message);
      if (currentUserId) {
        await message.reactions.cache.get('⚡')?.users.remove(currentUserId).catch(() => {});
      }
      if (outcome.ok) {
        await message.react('✅').catch(() => {});
      } else if (outcome.cancelled) {
        await message.react('🛑').catch(() => {});
      } else {
        rememberFailedPrompt(channelState, createFailedPromptRecord(job, null, outcome?.reason || null));
        await message.react('❌').catch(() => {});
      }
    } catch (err) {
      console.error('runPromptJob error:', err);
      try {
        rememberFailedPrompt(channelState, createFailedPromptRecord(job, err));
        const currentUserId = resolveCurrentUserId(message);
        if (currentUserId) {
          await message.reactions.cache.get('⚡')?.users.remove(currentUserId).catch(() => {});
        }
        await message.react('❌').catch(() => {});
        await safeReply(
          message,
          withRetryAction(`❌ 处理失败：${safeError(err)}`, message?.author?.id || null),
        );
      } catch {
        // ignore
      }
    } finally {
      channelState.activeRun = null;
    }
  }

  return {
    enqueuePrompt,
    retryLastPrompt,
  };
}
