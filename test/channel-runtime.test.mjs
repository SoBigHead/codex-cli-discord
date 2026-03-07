import test from 'node:test';
import assert from 'node:assert/strict';

import { createChannelRuntimeStore } from '../src/channel-runtime.js';

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
