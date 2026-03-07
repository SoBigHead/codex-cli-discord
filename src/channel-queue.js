export function createChannelQueue({
  getChannelState,
  getSession,
  resolveSecurityContext,
  safeReply,
  safeError,
  getCurrentUserId,
  handlePrompt,
} = {}) {
  async function enqueuePrompt(message, key, content, securityContext = null) {
    const state = getChannelState(key);
    const security = securityContext || resolveSecurityContext(message.channel, getSession(key));
    const maxQueue = security.maxQueuePerChannel;
    if (maxQueue > 0 && state.queue.length >= maxQueue) {
      await safeReply(
        message,
        `🚧 当前频道队列已满（上限 ${maxQueue}）。请稍后重试，或用 \`!queue\` / \`!abort\` 处理积压任务。`,
      );
      return;
    }

    const queuedAhead = (state.running ? 1 : 0) + state.queue.length;
    state.queue.push({
      message,
      key,
      content,
      enqueuedAt: Date.now(),
    });

    if (queuedAhead > 0) {
      await safeReply(
        message,
        `⏳ 已加入队列，前面还有 ${queuedAhead} 条。可用 \`!queue\` 查看状态，\`!abort\` 中断当前任务。`,
      );
    }

    void processPromptQueue(key);
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
      await message.reactions.cache.get('⚡')?.users.remove(getCurrentUserId?.()).catch(() => {});
      if (outcome.ok) {
        await message.react('✅').catch(() => {});
      } else if (outcome.cancelled) {
        await message.react('🛑').catch(() => {});
      } else {
        await message.react('❌').catch(() => {});
      }
    } catch (err) {
      console.error('runPromptJob error:', err);
      try {
        await message.reactions.cache.get('⚡')?.users.remove(getCurrentUserId?.()).catch(() => {});
        await message.react('❌').catch(() => {});
        await safeReply(message, `❌ 处理失败：${safeError(err)}`);
      } catch {
        // ignore
      }
    } finally {
      channelState.activeRun = null;
    }
  }

  return {
    enqueuePrompt,
  };
}
