import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProgressEventDedupeKey,
  createProgressEventDeduper,
} from '../src/codex-event-utils.js';
import { createPromptProgressReporterFactory } from '../src/prompt-progress-reporter.js';
import { createRuntimePresentation } from '../src/runtime-presentation.js';

function clonePlan(plan) {
  return plan ? JSON.parse(JSON.stringify(plan)) : null;
}

function appendUnique(list, value) {
  const text = String(value || '').trim();
  if (!text || list.includes(text)) return;
  list.push(text);
}

function createRealPresentation() {
  return createRuntimePresentation({
    showReasoning: false,
    progressTextPreviewChars: 120,
    progressDoneStepsMax: 4,
    progressActivityMaxLines: 5,
    progressProcessLines: 5,
    humanAge: (ms) => `${ms}ms`,
    getSessionId: (session) => session?.runnerSessionId || null,
    getSessionProvider: (session) => session?.provider || 'codex',
    formatSessionIdLabel: (sessionId) => `\`${sessionId || 'auto'}\``,
  });
}

function createHarness(overrides = {}) {
  let currentNow = 10_000;
  const sent = [];
  const edits = [];
  const streamed = [];
  const intervals = [];
  const cleared = [];
  const channelState = {
    queue: ['queued-1'],
    activeRun: {
      phase: 'workspace',
      progressPlan: null,
      completedSteps: [],
      recentActivities: [],
    },
  };
  const message = { id: 'msg-1', author: { id: '12345' } };

  const createProgressReporter = createPromptProgressReporterFactory({
    defaultUiLanguage: 'zh',
    progressUpdatesEnabled: true,
    progressProcessLines: 2,
    progressUpdateIntervalMs: 5000,
    progressEventFlushMs: 0,
    progressEventDedupeWindowMs: 2500,
    progressIncludeStdout: true,
    progressIncludeStderr: false,
    progressTextPreviewChars: 120,
    progressProcessPushIntervalMs: 1000,
    progressMessageMaxChars: 1800,
    progressPlanMaxLines: 4,
    progressDoneStepsMax: 4,
    safeReply: async (_message, body) => {
      sent.push(body);
      return {
        id: 'progress-1',
        async edit(nextBody) {
          edits.push(nextBody);
        },
      };
    },
    normalizeUiLanguage: (value) => (String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh'),
    slashRef: (name) => `/bot-${name}`,
    resolveModelSetting: (session) => ({
      value: session?.model || 'gpt-5.4',
      source: session?.model ? 'session override' : 'config.toml',
    }),
    resolveReasoningEffortSetting: (session) => ({
      value: session?.effort || 'high',
      source: session?.effort ? 'session override' : 'config.toml',
    }),
    resolveFastModeSetting: (session) => ({
      enabled: Boolean(session?.fastMode),
      supported: session?.provider === 'codex',
      source: session?.fastMode ? 'session override' : 'config.toml',
    }),
    truncate: (text, max) => {
      const value = String(text || '');
      return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
    },
    humanElapsed: (ms) => `${ms}ms`,
    createProgressEventDeduper,
    buildProgressEventDedupeKey,
    presentation: {
      summarizeCodexEvent: (event) => event.summaryStep || '',
      extractRawProgressTextFromEvent: (event) => event.rawActivity || '',
      cloneProgressPlan: clonePlan,
      extractPlanStateFromEvent: (event) => clonePlan(event.planState),
      extractCompletedStepFromEvent: (event) => event.completedStep || '',
      appendCompletedStep: appendUnique,
      appendRecentActivity: appendUnique,
      formatProgressPlanSummary: (planState) => JSON.stringify(planState?.steps || []),
      renderProcessContentLines: (activities, _language, count) => (
        activities.slice(-count).map((line) => `process: ${line}`)
      ),
      localizeProgressLines: (lines) => lines,
      renderProgressPlanLines: (planState) => (
        Array.isArray(planState?.steps) && planState.steps.length
          ? [`plan: ${planState.steps.length}`]
          : []
      ),
      renderCompletedStepsLines: (steps) => steps.map((step) => `done: ${step}`),
      formatRuntimePhaseLabel: (phase) => String(phase || ''),
    },
    now: () => currentNow,
    setIntervalFn: (fn, ms) => {
      const handle = { fn, ms, unref() {} };
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn: (handle) => {
      cleared.push(handle);
    },
    onStreamProcessMessage: async (text) => {
      streamed.push(text);
    },
    ...overrides.factoryOptions,
  });

  return {
    sent,
    edits,
    streamed,
    intervals,
    cleared,
    channelState,
    message,
    reporter: createProgressReporter({
      message,
      channelState,
      session: overrides.session || { provider: 'codex', fastMode: true },
      language: overrides.language || 'en',
      initialLatestStep: overrides.initialLatestStep || 'Waiting for workspace lock: /repo/demo',
    }),
    advance(ms) {
      currentNow += ms;
    },
  };
}

test('createPromptProgressReporterFactory seeds initial step and updates final progress card', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  assert.match(harness.sent[0].content, /Waiting for workspace lock: \/repo\/demo/);
  assert.deepEqual(harness.sent[0].components, []);
  assert.match(harness.sent[0].content, /effort: high/);
  assert.match(harness.sent[0].content, /fast mode: on \(this channel\)/);
  assert.match(harness.sent[0].content, /!c/);
  assert.doesNotMatch(harness.sent[0].content, /\/bot-status/);
  assert.doesNotMatch(harness.sent[0].content, /!cancel/);
  assert.equal(harness.channelState.activeRun.lastProgressText, 'Waiting for workspace lock: /repo/demo');
  assert.equal(harness.channelState.activeRun.progressMessageId, 'progress-1');

  harness.channelState.activeRun.phase = 'exec';
  harness.advance(50);
  harness.reporter.setLatestStep('Workspace lock acquired: /repo/demo');
  assert.match(harness.edits[0].content, /Workspace lock acquired: \/repo\/demo/);
  assert.deepEqual(harness.edits[0].components, []);

  await harness.reporter.finish({ ok: true });
  assert.match(harness.edits[harness.edits.length - 1].content, /✅ \*\*Task Completed\*\*/);
  assert.match(harness.edits[harness.edits.length - 1].content, /• phase: done/);
  assert.match(harness.edits[harness.edits.length - 1].content, /• latest activity: Final response sent/);
  assert.deepEqual(harness.edits[harness.edits.length - 1].components, []);
  assert.equal(harness.channelState.activeRun.phase, 'done');
  assert.equal(harness.cleared.length, 2);
});

test('createPromptProgressReporterFactory dedupes repeated events and keeps activity on the final card', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  const planState = {
    steps: [
      { step: 'Inspect code', status: 'completed' },
      { step: 'Edit code', status: 'in_progress' },
    ],
  };

  harness.reporter.onEvent({
    summaryStep: 'Searching files',
    rawActivity: 'rg src',
    planState,
  });
  harness.reporter.onEvent({
    summaryStep: 'Searching files',
    rawActivity: 'rg src',
    planState,
  });
  harness.reporter.onEvent({
    summaryStep: 'Updating tests',
    rawActivity: 'rg test',
    completedStep: 'Patch orchestrator',
  });

  assert.equal(harness.channelState.activeRun.progressEvents, 2);
  assert.deepEqual(harness.channelState.activeRun.completedSteps, ['Inspect code', 'Patch orchestrator']);
  assert.deepEqual(harness.channelState.activeRun.recentActivities, ['rg src', 'rg test']);

  await harness.reporter.finish({ ok: true });

  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.match(finalCard, /process: rg src/);
  assert.match(finalCard, /process: rg test/);
  assert.match(finalCard, /done: Inspect code/);
  assert.match(finalCard, /done: Patch orchestrator/);
});

test('createPromptProgressReporterFactory can stream deduped process messages while keeping the progress card', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    summaryStep: 'Inspecting repo',
    rawActivity: '我先检查一下这个仓库的入口文件。',
  });
  harness.reporter.onEvent({
    summaryStep: 'Inspecting repo',
    rawActivity: '我先检查一下这个仓库的入口文件。',
  });
  harness.advance(1200);
  harness.intervals.find((handle) => handle.ms === 1000)?.fn();

  assert.deepEqual(harness.streamed, ['我先检查一下这个仓库的入口文件。']);
  assert.match(harness.edits.at(-1).content, /process: 我先检查一下这个仓库的入口文件。/);
});

test('createPromptProgressReporterFactory streams during the run without dumping backlog on finish', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    summaryStep: 'Step 1',
    rawActivity: '过程消息 1',
  });
  harness.reporter.onEvent({
    summaryStep: 'Step 2',
    rawActivity: '过程消息 2',
  });
  harness.reporter.onEvent({
    summaryStep: 'Step 3',
    rawActivity: '过程消息 3',
  });

  assert.deepEqual(harness.streamed, ['过程消息 1']);
  assert.deepEqual(harness.channelState.activeRun.recentActivities, ['过程消息 1', '过程消息 2', '过程消息 3']);

  harness.advance(1200);
  harness.intervals.find((handle) => handle.ms === 1000)?.fn();

  assert.deepEqual(harness.streamed, ['过程消息 1', '过程消息 2']);

  await harness.reporter.finish({ ok: true });

  assert.deepEqual(harness.streamed, ['过程消息 1', '过程消息 2']);
  assert.match(harness.edits.at(-1).content, /process: 过程消息 3/);
});

test('createPromptProgressReporterFactory ignores stderr when disabled and keeps stdout progress', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onLog('warning', 'stderr');
  assert.equal(harness.channelState.activeRun.progressEvents, 0);

  harness.reporter.onLog('stdout line', 'stdout');
  assert.equal(harness.channelState.activeRun.progressEvents, 1);
  assert.equal(harness.channelState.activeRun.lastProgressText, 'stdout: stdout line');
  assert.match(harness.edits[harness.edits.length - 1].content, /stdout: stdout line/);
});

test('createPromptProgressReporterFactory truncates overflowing cards on line boundaries', async () => {
  const harness = createHarness({
    factoryOptions: {
      progressMessageMaxChars: 70,
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({ summaryStep: 'Locate regression', rawActivity: 'inspect dispatcher' });
  harness.reporter.onEvent({ summaryStep: 'Inspect renderer', rawActivity: 'inspect renderer' });
  harness.reporter.onEvent({ summaryStep: 'Inspect bridge', rawActivity: 'inspect bridge' });
  harness.reporter.onEvent({ summaryStep: 'Patch tests', rawActivity: 'patch tests' });

  const runningCard = harness.edits[harness.edits.length - 1].content;
  assert.match(runningCard, /\n\.\.\.$/);

  await harness.reporter.finish({ ok: true });
  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.match(finalCard, /\n\.\.\.$/);
});

test('createPromptProgressReporterFactory includes model line in running and final cards', async () => {
  const harness = createHarness({
    session: {
      provider: 'codex',
      model: 'gpt-5.3-codex',
    },
    factoryOptions: {
      resolveModelSetting: (session) => ({
        value: session?.model,
        source: session?.model ? 'session override' : 'provider',
      }),
    },
  });

  await harness.reporter.start();
  await harness.reporter.finish({ ok: true });

  assert.match(harness.sent[0].content, /• model: `gpt-5\.3-codex` \(session override\)/);
  assert.match(harness.edits[harness.edits.length - 1].content, /• model: `gpt-5\.3-codex` \(session override\)/);
});

test('createPromptProgressReporterFactory shows resolved default model instead of provider default text', async () => {
  const harness = createHarness({
    session: {
      provider: 'codex',
    },
  });

  await harness.reporter.start();

  assert.match(harness.sent[0].content, /• model: `gpt-5\.4` \(config\.toml\)/);
  assert.doesNotMatch(harness.sent[0].content, /provider default|provider 默认/);
});

test('createPromptProgressReporterFactory derives Claude commentary and tool progress from stream events', async () => {
  const harness = createHarness({
    session: { provider: 'claude' },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'message_start',
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: '',
      },
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: '我来查看',
      },
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: '当前目录。',
      },
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_stop',
      index: 0,
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'call_pwd',
        name: 'Bash',
        input: {},
      },
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"command":"pwd","description":"Show current working directory"}',
      },
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_stop',
      index: 1,
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'message_delta',
      delta: {
        stop_reason: 'tool_use',
      },
    },
  });
  harness.reporter.onEvent({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_pwd',
          content: '/tmp/demo',
        },
      ],
    },
  });

  await harness.reporter.finish({ ok: true });

  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.match(finalCard, /process: 我来查看当前目录。/);
  assert.match(finalCard, /process: Show current working directory/);
  assert.match(finalCard, /done: Show current working directory/);
});

test('createPromptProgressReporterFactory does not let Claude system noise hide API errors', async () => {
  const harness = createHarness({
    session: { provider: 'claude' },
    factoryOptions: {
      presentation: createRealPresentation(),
      progressProcessLines: 5,
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
  });
  assert.equal(harness.channelState.activeRun.lastProgressText, 'Waiting for workspace lock: /repo/demo');

  harness.reporter.onEvent({
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'API Error: 429 {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"},"request_id":"req_123"}',
      }],
    },
  });

  assert.equal(harness.channelState.activeRun.lastProgressText, 'API error 429: 您的账户已达到速率限制，请您控制请求频率');
  await new Promise((resolve) => setImmediate(resolve));
  const runningCard = harness.edits[harness.edits.length - 1].content;
  assert.match(runningCard, /latest activity: API error 429: 您的账户已达到速率限制，请您控制请求频率/);
  assert.doesNotMatch(runningCard, /latest activity: system/);
});

test('createPromptProgressReporterFactory renders codex subagent lifecycle events on the live card', async () => {
  const harness = createHarness({
    factoryOptions: {
      progressProcessLines: 5,
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'spawn_agent',
      arguments: JSON.stringify({
        agent_type: 'worker',
        message: 'Verify the Discord progress card shows sub tasks in real time.',
      }),
      call_id: 'call_spawn_1',
    },
  });
  assert.match(harness.edits[0].content, /subagent worker starting: Verify the Discord progress card shows sub tasks in real time\./);

  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call_spawn_1',
      output: JSON.stringify({
        agent_id: '019d5809-05fe-7b90-a4d5-c76249a0be23',
        nickname: 'Harvey',
      }),
    },
  });
  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'send_input',
      arguments: JSON.stringify({
        target: '019d5809-05fe-7b90-a4d5-c76249a0be23',
        interrupt: true,
        message: 'Re-check the sub flow after the parent task changed.',
      }),
      call_id: 'call_send_1',
    },
  });
  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'wait_agent',
      arguments: JSON.stringify({
        targets: ['019d5809-05fe-7b90-a4d5-c76249a0be23'],
        timeout_ms: 1000,
      }),
      call_id: 'call_wait_1',
    },
  });
  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call_wait_1',
      output: JSON.stringify({
        status: {},
        timed_out: true,
      }),
    },
  });
  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '<subagent_notification>\n{"agent_path":"019d5809-05fe-7b90-a4d5-c76249a0be23","status":{"completed":"Subagent finished the verification run and attached evidence."}}\n</subagent_notification>',
        },
      ],
    },
  });

  await harness.reporter.finish({ ok: true });

  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.match(finalCard, /subagent started: Harvey \(019d5809-05fe\)/);
  assert.match(finalCard, /subagent update 019d5809-05fe: Re-check the sub flow after the parent task changed\./);
  assert.match(finalCard, /waiting for subagent 019d5809-05fe/);
  assert.match(finalCard, /subagent wait timed out/);
  assert.match(finalCard, /subagent report 019d5809-05fe: Subagent finished the verification run and attached evidence\./);
  assert.match(finalCard, /subagent completed: 019d5809-05fe/);
});

test('createPromptProgressReporterFactory sanitizes Discord spoiler markers in surfaced progress text', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    summaryStep: 'Checking cache || fallback',
    rawActivity: 'command || true',
    completedStep: 'verified || done',
  });

  const runningCard = harness.edits[harness.edits.length - 1].content;
  assert.doesNotMatch(runningCard, /\|\|/);
  assert.match(runningCard, /Checking cache ｜｜ fallback/);

  await harness.reporter.finish({ ok: true });
  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.doesNotMatch(finalCard, /\|\|/);
  assert.match(finalCard, /command ｜｜ true/);
  assert.match(finalCard, /verified ｜｜ done/);
});
