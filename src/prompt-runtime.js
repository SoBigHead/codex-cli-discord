import { createChannelQueue } from './channel-queue.js';
import { createChannelRuntimeStore } from './channel-runtime.js';
import { createPromptOrchestrator } from './prompt-orchestrator.js';
import { createPromptProgressReporterFactory } from './prompt-progress-reporter.js';
import { createRuntimePresentation } from './runtime-presentation.js';
import { createRunnerExecutor } from './runner-executor.js';
import { createSessionProgressBridgeFactory } from './session-progress-bridge.js';

export function createPromptRuntime({
  runtimePresentationOptions = {},
  channelRuntimeStoreOptions = {},
  sessionProgressBridgeOptions = {},
  runnerExecutorOptions = {},
  promptOrchestratorOptions = {},
  channelQueueOptions = {},
  factories = {},
} = {}) {
  const {
    createChannelQueueFn = createChannelQueue,
    createChannelRuntimeStoreFn = createChannelRuntimeStore,
    createPromptOrchestratorFn = createPromptOrchestrator,
    createPromptProgressReporterFactoryFn = createPromptProgressReporterFactory,
    createRuntimePresentationFn = createRuntimePresentation,
    createRunnerExecutorFn = createRunnerExecutor,
    createSessionProgressBridgeFactoryFn = createSessionProgressBridgeFactory,
  } = factories;

  const presentation = createRuntimePresentationFn(runtimePresentationOptions);
  const channelRuntimeStore = createChannelRuntimeStoreFn({
    ...channelRuntimeStoreOptions,
    cloneProgressPlan: presentation.cloneProgressPlan,
  });
  const {
    getChannelState,
    setActiveRun,
    cancelChannelWork,
    cancelAllChannelWork,
    getRuntimeSnapshot,
    rememberFailedPrompt,
    clearLastFailedPrompt,
    getLastFailedPrompt,
  } = channelRuntimeStore;

  const { startSessionProgressBridge } = createSessionProgressBridgeFactoryFn(sessionProgressBridgeOptions);
  const runnerExecutor = createRunnerExecutorFn({
    ...runnerExecutorOptions,
    startSessionProgressBridge,
  });
  const runProviderTask = runnerExecutor.runProviderTask || runnerExecutor.runCodex;
  const createProgressReporter = createPromptProgressReporterFactoryFn({
    ...promptOrchestratorOptions,
    presentation,
  });
  const { handlePrompt } = createPromptOrchestratorFn({
    ...promptOrchestratorOptions,
    createProgressReporter,
    formatTimeoutLabel: presentation.formatTimeoutLabel,
    setActiveRun,
    runTask: (options) => runProviderTask(options),
  });
  const { enqueuePrompt, retryLastPrompt } = createChannelQueueFn({
    ...channelQueueOptions,
    getChannelState,
    handlePrompt,
    rememberFailedPrompt,
    clearLastFailedPrompt,
    getLastFailedPrompt,
  });

  return {
    ...presentation,
    enqueuePrompt,
    retryLastPrompt,
    getChannelState,
    setActiveRun,
    cancelChannelWork,
    cancelAllChannelWork,
    getRuntimeSnapshot,
    handlePrompt,
    runProviderTask,
    runCodex: runnerExecutor.runCodex || runProviderTask,
    startSessionProgressBridge,
  };
}
