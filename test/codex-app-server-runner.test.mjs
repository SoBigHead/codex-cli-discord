import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { createCodexAppServerRunner } from '../src/codex-app-server-runner.js';

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

function createFakeAppServerSpawn({ autoComplete = true, failSteer = false } = {}) {
  const calls = [];
  const writes = [];
  let activeThreadId = 'thread-1';
  let activeTurnId = 'turn-1';
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit('close', 0, null));
    return true;
  };
  child.stdin = {
    write(chunk, callback) {
      writes.push(String(chunk));
      const request = JSON.parse(String(chunk));
      if (!Object.prototype.hasOwnProperty.call(request, 'id')) {
        callback?.();
        return true;
      }
      if (request.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { codexHome: '/tmp/codex' } })}\n`);
      } else if (request.method === 'thread/start') {
        activeThreadId = 'thread-1';
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: 'thread-1' } } })}\n`);
      } else if (request.method === 'thread/resume') {
        activeThreadId = request.params.threadId;
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: request.params.threadId } } })}\n`);
      } else if (request.method === 'turn/start') {
        activeTurnId = 'turn-1';
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: activeTurnId, status: 'inProgress' } } })}\n`);
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: activeThreadId, turn: { id: activeTurnId, status: 'inProgress' } } })}\n`);
          if (autoComplete) completeTurn();
        });
      } else if (request.method === 'turn/steer') {
        if (failSteer) {
          child.stdout.write(`${JSON.stringify({ id: request.id, error: { message: 'cannot steer a review turn' } })}\n`);
        } else {
          child.stdout.write(`${JSON.stringify({ id: request.id, result: { turnId: request.params.expectedTurnId } })}\n`);
          child.stdout.write(`${JSON.stringify({ method: 'item/completed', params: { threadId: activeThreadId, turnId: activeTurnId, item: { type: 'message', id: 'steer-1', text: request.params.input[0]?.text || '', phase: 'commentary' } } })}\n`);
        }
      } else {
        child.stdout.write(`${JSON.stringify({ id: request.id, error: { message: `unexpected ${request.method}` } })}\n`);
      }
      callback?.();
      return true;
    },
    end() {},
  };

  function completeTurn() {
    child.stdout.write(`${JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: activeThreadId, turnId: activeTurnId, tokenUsage: { last: { inputTokens: 12, totalTokens: 20, cachedInputTokens: 0, outputTokens: 8, reasoningOutputTokens: 0 } } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'item/completed', params: { threadId: activeThreadId, turnId: activeTurnId, item: { type: 'agentMessage', id: 'item-1', text: 'done from app-server', phase: 'final_answer' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: activeThreadId, turn: { id: activeTurnId, status: 'completed' } } })}\n`);
  }

  function spawnFn(bin, args, options) {
    calls.push({ bin, args, options });
    return child;
  }

  return { spawnFn, calls, writes, child, completeTurn };
}

test('createCodexAppServerRunner runs a turn over persistent app-server and closes after idle', async () => {
  const fake = createFakeAppServerSpawn();
  const events = [];
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: 'gpt-5.5' }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: 'high' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 1,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const result = await runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: null },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
    systemPrompt: 'developer context',
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.threadId, 'thread-1');
  assert.deepEqual(result.finalAnswerMessages, ['done from app-server']);
  assert.equal(result.usage.last.inputTokens, 12);
  assert.deepEqual(fake.calls.map((call) => [call.bin, call.args]), [
    ['codex-test', ['app-server', '--listen', 'stdio://', '--enable', 'goals']],
  ]);
  assert.deepEqual(fake.writes.map((line) => JSON.parse(line).method), [
    'initialize',
    'initialized',
    'thread/start',
    'turn/start',
  ]);
  assert.equal(events.some((event) => event.type === 'item.completed'), true);

  await sleep(20);
  assert.equal(fake.child.killed, true);
});

test('createCodexAppServerRunner resumes an existing thread before starting a turn', async () => {
  const fake = createFakeAppServerSpawn();
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: null }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const result = await runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'existing-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'hello again',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(fake.writes.map((line) => JSON.parse(line).method), [
    'initialize',
    'initialized',
    'thread/resume',
    'turn/start',
  ]);
  assert.equal(JSON.parse(fake.writes.find((line) => JSON.parse(line).method === 'thread/resume')).params.threadId, 'existing-thread-1');
  runner.closeAll('test done');
});

test('createCodexAppServerRunner steers an active Codex turn', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false });
  const events = [];
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: 'gpt-5.5' }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: 'high' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const run = runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: null },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'start',
    onEvent: (event) => events.push(event),
  });
  await waitFor(() => fake.writes.some((line) => JSON.parse(line).method === 'turn/start'));

  const steer = await runner.steerTask({
    sessionKey: 'discord-thread-1',
    prompt: 'adjust current work',
  });
  assert.deepEqual(steer, {
    ok: true,
    steered: true,
    threadId: 'thread-1',
    turnId: 'turn-1',
  });
  const steerRequest = fake.writes.map((line) => JSON.parse(line)).find((request) => request.method === 'turn/steer');
  assert.equal(steerRequest.params.threadId, 'thread-1');
  assert.equal(steerRequest.params.expectedTurnId, 'turn-1');
  assert.deepEqual(steerRequest.params.input, [{ type: 'text', text: 'adjust current work', text_elements: [] }]);
  assert.equal(events.some((event) => event.type === 'turn.steer'), true);

  fake.completeTurn();
  const result = await run;
  assert.equal(result.ok, true);
  assert.equal(result.meta.steerCount, 1);
});

test('createCodexAppServerRunner reports failed steer without completing the active turn', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false, failSteer: true });
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: 'gpt-5.5' }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: 'high' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const run = runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: null },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'start',
  });
  await waitFor(() => fake.writes.some((line) => JSON.parse(line).method === 'turn/start'));

  const steer = await runner.steerTask({
    sessionKey: 'discord-thread-1',
    prompt: 'adjust current work',
  });
  assert.equal(steer.ok, false);
  assert.equal(steer.steered, false);
  assert.equal(steer.reason, 'steer_failed');
  assert.match(steer.error, /cannot steer a review turn/);

  fake.completeTurn();
  const result = await run;
  assert.equal(result.ok, true);
  assert.match(result.logs.join('\n'), /cannot steer a review turn/);
});
