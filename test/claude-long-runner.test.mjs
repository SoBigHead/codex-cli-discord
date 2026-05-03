import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeLongRunner } from '../src/claude-long-runner.js';

class FakeChild extends EventEmitter {
  constructor({ writes }) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = FakeChild.nextPid++;
    this.killed = false;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        writes.push(chunk.toString('utf8'));
        callback();
      },
    });
  }

  kill(signal = 'SIGTERM') {
    if (this.killed) return;
    this.killed = true;
    this.emit('close', null, signal);
  }
}

FakeChild.nextPid = 1000;

function createFakeSpawn() {
  const children = [];
  const writes = [];
  return {
    children,
    writes,
    spawnFn(_bin, args, options) {
      const child = new FakeChild({ writes });
      child.args = args;
      child.options = options;
      children.push(child);
      return child;
    },
  };
}

function emitEvent(child, event) {
  child.stdout.write(`${JSON.stringify(event)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('Claude long runner resolves a turn on result and reuses the hot process for the same thread', async () => {
  const fake = createFakeSpawn();
  const logs = [];
  const runner = createClaudeLongRunner({
    spawnFn: fake.spawnFn,
    getProviderBin: () => 'claude',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: null }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    stopChildProcess: (child) => child.kill('SIGTERM'),
    idleMs: 10_000,
    log: (line) => logs.push(line),
  });

  const first = runner.runTask({
    session: { provider: 'claude', mode: 'safe', runnerSessionId: null },
    sessionKey: 'thread-a',
    workspaceDir: '/tmp/workspace-a',
    prompt: 'hello',
  });
  assert.equal(fake.children.length, 1);
  assert.match(fake.writes[0], /"content":"hello"/);

  emitEvent(fake.children[0], {
    type: 'assistant',
    session_id: 'sess-1',
    message: { content: [{ type: 'text', text: 'answer one' }] },
  });
  emitEvent(fake.children[0], {
    type: 'result',
    session_id: 'sess-1',
    usage: { input_tokens: 12 },
  });
  const firstResult = await first;

  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.threadId, 'sess-1');
  assert.deepEqual(firstResult.finalAnswerMessages, ['answer one']);
  assert.equal(fake.children[0].killed, false);
  assert.match(logs.join('\n'), /\[claude-long\] spawn .*mode=stream-json-stdin .*dashP=false/);
  assert.match(logs.join('\n'), /\[claude-long\] result .*ok=true/);

  const second = runner.runTask({
    session: { provider: 'claude', mode: 'safe', runnerSessionId: 'sess-1' },
    sessionKey: 'thread-a',
    workspaceDir: '/tmp/workspace-a',
    prompt: 'again',
  });
  assert.equal(fake.children.length, 1);
  emitEvent(fake.children[0], {
    type: 'assistant',
    session_id: 'sess-1',
    message: { content: [{ type: 'text', text: 'answer two' }] },
  });
  emitEvent(fake.children[0], { type: 'result', session_id: 'sess-1' });
  const secondResult = await second;

  assert.equal(secondResult.ok, true);
  assert.deepEqual(secondResult.finalAnswerMessages, ['answer two']);
  assert.match(fake.writes[1], /"content":"again"/);
  assert.match(logs.join('\n'), /\[claude-long\] reuse .*sessionId=sess-1/);
});

test('Claude long runner surfaces result errors instead of treating them as success', async () => {
  const fake = createFakeSpawn();
  const runner = createClaudeLongRunner({
    spawnFn: fake.spawnFn,
    getProviderBin: () => 'claude',
    getSessionId: () => 'sess-error',
    resolveModelSetting: () => ({ value: null }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    stopChildProcess: (child) => child.kill('SIGTERM'),
    log: () => {},
  });

  const task = runner.runTask({
    session: { provider: 'claude', mode: 'safe', runnerSessionId: 'sess-error' },
    sessionKey: 'thread-error',
    workspaceDir: '/tmp/workspace-error',
    prompt: 'fail',
  });
  emitEvent(fake.children[0], {
    type: 'result',
    session_id: 'sess-error',
    is_error: true,
    errors: ['permission denied'],
  });
  const result = await task;

  assert.equal(result.ok, false);
  assert.equal(result.error, 'permission denied');
  assert.equal(result.threadId, 'sess-error');
});

test('Claude long runner folds per-turn extra context into stdin payload', async () => {
  const fake = createFakeSpawn();
  const runner = createClaudeLongRunner({
    spawnFn: fake.spawnFn,
    getProviderBin: () => 'claude',
    getSessionId: () => 'sess-context',
    resolveModelSetting: () => ({ value: null }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    stopChildProcess: (child) => child.kill('SIGTERM'),
    log: () => {},
  });

  const task = runner.runTask({
    session: { provider: 'claude', mode: 'safe', runnerSessionId: 'sess-context' },
    sessionKey: 'thread-context',
    workspaceDir: '/tmp/workspace-context',
    prompt: 'hello',
    systemPrompt: '[Via agents-in-discord; discord_thread=thread-1]',
  });
  const payload = JSON.parse(fake.writes[0]);
  assert.equal(payload.message.content, '[Via agents-in-discord; discord_thread=thread-1]\n\nhello');

  emitEvent(fake.children[0], { type: 'result', session_id: 'sess-context' });
  assert.equal((await task).ok, true);
});

test('Claude long runner keeps API retry details for final errors', async () => {
  const fake = createFakeSpawn();
  const runner = createClaudeLongRunner({
    spawnFn: fake.spawnFn,
    getProviderBin: () => 'claude',
    getSessionId: () => 'sess-rate-limit',
    resolveModelSetting: () => ({ value: null }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    stopChildProcess: (child) => child.kill('SIGTERM'),
    log: () => {},
  });

  const task = runner.runTask({
    session: { provider: 'claude', mode: 'safe', runnerSessionId: 'sess-rate-limit' },
    sessionKey: 'thread-rate-limit',
    workspaceDir: '/tmp/workspace-rate-limit',
    prompt: 'fail',
  });
  emitEvent(fake.children[0], {
    type: 'system',
    subtype: 'api_retry',
    error_status: 429,
    error: 'rate_limit',
    attempt: 7,
    max_retries: 10,
    retry_delay_ms: 39083.4,
    session_id: 'sess-rate-limit',
  });
  emitEvent(fake.children[0], {
    type: 'result',
    session_id: 'sess-rate-limit',
    is_error: true,
  });
  const result = await task;

  assert.equal(result.ok, false);
  assert.match(result.error, /status=429/);
  assert.match(result.error, /error=rate_limit/);
  assert.match(result.logs.join('\n'), /attempt=7/);
});

test('Claude long runner releases idle processes and resumes the saved session after reheating', async () => {
  const fake = createFakeSpawn();
  const runner = createClaudeLongRunner({
    spawnFn: fake.spawnFn,
    getProviderBin: () => 'claude',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: null }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    stopChildProcess: (child) => child.kill('SIGTERM'),
    idleMs: 10,
    log: () => {},
  });

  const first = runner.runTask({
    session: { provider: 'claude', mode: 'safe', runnerSessionId: 'sess-resume' },
    sessionKey: 'thread-resume',
    workspaceDir: '/tmp/workspace-resume',
    prompt: 'warm',
  });
  emitEvent(fake.children[0], { type: 'assistant', session_id: 'sess-resume', message: { content: 'warm answer' } });
  emitEvent(fake.children[0], { type: 'result', session_id: 'sess-resume' });
  assert.equal((await first).ok, true);

  await delay(30);
  assert.equal(fake.children[0].killed, true);
  assert.deepEqual(runner.getSnapshot(), []);

  const second = runner.runTask({
    session: { provider: 'claude', mode: 'safe', runnerSessionId: 'sess-resume' },
    sessionKey: 'thread-resume',
    workspaceDir: '/tmp/workspace-resume',
    prompt: 'reheat',
  });
  assert.equal(fake.children.length, 2);
  const resumeIndex = fake.children[1].args.indexOf('--resume');
  assert.notEqual(resumeIndex, -1);
  assert.equal(fake.children[1].args[resumeIndex + 1], 'sess-resume');
  emitEvent(fake.children[1], { type: 'assistant', session_id: 'sess-resume', message: { content: 'back' } });
  emitEvent(fake.children[1], { type: 'result', session_id: 'sess-resume' });
  assert.equal((await second).ok, true);
});
