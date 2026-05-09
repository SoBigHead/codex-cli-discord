import test from 'node:test';
import assert from 'node:assert/strict';

import { createChannelQueue } from '../src/channel-queue.js';
import { createChannelRuntimeStore } from '../src/channel-runtime.js';

function createMessage(id, replyLog, reactionLog) {
  const removals = [];
  const cache = new Map();
  cache.set('⚡', {
    users: {
      async remove(userId) {
        removals.push(userId);
      },
    },
  });

  return {
    id,
    author: {
      id: `user-${id}`,
    },
    client: {
      user: {
        id: 'bot-user',
      },
    },
    channel: { id: `channel-${id}` },
    reactions: { cache },
    async react(emoji) {
      reactionLog.push({ id, emoji });
    },
    get removals() {
      return removals;
    },
    async reply(payload) {
      replyLog.push({ id, payload });
    },
  };
}

function waitFor(check, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

test('createChannelQueue processes queued prompts sequentially', async () => {
  const runtime = createChannelRuntimeStore({
    cloneProgressPlan: (plan) => (plan ? JSON.parse(JSON.stringify(plan)) : null),
    truncate: (text, max) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`),
  });
  const replyLog = [];
  const reactionLog = [];
  const handled = [];
  let releaseFirst;
  const firstDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const queue = createChannelQueue({
    getChannelState: runtime.getChannelState,
    getSession: () => ({ provider: 'codex' }),
    resolveSecurityContext: () => ({ maxQueuePerChannel: 10 }),
    safeReply: async (message, payload) => {
      replyLog.push({ id: message.id, payload });
    },
    safeError: (error) => error.message,
    getCurrentUserId: () => 'bot-user',
    handlePrompt: async (_message, _key, content) => {
      handled.push(content);
      if (content === 'first') {
        await firstDone;
      }
      return { ok: true, cancelled: false };
    },
  });

  const firstMessage = createMessage('1', replyLog, reactionLog);
  const secondMessage = createMessage('2', replyLog, reactionLog);

  await queue.enqueuePrompt(firstMessage, 'thread-1', 'first');
  await queue.enqueuePrompt(secondMessage, 'thread-1', 'second');

  await waitFor(() => runtime.getChannelState('thread-1').queue.length === 1);
  releaseFirst();
  await waitFor(() => handled.length === 2 && runtime.getChannelState('thread-1').running === false);

  assert.deepEqual(handled, ['first', 'second']);
  assert.equal(replyLog.some((entry) => String(entry.payload).includes('已加入队列')), true);
  assert.equal(reactionLog.filter((entry) => entry.emoji === '⚡').length, 2);
  assert.equal(reactionLog.filter((entry) => entry.emoji === '✅').length, 2);
  assert.deepEqual(firstMessage.removals, ['bot-user']);
  assert.deepEqual(secondMessage.removals, ['bot-user']);
});

test('createChannelQueue steers running Codex long prompts instead of queueing', async () => {
  const runtime = createChannelRuntimeStore({
    cloneProgressPlan: (plan) => (plan ? JSON.parse(JSON.stringify(plan)) : null),
    truncate: (text, max) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`),
  });
  const state = runtime.getChannelState('thread-1');
  state.running = true;
  const replyLog = [];
  const reactionLog = [];
  const steered = [];
  const queue = createChannelQueue({
    getChannelState: runtime.getChannelState,
    getSession: () => ({ provider: 'codex', runtimeMode: 'long', busyPromptMode: 'steer_if_possible' }),
    resolveBusyPromptModeSetting: () => ({ mode: 'steer_if_possible', requestedMode: 'steer_if_possible', canSteer: true }),
    resolveSecurityContext: () => ({ maxQueuePerChannel: 10 }),
    safeReply: async (message, payload) => {
      replyLog.push({ id: message.id, payload });
    },
    safeError: (error) => error.message,
    steerPrompt: async ({ content, key }) => {
      steered.push({ content, key });
      return { ok: true, steered: true, threadId: 'thread-id', turnId: 'turn-id' };
    },
    handlePrompt: async () => {
      throw new Error('should not run queued prompt');
    },
  });

  const message = createMessage('steer', replyLog, reactionLog);
  const result = await queue.enqueuePrompt(message, 'thread-1', 'adjust current work');

  assert.deepEqual(result, { ok: true, enqueued: false, steered: true });
  assert.deepEqual(steered, [{ content: 'adjust current work', key: 'thread-1' }]);
  assert.equal(state.queue.length, 0);
  assert.equal(replyLog[0].payload, '↪️ 已插入当前 Codex 任务。');
});

test('createChannelQueue falls back to queue when steer fails', async () => {
  const runtime = createChannelRuntimeStore({
    cloneProgressPlan: (plan) => (plan ? JSON.parse(JSON.stringify(plan)) : null),
    truncate: (text, max) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`),
  });
  const state = runtime.getChannelState('thread-1');
  state.running = true;
  const replyLog = [];
  const reactionLog = [];
  const queue = createChannelQueue({
    getChannelState: runtime.getChannelState,
    getSession: () => ({ provider: 'codex', runtimeMode: 'long', busyPromptMode: 'steer_if_possible' }),
    resolveBusyPromptModeSetting: () => ({ mode: 'steer_if_possible', requestedMode: 'steer_if_possible', canSteer: true }),
    resolveSecurityContext: () => ({ maxQueuePerChannel: 10 }),
    safeReply: async (message, payload) => {
      replyLog.push({ id: message.id, payload });
    },
    safeError: (error) => error.message,
    steerPrompt: async () => ({ ok: false, steered: false, error: 'cannot steer a review turn' }),
    handlePrompt: async () => ({ ok: true, cancelled: false }),
  });

  const message = createMessage('fallback', replyLog, reactionLog);
  const result = await queue.enqueuePrompt(message, 'thread-1', 'adjust current work');

  assert.equal(result.enqueued, true);
  assert.equal(result.queuedAhead, 1);
  assert.equal(state.queue.length, 1);
  assert.match(replyLog[0].payload, /插入当前任务失败（cannot steer a review turn）/);
  assert.match(replyLog[0].payload, /已加入队列/);
});

test('createChannelQueue falls back to message client user id when getCurrentUserId is omitted', async () => {
  const runtime = createChannelRuntimeStore({
    cloneProgressPlan: (plan) => (plan ? JSON.parse(JSON.stringify(plan)) : null),
    truncate: (text, max) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`),
  });
  const replyLog = [];
  const reactionLog = [];
  const queue = createChannelQueue({
    getChannelState: runtime.getChannelState,
    getSession: () => ({ provider: 'codex' }),
    resolveSecurityContext: () => ({ maxQueuePerChannel: 10 }),
    safeReply: async (message, payload) => {
      replyLog.push({ id: message.id, payload });
    },
    safeError: (error) => error.message,
    handlePrompt: async () => ({ ok: true, cancelled: false }),
  });

  const message = createMessage('3', replyLog, reactionLog);
  await queue.enqueuePrompt(message, 'thread-2', 'third');
  await waitFor(() => runtime.getChannelState('thread-2').running === false);

  assert.deepEqual(message.removals, ['bot-user']);
});

test('createChannelQueue remembers failed prompts and can re-enqueue them', async () => {
  const runtime = createChannelRuntimeStore({
    cloneProgressPlan: (plan) => (plan ? JSON.parse(JSON.stringify(plan)) : null),
    truncate: (text, max) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`),
  });
  const replyLog = [];
  const reactionLog = [];
  const handled = [];
  let attempts = 0;

  const queue = createChannelQueue({
    getChannelState: runtime.getChannelState,
    getSession: () => ({ provider: 'codex' }),
    resolveSecurityContext: () => ({ maxQueuePerChannel: 10 }),
    safeReply: async (message, payload) => {
      replyLog.push({ id: message.id, payload });
    },
    safeError: (error) => error.message,
    getCurrentUserId: () => 'bot-user',
    handlePrompt: async (_message, _key, content) => {
      handled.push(content);
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, cancelled: false };
      }
      return { ok: true, cancelled: false };
    },
    rememberFailedPrompt: runtime.rememberFailedPrompt,
    clearLastFailedPrompt: runtime.clearLastFailedPrompt,
    getLastFailedPrompt: runtime.getLastFailedPrompt,
  });

  const message = createMessage('4', replyLog, reactionLog);
  await queue.enqueuePrompt(message, 'thread-3', 'retry-me');
  await waitFor(() => runtime.getChannelState('thread-3').running === false);

  const failedPrompt = runtime.getLastFailedPrompt('thread-3');
  assert.equal(failedPrompt?.content, 'retry-me');

  const retryOutcome = await queue.retryLastPrompt('thread-3');
  await waitFor(() => runtime.getChannelState('thread-3').running === false && handled.length === 2);

  assert.deepEqual(retryOutcome, { ok: true, enqueued: true, queuedAhead: 0 });
  assert.deepEqual(handled, ['retry-me', 'retry-me']);
  assert.equal(runtime.getLastFailedPrompt('thread-3'), null);
});

test('createChannelQueue refuses retry when requester does not own the failed prompt', async () => {
  const runtime = createChannelRuntimeStore({
    cloneProgressPlan: (plan) => (plan ? JSON.parse(JSON.stringify(plan)) : null),
    truncate: (text, max) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`),
  });
  const replyLog = [];
  const reactionLog = [];
  const handled = [];

  const queue = createChannelQueue({
    getChannelState: runtime.getChannelState,
    getSession: () => ({ provider: 'codex' }),
    resolveSecurityContext: () => ({ maxQueuePerChannel: 10 }),
    safeReply: async (message, payload) => {
      replyLog.push({ id: message.id, payload });
    },
    safeError: (error) => error.message,
    getCurrentUserId: () => 'bot-user',
    handlePrompt: async (_message, _key, content) => {
      handled.push(content);
      return { ok: false, cancelled: false };
    },
    rememberFailedPrompt: runtime.rememberFailedPrompt,
    clearLastFailedPrompt: runtime.clearLastFailedPrompt,
    getLastFailedPrompt: runtime.getLastFailedPrompt,
  });

  const message = createMessage('6', replyLog, reactionLog);
  await queue.enqueuePrompt(message, 'thread-5', 'private-retry');
  await waitFor(() => runtime.getChannelState('thread-5').running === false);

  const retryOutcome = await queue.retryLastPrompt('thread-5', 'user-other');

  assert.deepEqual(retryOutcome, {
    ok: false,
    enqueued: false,
    reason: 'missing_failed_prompt',
  });
  assert.deepEqual(handled, ['private-retry']);
  assert.equal(runtime.getLastFailedPrompt('thread-5')?.content, 'private-retry');
});

test('createChannelQueue adds retry button when unexpected processing error bubbles out', async () => {
  const runtime = createChannelRuntimeStore({
    cloneProgressPlan: (plan) => (plan ? JSON.parse(JSON.stringify(plan)) : null),
    truncate: (text, max) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`),
  });
  const replyLog = [];
  const reactionLog = [];

  const queue = createChannelQueue({
    getChannelState: runtime.getChannelState,
    getSession: () => ({ provider: 'codex' }),
    resolveSecurityContext: () => ({ maxQueuePerChannel: 10 }),
    safeReply: async (message, payload) => {
      replyLog.push({ id: message.id, payload });
    },
    safeError: (error) => error.message,
    getCurrentUserId: () => 'bot-user',
    handlePrompt: async () => {
      throw new Error('boom');
    },
    rememberFailedPrompt: runtime.rememberFailedPrompt,
    clearLastFailedPrompt: runtime.clearLastFailedPrompt,
    getLastFailedPrompt: runtime.getLastFailedPrompt,
  });

  const message = createMessage('5', replyLog, reactionLog);
  await queue.enqueuePrompt(message, 'thread-4', 'explode');
  await waitFor(() => runtime.getChannelState('thread-4').running === false);

  const failedPrompt = runtime.getLastFailedPrompt('thread-4');
  assert.equal(failedPrompt?.content, 'explode');
  assert.equal(failedPrompt?.error, 'boom');
  assert.equal(reactionLog.some((entry) => entry.id === '5' && entry.emoji === '❌'), true);

  const errorReply = replyLog.at(-1)?.payload;
  assert.equal(typeof errorReply, 'object');
  assert.equal(errorReply.content, '❌ 处理失败：boom');
  assert.deepEqual(errorReply.components, [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: 'Retry',
          custom_id: 'cmd:retry:user-5',
        },
      ],
    },
  ]);
});
