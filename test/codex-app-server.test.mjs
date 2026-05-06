import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  createCodexAppServerClient,
  clearCodexThreadGoal,
  forkCodexThread,
  getCodexThreadGoal,
  setCodexThreadGoal,
} from '../src/codex-app-server.js';

function createFakeSpawn({ onRequest } = {}) {
  const calls = [];
  const writes = [];
  function spawnFn(bin, args, options) {
    calls.push({ bin, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    child.stdin = {
      write(chunk) {
        writes.push(String(chunk));
        const request = JSON.parse(String(chunk));
        const response = onRequest?.(request) || { id: request.id, result: {} };
        if (response) {
          child.stdout.write(`${JSON.stringify(response)}\n`);
        }
      },
      end() {},
    };
    return child;
  }
  return {
    spawnFn,
    calls,
    writes,
  };
}

test('createCodexAppServerClient sends initialize then thread/fork', async () => {
  const fake = createFakeSpawn({
    onRequest(request) {
      if (request.method === 'initialize') {
        assert.deepEqual(request.params.capabilities, { experimentalApi: true });
        return { id: request.id, result: { codexHome: '/tmp/codex' } };
      }
      if (request.method === 'thread/fork') {
        assert.deepEqual(request.params, {
          threadId: 'parent-1',
          excludeTurns: true,
          persistExtendedHistory: true,
        });
        return {
          id: request.id,
          result: {
            thread: {
              id: 'fork-1',
              forkedFromId: 'parent-1',
            },
          },
        };
      }
      throw new Error(`unexpected method ${request.method}`);
    },
  });

  const client = createCodexAppServerClient({
    codexBin: 'codex-test',
    spawnFn: fake.spawnFn,
    env: { HOME: '/tmp/home' },
  });
  const result = await client.forkThread({ threadId: 'parent-1' });

  assert.equal(result.threadId, 'fork-1');
  assert.equal(result.forkedFromId, 'parent-1');
  assert.deepEqual(fake.calls.map((call) => [call.bin, call.args]), [
    ['codex-test', ['app-server', '--listen', 'stdio://']],
  ]);
  assert.deepEqual(fake.writes.map((line) => JSON.parse(line).method), ['initialize', 'thread/fork']);
});

test('forkCodexThread rejects missing parent thread id before spawning', async () => {
  let spawned = false;
  await assert.rejects(
    () => forkCodexThread({
      threadId: '   ',
      spawnFn() {
        spawned = true;
      },
    }),
    /threadId is required/,
  );
  assert.equal(spawned, false);
});

test('Codex goal helpers send thread goal requests through app-server', async () => {
  const fake = createFakeSpawn({
    onRequest(request) {
      if (request.method === 'initialize') {
        return { id: request.id, result: { codexHome: '/tmp/codex' } };
      }
      if (request.method === 'thread/goal/set') {
        assert.deepEqual(request.params, {
          threadId: 'thread-1',
          objective: 'ship the feature',
          status: 'active',
          tokenBudget: 120000,
        });
        return {
          id: request.id,
          result: {
            goal: {
              threadId: 'thread-1',
              objective: 'ship the feature',
              status: 'active',
              tokenBudget: 120000,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        };
      }
      throw new Error(`unexpected method ${request.method}`);
    },
  });

  const result = await setCodexThreadGoal({
    codexBin: 'codex-test',
    spawnFn: fake.spawnFn,
    env: { HOME: '/tmp/home' },
    threadId: 'thread-1',
    objective: ' ship the feature ',
    status: 'active',
    tokenBudget: 120000,
  });

  assert.equal(result.goal.objective, 'ship the feature');
  assert.deepEqual(fake.calls.map((call) => [call.bin, call.args]), [
    ['codex-test', ['app-server', '--listen', 'stdio://']],
  ]);
  assert.deepEqual(fake.writes.map((line) => JSON.parse(line).method), ['initialize', 'thread/goal/set']);
});

test('Codex goal helpers support get and clear requests', async () => {
  const seen = [];
  const fake = createFakeSpawn({
    onRequest(request) {
      seen.push(request.method);
      if (request.method === 'initialize') {
        return { id: request.id, result: { codexHome: '/tmp/codex' } };
      }
      if (request.method === 'thread/goal/get') {
        assert.deepEqual(request.params, { threadId: 'thread-1' });
        return { id: request.id, result: { goal: null } };
      }
      if (request.method === 'thread/goal/clear') {
        assert.deepEqual(request.params, { threadId: 'thread-1' });
        return { id: request.id, result: { removed: true } };
      }
      throw new Error(`unexpected method ${request.method}`);
    },
  });

  await getCodexThreadGoal({
    codexBin: 'codex-test',
    spawnFn: fake.spawnFn,
    threadId: 'thread-1',
  });
  await clearCodexThreadGoal({
    codexBin: 'codex-test',
    spawnFn: fake.spawnFn,
    threadId: 'thread-1',
  });

  assert.deepEqual(seen, ['initialize', 'thread/goal/get', 'initialize', 'thread/goal/clear']);
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ['app-server', '--listen', 'stdio://'],
    ['app-server', '--listen', 'stdio://'],
  ]);
});
