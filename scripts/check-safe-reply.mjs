#!/usr/bin/env node

import assert from 'node:assert/strict';
import { isReplyToSystemMessageError, safeReply } from '../src/discord-reply-utils.js';

function buildDiscordSystemReplyError() {
  const err = new Error('Invalid Form Body');
  err.code = 50035;
  err.rawError = {
    message: 'Invalid Form Body',
    code: 50035,
    errors: {
      message_reference: {
        _errors: [
          {
            code: 'REPLIES_CANNOT_REPLY_TO_SYSTEM_MESSAGE',
            message: 'Cannot reply to a system message',
          },
        ],
      },
    },
  };
  return err;
}

async function run() {
  const byMessageOnly = new Error('message_reference[REPLIES_CANNOT_REPLY_TO_SYSTEM_MESSAGE]');
  assert.equal(isReplyToSystemMessageError(byMessageOnly), true);
  assert.equal(isReplyToSystemMessageError(buildDiscordSystemReplyError()), true);
  assert.equal(isReplyToSystemMessageError(new Error('other error')), false);

  const directReply = {
    id: 'm1',
    reply: async (payload) => ({ via: 'reply', payload }),
    channel: {
      send: async (payload) => ({ via: 'send', payload }),
    },
  };
  const directResult = await safeReply(directReply, 'ok', { logger: { warn() {} } });
  assert.deepEqual(directResult, { via: 'reply', payload: 'ok' });

  const fallbackReply = {
    id: 'm2',
    reply: async () => {
      throw buildDiscordSystemReplyError();
    },
    channel: {
      send: async (payload) => ({ via: 'send', payload }),
    },
  };
  const fallbackResult = await safeReply(fallbackReply, 'fallback-ok', { logger: { warn() {} } });
  assert.deepEqual(fallbackResult, { via: 'send', payload: 'fallback-ok' });

  let systemReplyCalled = false;
  const systemMessage = {
    id: 'm-system',
    system: true,
    reply: async () => {
      systemReplyCalled = true;
      throw new Error('reply should not be called for system message');
    },
    channel: {
      send: async (payload) => ({ via: 'send', payload }),
    },
  };
  const systemResult = await safeReply(systemMessage, {
    content: 'system-fallback',
    message_reference: { message_id: 'x' },
  }, { logger: { warn() {} } });
  assert.equal(systemReplyCalled, false);
  assert.deepEqual(systemResult, { via: 'send', payload: { content: 'system-fallback' } });

  const nonFallbackReply = {
    id: 'm3',
    reply: async () => {
      throw new Error('boom');
    },
    channel: {
      send: async (payload) => ({ via: 'send', payload }),
    },
  };
  await assert.rejects(async () => {
    await safeReply(nonFallbackReply, 'x', { logger: { warn() {} } });
  }, /boom/);

  console.log('[check-safe-reply] ok');
}

run().catch((err) => {
  console.error('[check-safe-reply] failed:', err);
  process.exit(1);
});
