import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimePresentation } from '../src/runtime-presentation.js';

function createPresentation(overrides = {}) {
  return createRuntimePresentation({
    showReasoning: false,
    progressTextPreviewChars: 80,
    progressDoneStepsMax: 2,
    progressActivityMaxLines: 2,
    progressProcessLines: 2,
    humanAge: (ms) => `${Math.round(ms / 1000)}s`,
    getSessionId: (session) => session?.runnerSessionId || null,
    getSessionProvider: (session) => session?.provider || 'codex',
    formatSessionIdLabel: (sessionId) => `\`${sessionId || 'auto'}\``,
    ...overrides,
  });
}

test('runtime presentation formats runtime/session/permission labels', () => {
  const presentation = createPresentation();

  assert.equal(presentation.formatRuntimePhaseLabel('workspace', 'en'), 'waiting for workspace');
  assert.equal(presentation.formatRuntimePhaseLabel('retry', 'zh'), '重试中');
  assert.equal(presentation.formatTimeoutLabel(60_000), '60000ms (~60s)');
  assert.equal(
    presentation.formatSessionStatusLabel({ name: 'demo', runnerSessionId: 'sess-1' }),
    '**demo** (`sess-1`)',
  );
  assert.equal(
    presentation.formatPermissionsLabel({ provider: 'gemini', mode: 'dangerous' }, 'en'),
    'full access (--yolo)',
  );
  assert.equal(
    presentation.formatPermissionsLabel({ provider: 'claude', mode: 'safe' }, 'zh'),
    '自动编辑（--permission-mode acceptEdits）',
  );
});

test('runtime presentation localizes and renders process/progress helper lines', () => {
  const presentation = createPresentation();

  assert.deepEqual(
    presentation.localizeProgressLines(['• plan: received', '• completed steps: boot'], 'zh'),
    ['• 计划：已接收', '• 已完成步骤：boot'],
  );
  assert.deepEqual(
    presentation.renderProcessContentLines(['step a', 'step b', 'step c'], 'en', 2),
    ['• process content:', '  · step b', '  · step c'],
  );
});

test('runtime presentation wraps progress list mutation with configured limits', () => {
  const presentation = createPresentation();
  const completed = [];
  const activities = [];

  presentation.appendCompletedStep(completed, 'step a');
  presentation.appendCompletedStep(completed, 'step b');
  presentation.appendCompletedStep(completed, 'step c');
  presentation.appendRecentActivity(activities, 'activity a');
  presentation.appendRecentActivity(activities, 'activity b');
  presentation.appendRecentActivity(activities, 'activity c');

  assert.deepEqual(
    presentation.renderRecentActivitiesLines(activities, 2),
    ['• activity 1: activity b', '• activity 2: activity c'],
  );
  assert.match(presentation.formatCompletedStepsSummary(completed), /step b/);
  assert.match(presentation.formatCompletedStepsSummary(completed), /step c/);
  assert.doesNotMatch(presentation.formatCompletedStepsSummary(completed), /step a/);
});
