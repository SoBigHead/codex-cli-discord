import test from 'node:test';
import assert from 'node:assert/strict';

import { safeReply } from '../src/discord-reply-utils.js';

function createLogger() {
  return {
    warn() {},
    error() {},
    log() {},
  };
}

test('safeReply recovers with the live Discord client after the original client is destroyed', async () => {
  const replies = [];
  const fetchedChannels = [];
  const fetchedMessages = [];

  const liveMessage = {
    id: 'msg-1',
    system: false,
    channel: {
      id: 'channel-1',
      async send() {
        throw new Error('unexpected channel.send');
      },
    },
    async reply(payload) {
      replies.push(payload);
      return { id: 'reply-1' };
    },
  };

  const client = {
    channels: {
      cache: new Map(),
      async fetch(channelId) {
        fetchedChannels.push(channelId);
        return {
          id: channelId,
          async send() {
            throw new Error('unexpected live channel.send');
          },
          messages: {
            async fetch(messageId) {
              fetchedMessages.push(messageId);
              return liveMessage;
            },
          },
        };
      },
    },
  };

  const staleMessage = {
    id: 'msg-1',
    channelId: 'channel-1',
    system: false,
    channel: {
      id: 'channel-1',
      async send() {
        throw new Error('unexpected stale channel.send');
      },
    },
    async reply() {
      throw new Error('Expected token to be set for this request, but none was present');
    },
  };

  const result = await safeReply(staleMessage, 'hello world', {
    logger: createLogger(),
    getActiveClient: () => client,
  });

  assert.deepEqual(fetchedChannels, ['channel-1']);
  assert.deepEqual(fetchedMessages, ['msg-1']);
  assert.deepEqual(replies, ['hello world']);
  assert.deepEqual(result, { id: 'reply-1' });
});

test('safeReply falls back to channel send after an expired interaction webhook token', async () => {
  const sent = [];

  const interaction = {
    id: 'interaction-1',
    channelId: 'channel-1',
    system: false,
    channel: {
      id: 'channel-1',
      async send(payload) {
        sent.push(payload);
        return { id: 'fallback-1' };
      },
    },
    async reply() {
      const err = new Error('Invalid Webhook Token');
      err.code = 50027;
      err.status = 401;
      err.rawError = { message: 'Invalid Webhook Token', code: 50027 };
      throw err;
    },
  };

  const result = await safeReply(interaction, 'goal complete', {
    logger: createLogger(),
  });

  assert.deepEqual(sent, ['goal complete']);
  assert.deepEqual(result, { id: 'fallback-1' });
});
