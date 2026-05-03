import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCodexForkThread,
  createProviderForkThread,
  formatCodexForkResult,
  parseForkTextInput,
} from '../src/codex-fork-flow.js';

function createForkSource() {
  return {
    id: 'source-1',
    user: { id: 'user-1' },
    channel: {
      id: 'parent-channel',
      threads: {
        async create() {
          throw new Error('default create should not run in this test');
        },
      },
    },
  };
}

test('createCodexForkThread creates Discord thread before native fork and deletes it on native failure', async () => {
  const events = [];
  const childThread = {
    id: 'child-channel',
    async delete(reason) {
      events.push(`delete:${reason}`);
    },
  };

  await assert.rejects(
    () => createCodexForkThread({
      key: 'parent-channel',
      source: createForkSource(),
      parentSessionId: 'parent-session',
      getSession: () => ({}),
      commandActions: {
        bindForkedSession() {},
      },
      createThread: async () => {
        events.push('createThread');
        return childThread;
      },
      async forkCodexThread() {
        events.push('forkCodexThread');
        throw new Error('native fork failed');
      },
    }),
    /native fork failed/,
  );

  assert.deepEqual(events, [
    'createThread',
    'forkCodexThread',
    'delete:Codex fork failed before session binding',
  ]);
});

test('createCodexForkThread uses an optional requested Discord thread name', async () => {
  const childSession = {};
  const threadCreates = [];
  const setNameCalls = [];
  const result = await createCodexForkThread({
    key: 'parent-channel',
    source: {
      ...createForkSource(),
      channel: {
        id: 'parent-channel',
        threads: {
          async create(options) {
            threadCreates.push(options);
            return {
              id: 'child-channel',
              async join() {},
              async setName(name, reason) {
                setNameCalls.push({ name, reason });
              },
              async send() {},
            };
          },
        },
      },
    },
    parentSessionId: 'parent-session',
    threadName: '  Custom   Fork   ',
    getSession: () => childSession,
    commandActions: {
      bindForkedSession(currentSession, binding) {
        currentSession.runnerSessionId = binding.sessionId;
        return binding;
      },
    },
    async forkCodexThread() {
      return { threadId: 'fork-session' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(threadCreates[0].name, 'Custom Fork');
  assert.deepEqual(setNameCalls, []);
});

test('parseForkTextInput treats its only argument as the requested thread name', () => {
  assert.deepEqual(parseForkTextInput('  Demo   fork  '), { threadName: 'Demo fork' });
  assert.deepEqual(parseForkTextInput(''), { threadName: '' });
});

test('createProviderForkThread prepares Claude fork without mutating the parent session', async () => {
  const parentSession = { provider: 'claude', runnerSessionId: 'parent-session' };
  const childSession = { provider: 'claude', runnerSessionId: null };
  const threadCreates = [];
  const setNameCalls = [];
  const result = await createProviderForkThread({
    key: 'parent-channel',
    session: parentSession,
    source: {
      ...createForkSource(),
      channel: {
        id: 'parent-channel',
        threads: {
          async create(options) {
            threadCreates.push(options);
            return {
              id: 'child-channel',
              async join() {},
              async setName(name, reason) {
                setNameCalls.push({ name, reason });
              },
              async send() {},
            };
          },
        },
      },
    },
    provider: 'claude',
    parentSessionId: 'parent-session',
    generateSessionId: () => 'child-session',
    getSession: () => childSession,
    commandActions: {
      bindForkedSession(currentSession, binding) {
        currentSession.runnerSessionId = binding.sessionId;
        currentSession.forkedFromProvider = binding.provider;
        currentSession.forkedFromSessionId = binding.parentSessionId;
        currentSession.pendingForkFromSessionId = binding.pendingForkFromSessionId;
        return binding;
      },
    },
    async forkCodexThread() {
      throw new Error('Codex fork should not run for Claude');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'claude');
  assert.equal(result.forkedSessionId, 'child-session');
  assert.equal(threadCreates[0].name, 'claude fork child-se from parent-s');
  assert.equal(setNameCalls[0].name, 'claude fork child-se from parent-s');
  assert.equal(parentSession.runnerSessionId, 'parent-session');
  assert.equal(childSession.runnerSessionId, 'child-session');
  assert.equal(childSession.forkedFromProvider, 'claude');
  assert.equal(childSession.forkedFromSessionId, 'parent-session');
  assert.equal(childSession.pendingForkFromSessionId, 'parent-session');
});

test('formatCodexForkResult makes prompt enqueue failure explicit', async () => {
  const childSession = {};
  const result = await createCodexForkThread({
    key: 'parent-channel',
    source: createForkSource(),
    parentSessionId: 'parent-session',
    getSession: () => childSession,
    commandActions: {
      bindForkedSession(currentSession, binding) {
        currentSession.runnerSessionId = binding.sessionId;
        return binding;
      },
    },
    createThread: async () => ({
      id: 'child-channel',
      async setName() {},
      async send() {},
    }),
    async forkCodexThread() {
      return { threadId: 'fork-session' };
    },
    async enqueuePrompt() {
      throw new Error('queue unavailable');
    },
    prompt: 'continue',
  });

  assert.equal(result.ok, true);
  assert.equal(result.promptQueue.enqueued, false);
  assert.equal(result.promptQueue.error, 'queue unavailable');
  const report = formatCodexForkResult(result, 'zh');
  assert.match(report, /^⚠️ 已创建 Codex fork/);
  assert.match(report, /prompt 没有入队/);
  assert.doesNotMatch(report, /^✅/);
});
