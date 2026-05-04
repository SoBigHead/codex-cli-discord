import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createChannelRuntimeStore, stopChildProcess } from '../src/channel-runtime.js';

test('createChannelRuntimeStore tracks active run and cancellation', () => {
  const store = createChannelRuntimeStore({
    cloneProgressPlan: (plan) => (plan ? JSON.parse(JSON.stringify(plan)) : null),
    truncate: (text, max) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`),
  });

  const state = store.getChannelState('thread-1');
  state.queue.push({ id: 'job-1' });

  const child = {
    pid: 12345,
    killed: false,
    kill() {
      this.killed = true;
    },
  };

  store.setActiveRun(state, { id: 'message-1' }, 'hello world', child, 'exec');
  const beforeCancel = store.getRuntimeSnapshot('thread-1');
  assert.equal(beforeCancel.phase, 'exec');
  assert.equal(beforeCancel.messageId, 'message-1');
  assert.equal(beforeCancel.queued, 1);

  const outcome = store.cancelChannelWork('thread-1', 'manual');
  assert.equal(outcome.cancelledRunning, true);
  assert.equal(outcome.clearedQueued, 1);
  assert.equal(outcome.pid, 12345);

  const afterCancel = store.getRuntimeSnapshot('thread-1');
  assert.equal(afterCancel.queued, 0);
});

test('stopChildProcess escalates when SIGTERM does not close the process', async () => {
  const signals = [];
  const child = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    signals.push(signal);
    child.killed = true;
    if (signal === 'SIGKILL') {
      child.signalCode = signal;
      child.emit('close', null, signal);
    }
    return true;
  };

  stopChildProcess(child, 5);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('stopChildProcess does not escalate after the process closes', async () => {
  const signals = [];
  const child = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    signals.push(signal);
    child.killed = true;
    child.exitCode = 0;
    child.emit('close', 0, null);
    return true;
  };

  stopChildProcess(child, 5);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(signals, ['SIGTERM']);
});

test('stopChildProcess ignores duplicate stop requests while shutdown is pending', async () => {
  const signals = [];
  const child = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    signals.push(signal);
    child.killed = true;
    if (signal === 'SIGKILL') {
      child.signalCode = signal;
      child.emit('close', null, signal);
    }
    return true;
  };

  stopChildProcess(child, 5);
  stopChildProcess(child, 5);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
