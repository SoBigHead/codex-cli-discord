import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPromptFromMessage,
  doesMessageTargetBot,
  formatAttachmentsForPrompt,
} from '../src/discord-message-input.js';

test('doesMessageTargetBot matches mentions and replies to bot', () => {
  const mentionedMessage = {
    mentions: {
      users: {
        has(id) {
          return id === 'bot-1';
        },
      },
      repliedUser: null,
    },
  };
  const repliedMessage = {
    mentions: {
      users: {
        has() {
          return false;
        },
      },
      repliedUser: { id: 'bot-1' },
    },
  };

  assert.equal(doesMessageTargetBot(mentionedMessage, 'bot-1'), true);
  assert.equal(doesMessageTargetBot(repliedMessage, 'bot-1'), true);
  assert.equal(doesMessageTargetBot({ mentions: null }, 'bot-1'), false);
});

test('buildPromptFromMessage appends formatted attachments and handles attachment-only messages', () => {
  const attachments = new Map([
    ['a', { name: 'report.txt', contentType: 'text/plain', size: 12, url: 'https://example.com/report.txt' }],
  ]);

  assert.match(buildPromptFromMessage('hello', attachments), /hello/);
  assert.match(buildPromptFromMessage('hello', attachments), /Attachments:/);
  assert.match(buildPromptFromMessage('', attachments), /用户发送了附件/);
});

test('formatAttachmentsForPrompt truncates after 8 entries', () => {
  const attachments = new Map();
  for (let i = 1; i <= 10; i += 1) {
    attachments.set(`${i}`, {
      name: `file-${i}.txt`,
      contentType: 'text/plain',
      size: i,
      url: `https://example.com/${i}`,
    });
  }

  const rendered = formatAttachmentsForPrompt(attachments);
  assert.match(rendered, /1\. name=file-1\.txt/);
  assert.match(rendered, /\.\.\.and 2 more attachment\(s\)\./);
});
