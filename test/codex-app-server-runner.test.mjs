import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { buildCodexLongConfig, createCodexAppServerRunner } from '../src/codex-app-server-runner.js';

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

function createFakeAppServerSpawn({ autoComplete = true, failSteer = false, failInject = false } = {}) {
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
      } else if (request.method === 'thread/fork') {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: 'side-thread-1', forkedFromId: request.params.threadId } } })}\n`);
      } else if (request.method === 'thread/inject_items') {
        if (failInject) {
          child.stdout.write(`${JSON.stringify({ id: request.id, error: { message: 'inject failed' } })}\n`);
        } else {
          child.stdout.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
        }
      } else if (request.method === 'thread/unsubscribe') {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
      } else if (request.method === 'turn/interrupt') {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
      } else if (request.method === 'turn/start') {
        activeThreadId = request.params.threadId;
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

test('buildCodexLongConfig pins openai-curated marketplace to local cache when present', () => {
  const previous = process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
  process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE = '/tmp';
  try {
    const config = buildCodexLongConfig({
      session: {},
      resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
      resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
      resolveCompactEnabledSetting: () => ({ enabled: false }),
      resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    });

    assert.equal(config.marketplaces['openai-curated'].source_type, 'local');
    assert.equal(config.marketplaces['openai-curated'].source, '/tmp');
  } finally {
    if (previous === undefined) delete process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
    else process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE = previous;
  }
});

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
  const threadStart = JSON.parse(fake.writes.find((line) => JSON.parse(line).method === 'thread/start'));
  assert.equal(threadStart.params.approvalPolicy, 'on-request');
  assert.equal(threadStart.params.sandbox, 'workspace-write');
  assert.equal(threadStart.params.approvalsReviewer, 'auto_review');
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

test('createCodexAppServerRunner forks side thread as ephemeral and injects boundary items', async () => {
  const fake = createFakeAppServerSpawn();
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

  const result = await runner.forkSideThread({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'parent-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    systemPrompt: 'parent instructions',
    sideDeveloperInstructions: 'side rules',
    boundaryItems: [{ type: 'message', role: 'user', content: [] }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.parentThreadId, 'parent-thread-1');
  assert.equal(result.sideThreadId, 'side-thread-1');
  const methods = fake.writes.map((line) => JSON.parse(line).method);
  assert.deepEqual(methods, ['initialize', 'initialized', 'thread/resume', 'thread/fork', 'thread/inject_items']);
  const forkRequest = fake.writes.map((line) => JSON.parse(line)).find((request) => request.method === 'thread/fork');
  assert.equal(forkRequest.params.threadId, 'parent-thread-1');
  assert.equal(forkRequest.params.ephemeral, true);
  assert.match(forkRequest.params.developerInstructions, /parent instructions/);
  assert.match(forkRequest.params.developerInstructions, /side rules/);
  const injectRequest = fake.writes.map((line) => JSON.parse(line)).find((request) => request.method === 'thread/inject_items');
  assert.equal(injectRequest.params.threadId, 'side-thread-1');
  assert.equal(injectRequest.params.items.length, 1);

  const sideRun = await runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'side-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'side hello',
    targetThreadId: 'side-thread-1',
  });
  assert.equal(sideRun.ok, true);
  assert.equal(sideRun.threadId, 'side-thread-1');
  fake.child.stdout.write(`${JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'side-thread-1', tokenUsage: { totalTokens: 1 } } })}\n`);
  await sleep(5);
  const turnRequest = fake.writes.map((line) => JSON.parse(line)).filter((request) => request.method === 'turn/start').pop();
  assert.equal(turnRequest.params.threadId, 'side-thread-1');
  assert.equal(runner.getSnapshot()[0].threadId, 'parent-thread-1');
  const cleanup = await runner.closeSideThread({
    sessionKey: 'discord-thread-1',
    threadId: 'side-thread-1',
  });
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.unsubscribed, true);
  assert.equal(cleanup.interrupted, false);
  assert.equal(fake.child.killed, false);
  assert.equal(runner.getSnapshot()[0].threadId, 'parent-thread-1');
  runner.closeAll('test done');
});

test('createCodexAppServerRunner unsubscribes side thread when boundary injection fails', async () => {
  const fake = createFakeAppServerSpawn({ failInject: true });
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

  await assert.rejects(
    () => runner.forkSideThread({
      session: { provider: 'codex', mode: 'safe', runnerSessionId: 'parent-thread-1' },
      sessionKey: 'discord-thread-1',
      workspaceDir: '/tmp/workspace',
      boundaryItems: [{ type: 'message', role: 'user', content: [] }],
    }),
    /inject failed; side thread unsubscribed/,
  );
  const requests = fake.writes.map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.method), [
    'initialize',
    'initialized',
    'thread/resume',
    'thread/fork',
    'thread/inject_items',
    'thread/unsubscribe',
  ]);
  assert.equal(requests.at(-1).params.threadId, 'side-thread-1');
  runner.closeAll('test done');
});

test('createCodexAppServerRunner interrupts and unsubscribes active side thread before closing', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false });
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: null }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: null }),
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
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'side-thread-1' },
    sessionKey: 'side-channel-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'side question',
  });
  await waitFor(() => fake.writes.some((line) => JSON.parse(line).method === 'turn/start'));

  const cleanup = await runner.closeSideThread({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'side-thread-1' },
    sessionKey: 'side-channel-1',
    threadId: 'side-thread-1',
  });

  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.interrupted, true);
  assert.equal(cleanup.unsubscribed, true);
  const methods = fake.writes.map((line) => JSON.parse(line).method);
  assert.deepEqual(methods.slice(-2), ['turn/interrupt', 'thread/unsubscribe']);
  const result = await run;
  assert.equal(result.ok, false);
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
