import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendRecentActivity,
  appendCompletedStep,
  extractCompletedStepFromEvent,
  extractPlanStateFromEvent,
  renderRecentActivitiesLines,
  summarizeAudienceActivity,
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

test('summarizeAudienceActivity filters low-signal web search completion events', () => {
  const ev = {
    type: 'web_search_completed',
    query: 'OpenAI Codex CLI release notes',
  };

  const summary = summarizeAudienceActivity(ev, { previewChars: 180 });
  assert.equal(summary, '');
});

test('summarizeAudienceActivity keeps output_text delta content for audience stream', () => {
  const ev = {
    type: 'response.output_text.delta',
    delta: '正在核对配置并准备提交修复',
  };

  const summary = summarizeAudienceActivity(ev, { previewChars: 180 });
  assert.equal(summary, 'agent message: 正在核对配置并准备提交修复');
});

test('summarizeAudienceActivity suppresses agent message completed snapshot events', () => {
  const ev = {
    type: 'item_completed',
    item: {
      type: 'agent_message',
      text: '截至2026年3月2日，已完成排查并给出结论。',
    },
  };

  const summary = summarizeAudienceActivity(ev, { previewChars: 180 });
  assert.equal(summary, '');
});
