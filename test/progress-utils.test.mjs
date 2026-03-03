import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendRecentActivity,
  appendCompletedStep,
  extractCompletedStepFromEvent,
  extractRawProgressTextFromEvent,
  extractPlanStateFromEvent,
  renderRecentActivitiesLines,
  summarizeCodexEvent,
} from '../src/progress-utils.js';

test('summarizeCodexEvent enriches web_search_completed with query detail', () => {
  const ev = {
    type: 'web_search_completed',
    query: 'OpenAI Codex CLI temperature setting config.toml',
  };

  const summary = summarizeCodexEvent(ev, { previewChars: 180 });
  assert.equal(summary, 'web search completed: search: OpenAI Codex CLI temperature setting config.toml');
});

test('summarizeCodexEvent handles response_item web_search_call open_page', () => {
  const ev = {
    type: 'response_item',
    payload: {
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'open_page',
        url: 'https://developers.openai.com/codex/cli/reference',
      },
    },
  };

  const summary = summarizeCodexEvent(ev, { previewChars: 180 });
  assert.equal(summary, 'web search completed: open page: developers.openai.com/codex/cli/reference');
});

test('extractCompletedStepFromEvent returns semantic web search step from response_item', () => {
  const ev = {
    type: 'response_item',
    payload: {
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'find_in_page',
        url: 'https://raw.githubusercontent.com/openai/codex/main/README.md',
        pattern: 'temperature',
      },
    },
  };

  const step = extractCompletedStepFromEvent(ev, { previewChars: 180 });
  assert.equal(step, 'web search: find "temperature" in raw.githubusercontent.com/openai/codex/main/README.md');
});

test('extractCompletedStepFromEvent ignores update_plan tool completion noise', () => {
  const ev = {
    type: 'item.completed',
    item: {
      type: 'function_call',
      name: 'update_plan',
      call: {
        arguments: '{"steps":[{"status":"completed","step":"Inspect code"}]}'
      },
    },
  };

  const step = extractCompletedStepFromEvent(ev, { previewChars: 180 });
  assert.equal(step, '');
});

test('extractPlanStateFromEvent reads nested plan from tool arguments', () => {
  const ev = {
    type: 'item.completed',
    item: {
      type: 'function_call',
      name: 'update_plan',
      call: {
        arguments: '{"explanation":"Track work","steps":[{"status":"completed","step":"Inspect parser"},{"status":"in_progress","step":"Write tests"}]}'
      },
    },
  };

  const plan = extractPlanStateFromEvent(ev, { previewChars: 180 });
  assert.ok(plan);
  assert.equal(plan.total, 2);
  assert.equal(plan.completed, 1);
  assert.equal(plan.inProgress, 1);
  assert.deepEqual(plan.steps.map((x) => x.step), ['Inspect parser', 'Write tests']);
});

test('appendCompletedStep de-duplicates and keeps newest items', () => {
  const list = ['step a', 'step b'];
  appendCompletedStep(list, 'step a', { doneStepsMax: 2, previewChars: 120 });
  appendCompletedStep(list, 'step c', { doneStepsMax: 2, previewChars: 120 });
  appendCompletedStep(list, 'step d', { doneStepsMax: 2, previewChars: 120 });

  assert.deepEqual(list, ['step b', 'step a', 'step c', 'step d']);
});

test('summarizeCodexEvent includes delta text for output_text delta events', () => {
  const ev = {
    type: 'response.output_text.delta',
    delta: '正在检查任务状态输出链路',
  };

  const summary = summarizeCodexEvent(ev, { previewChars: 180 });
  assert.equal(summary, 'agent message: 正在检查任务状态输出链路');
});

test('appendRecentActivity keeps newest unique activities', () => {
  const list = [];
  appendRecentActivity(list, 'event a', { maxSteps: 2, previewChars: 120 });
  appendRecentActivity(list, 'event b', { maxSteps: 2, previewChars: 120 });
  appendRecentActivity(list, 'event a', { maxSteps: 2, previewChars: 120 });
  appendRecentActivity(list, 'event c', { maxSteps: 2, previewChars: 120 });

  assert.deepEqual(list, ['event b', 'event a', 'event c']);
});

test('renderRecentActivitiesLines renders latest activity window', () => {
  const lines = renderRecentActivitiesLines(
    ['step 1', 'step 2', 'step 3'],
    { maxSteps: 2 },
  );
  assert.deepEqual(lines, [
    '• activity 1: step 2',
    '• activity 2: step 3',
  ]);
});

test('extractRawProgressTextFromEvent ignores low-signal web_search completion events', () => {
  const ev = {
    type: 'web_search_completed',
    query: 'OpenAI Codex CLI release notes',
  };

  const raw = extractRawProgressTextFromEvent(ev);
  assert.equal(raw, '');
});

test('extractRawProgressTextFromEvent keeps raw output_text delta text', () => {
  const ev = {
    type: 'response.output_text.delta',
    delta: '正在核对配置并准备提交修复，不做摘要模板转换。',
  };

  const raw = extractRawProgressTextFromEvent(ev);
  assert.equal(raw, '正在核对配置并准备提交修复，不做摘要模板转换。');
});

test('extractRawProgressTextFromEvent suppresses final agent_message completed snapshots', () => {
  const ev = {
    type: 'item_completed',
    item: {
      type: 'agent_message',
      text: '截至2026年3月2日，已完成排查并给出结论。',
    },
  };

  const raw = extractRawProgressTextFromEvent(ev);
  assert.equal(raw, '');
});

test('extractRawProgressTextFromEvent filters low-signal english planning text', () => {
  const ev = {
    type: 'response.output_text.delta',
    delta: 'Asking next feature choice',
  };

  const raw = extractRawProgressTextFromEvent(ev);
  assert.equal(raw, '');
});

test('extractRawProgressTextFromEvent reads commentary from event_msg agent_message', () => {
  const ev = {
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      phase: 'commentary',
      message: '正在检查日志并定位过程内容过滤条件。',
    },
  };

  const raw = extractRawProgressTextFromEvent(ev);
  assert.equal(raw, '正在检查日志并定位过程内容过滤条件。');
});

test('extractRawProgressTextFromEvent ignores final_answer from event_msg agent_message', () => {
  const ev = {
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      phase: 'final_answer',
      message: '这是最终回答，不应重复进入过程内容。',
    },
  };

  const raw = extractRawProgressTextFromEvent(ev);
  assert.equal(raw, '');
});

test('extractRawProgressTextFromEvent reads commentary from response_item assistant message', () => {
  const ev = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [
        {
          type: 'output_text',
          text: '我先搜索官方文档，再整理分步实现方案。',
        },
      ],
    },
  };

  const raw = extractRawProgressTextFromEvent(ev);
  assert.equal(raw, '我先搜索官方文档，再整理分步实现方案。');
});

test('extractRawProgressTextFromEvent ignores final_answer from response_item assistant message', () => {
  const ev = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [
        {
          type: 'output_text',
          text: '最终答案不应进入过程窗口。',
        },
      ],
    },
  };

  const raw = extractRawProgressTextFromEvent(ev);
  assert.equal(raw, '');
});

test('summarizeCodexEvent unwraps event_msg payload for summary rendering', () => {
  const ev = {
    type: 'event_msg',
    payload: {
      type: 'turn.completed',
      usage: {
        input_tokens: 123,
      },
    },
  };

  const summary = summarizeCodexEvent(ev, { previewChars: 180 });
  assert.equal(summary, 'turn completed (input tokens: 123)');
});

test('appendRecentActivity can keep full raw text without truncation', () => {
  const list = [];
  const rawText = '这是一段用于验证不截断行为的原始过程文本 '.repeat(12).trim();
  appendRecentActivity(list, rawText, {
    maxSteps: 3,
    previewChars: 60,
    truncateText: false,
    preserveWhitespace: true,
  });

  assert.equal(list.length, 1);
  assert.equal(list[0], rawText);
});
