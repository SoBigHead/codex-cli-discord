import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProgressEventDedupeKey,
  composeFinalAnswerText,
  createProgressEventDeduper,
  extractAgentMessageText,
  getAgentMessagePhase,
  isFinalAnswerLikeAgentMessage,
} from '../src/codex-event-utils.js';
import {
  extractRawProgressTextFromEvent,
  summarizeCodexEvent,
} from '../src/progress-utils.js';

test('extractAgentMessageText reads direct text and content fallback', () => {
  assert.equal(
    extractAgentMessageText({ type: 'agent_message', text: '  第一段  ' }),
    '第一段',
  );
  assert.equal(
    extractAgentMessageText({
      type: 'agent_message',
      content: [{ type: 'output_text', text: '第二段' }],
    }),
    '第二段',
  );
});

test('getAgentMessagePhase normalizes phase and defaults empty', () => {
  assert.equal(getAgentMessagePhase({ phase: 'Final.Answer' }), 'final_answer');
  assert.equal(getAgentMessagePhase({}), '');
});

test('isFinalAnswerLikeAgentMessage excludes commentary items', () => {
  assert.equal(
    isFinalAnswerLikeAgentMessage({ type: 'agent_message', phase: 'commentary', text: '过程消息' }),
    false,
  );
  assert.equal(
    isFinalAnswerLikeAgentMessage({ type: 'agent_message', phase: 'final_answer', text: '最终答案' }),
    true,
  );
  assert.equal(
    isFinalAnswerLikeAgentMessage({ type: 'agent_message', text: '无 phase 也按最终答案处理' }),
    true,
  );
});

test('composeFinalAnswerText keeps all final answer segments', () => {
  const text = composeFinalAnswerText({
    messages: ['过程消息', '最终答案 A', '最终答案 B'],
    finalAnswerMessages: ['最终答案 A', '最终答案 B'],
  });
  assert.equal(text, '最终答案 A\n\n最终答案 B');
});

test('composeFinalAnswerText falls back to latest message when no final segments', () => {
  const text = composeFinalAnswerText({
    messages: ['过程消息 A', '过程消息 B'],
    finalAnswerMessages: [],
  });
  assert.equal(text, '过程消息 B');
});

test('buildProgressEventDedupeKey prefers raw activity and normalizes case/space', () => {
  const key = buildProgressEventDedupeKey({
    summaryStep: 'agent message: 正在检查日志',
    rawActivity: '  正在检查日志  ',
    completedStep: '',
    planSummary: '',
  });
  assert.equal(key, 'raw:正在检查日志');
});

test('createProgressEventDeduper drops duplicates only inside ttl window', () => {
  const isDuplicate = createProgressEventDeduper({ ttlMs: 3000, maxKeys: 16 });
  assert.equal(isDuplicate('raw:正在检查日志', 1000), false);
  assert.equal(isDuplicate('raw:正在检查日志', 1200), true);
  assert.equal(isDuplicate('raw:正在检查日志', 4500), false);
});

test('bridge and stdout events map to one dedupe key for same activity text', () => {
  const stdoutEvent = {
    type: 'response.output_text.delta',
    delta: '正在检查日志并合并重复事件',
  };
  const bridgeEvent = {
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      phase: 'commentary',
      message: '正在检查日志并合并重复事件',
    },
  };

  const stdoutKey = buildProgressEventDedupeKey({
    summaryStep: summarizeCodexEvent(stdoutEvent, { previewChars: 180 }),
    rawActivity: extractRawProgressTextFromEvent(stdoutEvent),
  });
  const bridgeKey = buildProgressEventDedupeKey({
    summaryStep: summarizeCodexEvent(bridgeEvent, { previewChars: 180 }),
    rawActivity: extractRawProgressTextFromEvent(bridgeEvent),
  });

  assert.equal(stdoutKey, bridgeKey);
  const isDuplicate = createProgressEventDeduper({ ttlMs: 3000, maxKeys: 16 });
  assert.equal(isDuplicate(stdoutKey, 1000), false);
  assert.equal(isDuplicate(bridgeKey, 1300), true);
});
