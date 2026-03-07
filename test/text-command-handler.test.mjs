import test from 'node:test';
import assert from 'node:assert/strict';

import { createTextCommandHandler } from '../src/text-command-handler.js';

function createMessage() {
  return {
    channel: { id: 'channel-1' },
  };
}

test('createTextCommandHandler replies for unknown commands', async () => {
  const replies = [];
  const session = { provider: 'codex' };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!wat');

  assert.deepEqual(replies, ['未知命令。发 `!help` 看命令列表。']);
});

test('createTextCommandHandler updates mode through shared command actions', async () => {
  const replies = [];
  const session = { provider: 'codex', mode: 'safe' };
  let saveCount = 0;

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    commandActions: {
      setMode(currentSession, mode) {
        currentSession.mode = mode;
        saveCount += 1;
        return { mode: currentSession.mode };
      },
    },
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!mode dangerous');

  assert.equal(session.mode, 'dangerous');
  assert.equal(saveCount, 1);
  assert.deepEqual(replies, ['✅ mode = dangerous']);
});
