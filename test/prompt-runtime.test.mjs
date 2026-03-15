import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptRuntime } from '../src/prompt-runtime.js';

test('createPromptRuntime wires presentation runtime runner orchestrator and queue', async () => {
  const calls = {
    channelQueue: null,
    channelRuntimeStore: null,
    promptOrchestrator: null,
    progressReporterFactory: null,
    runtimePresentation: null,
    runnerExecutor: null,
    sessionProgressBridge: null,
  };
  const presentation = {
    appendCompletedStep() {},
    appendRecentActivity() {},
    cloneProgressPlan: (plan) => ({ ...plan }),
    extractCompletedStepFromEvent: () => 'step',
    extractPlanStateFromEvent: () => ({ steps: [] }),
    extractRawProgressTextFromEvent: () => 'raw',
    formatCompletedStepsSummary: () => 'steps',
    formatPermissionsLabel: () => 'permissions',
    formatProgressPlanSummary: () => 'plan',
    formatRuntimeLabel: () => 'runtime',
    formatRuntimePhaseLabel: () => 'phase',
    formatSessionStatusLabel: () => 'session',
    formatTimeoutLabel: () => 'timeout',
    localizeProgressLines: (lines) => lines,
    renderCompletedStepsLines: () => [],
    renderProcessContentLines: () => [],
    renderProgressPlanLines: () => [],
    renderRecentActivitiesLines: () => [],
    summarizeCodexEvent: () => 'summary',
  };
  const channelRuntimeStore = {
    getChannelState: () => 'channel-state',
    setActiveRun: () => 'set-active-run',
    cancelChannelWork: () => 'cancel-one',
    cancelAllChannelWork: () => 'cancel-all',
    getRuntimeSnapshot: () => 'snapshot',
    rememberFailedPrompt: () => 'remember-failed',
    clearLastFailedPrompt: () => 'clear-failed',
    getLastFailedPrompt: () => 'last-failed',
  };
  const bridgeFactory = {
    startSessionProgressBridge: () => 'stop-bridge',
  };
  const runnerCalls = [];
  const runnerExecutor = {
    runProviderTask: async (options) => {
      runnerCalls.push(options);
      return { ok: true, options };
    },
  };
  const promptOrchestrator = {
    handlePrompt: () => 'handled-prompt',
  };
  const channelQueue = {
    enqueuePrompt: () => 'queued-prompt',
    retryLastPrompt: () => 'retried-prompt',
  };
  const createProgressReporter = () => ({
    async start() {},
    sync() {},
    setLatestStep() {},
    onEvent() {},
    onLog() {},
    async finish() {},
  });

  const runtime = createPromptRuntime({
    runtimePresentationOptions: { showReasoning: true },
    channelRuntimeStoreOptions: { truncate: (value) => value },
    sessionProgressBridgeOptions: { normalizeProvider: () => 'codex' },
    runnerExecutorOptions: { debugEvents: true },
    promptOrchestratorOptions: {
      slashRef: (name) => `/bot-${name}`,
      formatWorkspaceBusyReport: () => 'busy',
      createProgressEventDeduper: () => () => false,
      buildProgressEventDedupeKey: () => 'key',
      extractInputTokensFromUsage: () => null,
      composeFinalAnswerText: () => 'answer',
    },
    channelQueueOptions: {
      safeReply: async () => {},
      getCurrentUserId: () => 'bot-user',
    },
    factories: {
      createChannelQueueFn: (options) => {
        calls.channelQueue = options;
        return channelQueue;
      },
      createChannelRuntimeStoreFn: (options) => {
        calls.channelRuntimeStore = options;
        return channelRuntimeStore;
      },
      createPromptOrchestratorFn: (options) => {
        calls.promptOrchestrator = options;
        return promptOrchestrator;
      },
      createPromptProgressReporterFactoryFn: (options) => {
        calls.progressReporterFactory = options;
        return createProgressReporter;
      },
      createRuntimePresentationFn: (options) => {
        calls.runtimePresentation = options;
        return presentation;
      },
      createRunnerExecutorFn: (options) => {
        calls.runnerExecutor = options;
        return runnerExecutor;
      },
      createSessionProgressBridgeFactoryFn: (options) => {
        calls.sessionProgressBridge = options;
        return bridgeFactory;
      },
    },
  });

  assert.deepEqual(calls.runtimePresentation, { showReasoning: true });
  assert.equal(calls.channelRuntimeStore.cloneProgressPlan, presentation.cloneProgressPlan);
  assert.equal(calls.runnerExecutor.startSessionProgressBridge, bridgeFactory.startSessionProgressBridge);
  assert.equal(calls.progressReporterFactory.presentation, presentation);
  assert.equal(calls.progressReporterFactory.safeReply, undefined);
  assert.equal(calls.promptOrchestrator.setActiveRun, channelRuntimeStore.setActiveRun);
  assert.equal(calls.promptOrchestrator.createProgressReporter, createProgressReporter);
  assert.equal(calls.promptOrchestrator.formatTimeoutLabel, presentation.formatTimeoutLabel);
  assert.equal(calls.channelQueue.getChannelState, channelRuntimeStore.getChannelState);
  assert.equal(calls.channelQueue.handlePrompt, promptOrchestrator.handlePrompt);
  assert.equal(calls.channelQueue.rememberFailedPrompt, channelRuntimeStore.rememberFailedPrompt);
  assert.equal(calls.channelQueue.clearLastFailedPrompt, channelRuntimeStore.clearLastFailedPrompt);
  assert.equal(calls.channelQueue.getLastFailedPrompt, channelRuntimeStore.getLastFailedPrompt);

  const runResult = await calls.promptOrchestrator.runTask({ prompt: 'demo' });
  assert.deepEqual(runResult, { ok: true, options: { prompt: 'demo' } });
  assert.deepEqual(runnerCalls, [{ prompt: 'demo' }]);

  assert.equal(runtime.enqueuePrompt, channelQueue.enqueuePrompt);
  assert.equal(runtime.retryLastPrompt, channelQueue.retryLastPrompt);
  assert.equal(runtime.getRuntimeSnapshot, channelRuntimeStore.getRuntimeSnapshot);
  assert.equal(runtime.cancelChannelWork, channelRuntimeStore.cancelChannelWork);
  assert.equal(runtime.cancelAllChannelWork, channelRuntimeStore.cancelAllChannelWork);
  assert.equal(runtime.formatRuntimeLabel, presentation.formatRuntimeLabel);
  assert.equal(runtime.formatPermissionsLabel, presentation.formatPermissionsLabel);
  assert.equal(runtime.runProviderTask, runnerExecutor.runProviderTask);
  assert.equal(runtime.runCodex, runnerExecutor.runProviderTask);
  assert.equal(runtime.startSessionProgressBridge, bridgeFactory.startSessionProgressBridge);
});
