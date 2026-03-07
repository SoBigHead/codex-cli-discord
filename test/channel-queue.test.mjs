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
