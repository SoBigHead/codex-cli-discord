import { createPromptRuntime } from './prompt-runtime.js';
import { createSessionCommandActions } from './session-command-actions.js';
import { createSessionStore } from './session-store.js';
import { createSecurityPolicy } from './security-policy.js';
import { createSessionSettings } from './session-settings.js';
import { createSessionIdentityHelpers } from './session-identity.js';
import { createCommandSurface } from './command-surface.js';
import { createWorkspaceRuntime } from './workspace-runtime.js';
import { slashRef as slashRefBase } from './slash-command-surface.js';
import { createDiscordAccessPolicy } from './discord-access-policy.js';
import { createDiscordEntryHandlers } from './discord-entry-handlers.js';
import { createDiscordLifecycle } from './discord-lifecycle.js';
import { createSingleInstanceLock } from './single-instance-lock.js';
import { formatWorkspaceBusyReport as formatWorkspaceBusyReportBase } from './workspace-busy-report.js';

export function createAppContext({
  identityOptions = {},
  sessionSettingsOptions = {},
  securityPolicyOptions = {},
  sessionStoreOptions = {},
  commandActionsOptions = {},
  workspaceRuntimeOptions = {},
  promptRuntimeOptions = {},
  commandSurfaceOptions = {},
  accessPolicyOptions = {},
  entryHandlerOptions = {},
  lifecycleOptions = {},
  singleInstanceLockOptions = {},
  factories = {},
} = {}) {
  const {
    createSessionIdentityHelpersFn = createSessionIdentityHelpers,
    createSessionSettingsFn = createSessionSettings,
    createSecurityPolicyFn = createSecurityPolicy,
    createSessionStoreFn = createSessionStore,
    createSessionCommandActionsFn = createSessionCommandActions,
    createWorkspaceRuntimeFn = createWorkspaceRuntime,
    createPromptRuntimeFn = createPromptRuntime,
    createCommandSurfaceFn = createCommandSurface,
    createDiscordAccessPolicyFn = createDiscordAccessPolicy,
    createDiscordEntryHandlersFn = createDiscordEntryHandlers,
    createDiscordLifecycleFn = createDiscordLifecycle,
    createSingleInstanceLockFn = createSingleInstanceLock,
  } = factories;

  const identity = createSessionIdentityHelpersFn(identityOptions);
  const sessionStore = createSessionStoreFn({
    ...sessionStoreOptions,
    getSessionId: identity.getSessionId,
  });
  const sessionSettings = createSessionSettingsFn({
    ...sessionSettingsOptions,
    getParentSession: sessionStore.getParentSession,
  });
  const securityPolicy = createSecurityPolicyFn({
    ...securityPolicyOptions,
    getEffectiveSecurityProfile: sessionSettings.getEffectiveSecurityProfile,
  });
  const commandActions = createSessionCommandActionsFn({
    ...commandActionsOptions,
    saveDb: sessionStore.saveDb,
    ensureWorkspace: sessionStore.ensureWorkspace,
    getWorkspaceBinding: sessionStore.getWorkspaceBinding,
    listStoredSessions: sessionStore.listSessions,
    clearSessionId: identity.clearSessionId,
    getSessionId: identity.getSessionId,
    setSessionId: identity.setSessionId,
    getSessionProvider: identity.getSessionProvider,
    getSessionLanguage: sessionSettings.getSessionLanguage,
    resolveModelSetting: sessionSettings.resolveModelSetting,
    resolveCodexProfileSetting: sessionSettings.resolveCodexProfileSetting,
    resolveReasoningEffortSetting: sessionSettings.resolveReasoningEffortSetting,
    resolveFastModeSetting: sessionSettings.resolveFastModeSetting,
    resolveRuntimeModeSetting: sessionSettings.resolveRuntimeModeSetting,
    resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
    resolveReplyDeliveryDefault: commandActionsOptions.resolveReplyDeliveryDefault,
    setReplyDeliveryDefault: commandActionsOptions.setReplyDeliveryDefault,
  });
  const workspaceRuntime = createWorkspaceRuntimeFn(workspaceRuntimeOptions);
  const promptSlashRef = (base) => slashRefBase(base, commandSurfaceOptions.slashPrefix || '');
  const formatWorkspaceBusyReport = (session, workspaceDir, owner = null) => formatWorkspaceBusyReportBase(
    session,
    workspaceDir,
    owner,
    {
      getSessionLanguage: sessionSettings.getSessionLanguage,
      normalizeUiLanguage: promptOrchestratorOptions.normalizeUiLanguage,
      humanAge: reportOptions.humanAge,
      slashRef: promptSlashRef,
    },
  );
  let buildWorkspaceBusyPayload = ({ key, session, userId, workspaceDir, owner }) => ({
    content: formatWorkspaceBusyReport(session, workspaceDir, owner),
  });

  const {
    runtimePresentationOptions = {},
    channelRuntimeStoreOptions = {},
    sessionProgressBridgeOptions = {},
    runnerExecutorOptions = {},
    promptOrchestratorOptions = {},
    channelQueueOptions = {},
    factories: promptRuntimeFactories = {},
    ...promptRuntimeRest
  } = promptRuntimeOptions;

  const promptRuntime = createPromptRuntimeFn({
    ...promptRuntimeRest,
    runtimePresentationOptions: {
      ...runtimePresentationOptions,
      getSessionId: identity.getSessionId,
      getSessionProvider: identity.getSessionProvider,
      formatSessionIdLabel: identity.formatSessionIdLabel,
    },
    channelRuntimeStoreOptions,
    sessionProgressBridgeOptions,
    runnerExecutorOptions: {
      ...runnerExecutorOptions,
      getSessionProvider: identity.getSessionProvider,
      getSessionId: identity.getSessionId,
      resolveModelSetting: sessionSettings.resolveModelSetting,
      resolveCodexProfileSetting: sessionSettings.resolveCodexProfileSetting,
      resolveReasoningEffortSetting: sessionSettings.resolveReasoningEffortSetting,
      resolveFastModeSetting: sessionSettings.resolveFastModeSetting,
      resolveRuntimeModeSetting: sessionSettings.resolveRuntimeModeSetting,
      resolveReplyDeliverySetting: sessionSettings.resolveReplyDeliverySetting,
      resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
      resolveCompactStrategySetting: sessionSettings.resolveCompactStrategySetting,
      resolveCompactEnabledSetting: sessionSettings.resolveCompactEnabledSetting,
      resolveNativeCompactTokenLimitSetting: sessionSettings.resolveNativeCompactTokenLimitSetting,
    },
    promptOrchestratorOptions: {
      ...promptOrchestratorOptions,
      getSession: sessionStore.getSession,
      ensureWorkspace: sessionStore.ensureWorkspace,
      saveDb: sessionStore.saveDb,
      clearSessionId: identity.clearSessionId,
      getSessionId: identity.getSessionId,
      setSessionId: identity.setSessionId,
      getSessionProvider: identity.getSessionProvider,
      getSessionLanguage: sessionSettings.getSessionLanguage,
      resolveModelSetting: sessionSettings.resolveModelSetting,
      resolveCodexProfileSetting: sessionSettings.resolveCodexProfileSetting,
      resolveReasoningEffortSetting: sessionSettings.resolveReasoningEffortSetting,
      resolveFastModeSetting: sessionSettings.resolveFastModeSetting,
      resolveRuntimeModeSetting: sessionSettings.resolveRuntimeModeSetting,
      resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
      resolveTaskRetrySetting: sessionSettings.resolveTaskRetrySetting,
      resolveCompactStrategySetting: sessionSettings.resolveCompactStrategySetting,
      resolveCompactEnabledSetting: sessionSettings.resolveCompactEnabledSetting,
      resolveCompactThresholdSetting: sessionSettings.resolveCompactThresholdSetting,
      resolveExtraInfoSetting: sessionSettings.resolveExtraInfoSetting,
      acquireWorkspace: workspaceRuntime.acquireWorkspace,
      formatWorkspaceBusyReport,
      buildWorkspaceBusyPayload: (input) => buildWorkspaceBusyPayload(input),
      slashRef: promptSlashRef,
    },
    channelQueueOptions: {
      ...channelQueueOptions,
      getSession: sessionStore.getSession,
      resolveSecurityContext: securityPolicy.resolveSecurityContext,
      slashRef: promptSlashRef,
    },
    factories: promptRuntimeFactories,
  });

  const {
    onboardingOptions = {},
    settingsPanelOptions = {},
    reportOptions = {},
    workspaceBrowserOptions = {},
    slashRouterOptions = {},
    textCommandOptions = {},
    ...commandSurfaceRest
  } = commandSurfaceOptions;

  const commandSurface = createCommandSurfaceFn({
    ...commandSurfaceRest,
    onboardingOptions: {
      ...onboardingOptions,
      commandActions,
      getSession: sessionStore.getSession,
      saveDb: sessionStore.saveDb,
      getSessionProvider: identity.getSessionProvider,
      getWorkspaceBinding: sessionStore.getWorkspaceBinding,
      resolveSecurityContext: securityPolicy.resolveSecurityContext,
      getSessionLanguage: sessionSettings.getSessionLanguage,
    },
    settingsPanelOptions: {
      ...settingsPanelOptions,
      commandActions,
      getSession: sessionStore.getSession,
      getSessionLanguage: sessionSettings.getSessionLanguage,
      getSessionProvider: identity.getSessionProvider,
      getWorkspaceBinding: sessionStore.getWorkspaceBinding,
      getProviderDefaults: sessionSettings.getProviderDefaults,
      resolveCodexProfileSetting: sessionSettings.resolveCodexProfileSetting,
      resolveModelSetting: sessionSettings.resolveModelSetting,
      resolveReasoningEffortSetting: sessionSettings.resolveReasoningEffortSetting,
      resolveFastModeSetting: sessionSettings.resolveFastModeSetting,
      resolveRuntimeModeSetting: sessionSettings.resolveRuntimeModeSetting,
      resolveCompactStrategySetting: sessionSettings.resolveCompactStrategySetting,
      resolveCompactThresholdSetting: sessionSettings.resolveCompactThresholdSetting,
      resolveReplyDeliverySetting: sessionSettings.resolveReplyDeliverySetting,
      resolveExtraInfoSetting: sessionSettings.resolveExtraInfoSetting,
      getDefaultCodexProfile: commandActionsOptions.resolveDefaultCodexProfile,
      getReplyDeliveryDefault: commandActionsOptions.resolveReplyDeliveryDefault,
      closeRuntimeSession: promptRuntime.closeRuntimeSession,
    },
    reportOptions: {
      ...reportOptions,
      getSessionLanguage: sessionSettings.getSessionLanguage,
      getSessionProvider: identity.getSessionProvider,
      getSessionId: identity.getSessionId,
      getRuntimeSnapshot: promptRuntime.getRuntimeSnapshot,
      resolveSecurityContext: securityPolicy.resolveSecurityContext,
      resolveModelSetting: sessionSettings.resolveModelSetting,
      resolveCodexProfileSetting: sessionSettings.resolveCodexProfileSetting,
      resolveReasoningEffortSetting: sessionSettings.resolveReasoningEffortSetting,
      resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
      resolveFastModeSetting: sessionSettings.resolveFastModeSetting,
      resolveRuntimeModeSetting: sessionSettings.resolveRuntimeModeSetting,
      resolveReplyDeliverySetting: sessionSettings.resolveReplyDeliverySetting,
      resolveExtraInfoSetting: sessionSettings.resolveExtraInfoSetting,
      getEffectiveSecurityProfile: sessionSettings.getEffectiveSecurityProfile,
      resolveCompactStrategySetting: sessionSettings.resolveCompactStrategySetting,
      resolveCompactEnabledSetting: sessionSettings.resolveCompactEnabledSetting,
      resolveCompactThresholdSetting: sessionSettings.resolveCompactThresholdSetting,
      resolveNativeCompactTokenLimitSetting: sessionSettings.resolveNativeCompactTokenLimitSetting,
      getWorkspaceBinding: sessionStore.getWorkspaceBinding,
      readWorkspaceLock: workspaceRuntime.readLock,
      formatPermissionsLabel: promptRuntime.formatPermissionsLabel,
      formatSecurityProfileDisplay: securityPolicy.formatSecurityProfileDisplay,
      formatQueueLimit: securityPolicy.formatQueueLimit,
      formatRuntimeLabel: promptRuntime.formatRuntimeLabel,
      formatSessionStatusLabel: promptRuntime.formatSessionStatusLabel,
      formatTimeoutLabel: promptRuntime.formatTimeoutLabel,
      formatConfigCommandStatus: securityPolicy.formatConfigCommandStatus,
      describeConfigPolicy: securityPolicy.describeConfigPolicy,
      formatProgressPlanSummary: promptRuntime.formatProgressPlanSummary,
      formatCompletedStepsSummary: promptRuntime.formatCompletedStepsSummary,
      renderProcessContentLines: promptRuntime.renderProcessContentLines,
      localizeProgressLines: promptRuntime.localizeProgressLines,
      renderProgressPlanLines: promptRuntime.renderProgressPlanLines,
      renderCompletedStepsLines: promptRuntime.renderCompletedStepsLines,
    },
    workspaceBrowserOptions: {
      ...workspaceBrowserOptions,
      commandActions,
      getSession: sessionStore.getSession,
      getSessionLanguage: sessionSettings.getSessionLanguage,
      getSessionProvider: identity.getSessionProvider,
      getWorkspaceBinding: sessionStore.getWorkspaceBinding,
      resolveChildThreadWorkspaceMode: workspaceBrowserOptions.resolveChildThreadWorkspaceMode,
      setChildThreadWorkspaceMode: workspaceBrowserOptions.setChildThreadWorkspaceMode,
      listStoredSessions: sessionStore.listSessions,
      listFavoriteWorkspaces: sessionStore.listFavoriteWorkspaces,
      addFavoriteWorkspace: sessionStore.addFavoriteWorkspace,
      removeFavoriteWorkspace: sessionStore.removeFavoriteWorkspace,
    },
    slashRouterOptions: {
      ...slashRouterOptions,
      getSession: sessionStore.getSession,
      getSessionLanguage: sessionSettings.getSessionLanguage,
      getSessionProvider: identity.getSessionProvider,
      getSessionId: identity.getSessionId,
      getEffectiveSecurityProfile: sessionSettings.getEffectiveSecurityProfile,
      resolveModelSetting: sessionSettings.resolveModelSetting,
      resolveReasoningEffortSetting: sessionSettings.resolveReasoningEffortSetting,
      getRuntimeSnapshot: promptRuntime.getRuntimeSnapshot,
      resolveFastModeSetting: sessionSettings.resolveFastModeSetting,
      resolveRuntimeModeSetting: sessionSettings.resolveRuntimeModeSetting,
      resolveSecurityContext: securityPolicy.resolveSecurityContext,
      resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
      resolveExtraInfoSetting: sessionSettings.resolveExtraInfoSetting,
      commandActions,
      enqueuePrompt: promptRuntime.enqueuePrompt,
      cancelChannelWork: promptRuntime.cancelChannelWork,
      closeRuntimeSession: promptRuntime.closeRuntimeSession,
      retryLastPrompt: promptRuntime.retryLastPrompt,
    },
    textCommandOptions: {
      ...textCommandOptions,
      getSession: sessionStore.getSession,
      saveDb: sessionStore.saveDb,
      ensureWorkspace: sessionStore.ensureWorkspace,
      clearSessionId: identity.clearSessionId,
      getSessionId: identity.getSessionId,
      setSessionId: identity.setSessionId,
      getSessionProvider: identity.getSessionProvider,
      getSessionLanguage: sessionSettings.getSessionLanguage,
      commandActions,
      resolveModelSetting: sessionSettings.resolveModelSetting,
      resolveReasoningEffortSetting: sessionSettings.resolveReasoningEffortSetting,
      getEffectiveSecurityProfile: sessionSettings.getEffectiveSecurityProfile,
      resolveFastModeSetting: sessionSettings.resolveFastModeSetting,
      resolveRuntimeModeSetting: sessionSettings.resolveRuntimeModeSetting,
      resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
      resolveExtraInfoSetting: sessionSettings.resolveExtraInfoSetting,
      describeConfigPolicy: securityPolicy.describeConfigPolicy,
      isConfigKeyAllowed: securityPolicy.isConfigKeyAllowed,
      enqueuePrompt: promptRuntime.enqueuePrompt,
      resolveSecurityContext: securityPolicy.resolveSecurityContext,
      getRuntimeSnapshot: promptRuntime.getRuntimeSnapshot,
      cancelChannelWork: promptRuntime.cancelChannelWork,
      closeRuntimeSession: promptRuntime.closeRuntimeSession,
    },
  });
  if (typeof commandSurface.buildWorkspaceBusyPayload === 'function') {
    buildWorkspaceBusyPayload = commandSurface.buildWorkspaceBusyPayload;
  }

  const accessPolicy = createDiscordAccessPolicyFn(accessPolicyOptions);
  const entryHandlers = createDiscordEntryHandlersFn({
    ...entryHandlerOptions,
    accessPolicy,
    slashCommands: commandSurface.slashCommands,
    getSession: sessionStore.getSession,
    resolveSecurityContext: securityPolicy.resolveSecurityContext,
    handleCommand: commandSurface.handleCommand,
    enqueuePrompt: promptRuntime.enqueuePrompt,
    isWorkspaceBusyComponentId: commandSurface.isWorkspaceBusyComponentId,
    isWorkspaceBrowserComponentId: commandSurface.isWorkspaceBrowserComponentId,
    isOnboardingButtonId: commandSurface.isOnboardingButtonId,
    isSettingsPanelComponentId: commandSurface.isSettingsPanelComponentId,
    isSettingsPanelModalId: commandSurface.isSettingsPanelModalId,
    handleWorkspaceBusyInteraction: commandSurface.handleWorkspaceBusyInteraction,
    handleWorkspaceBrowserInteraction: commandSurface.handleWorkspaceBrowserInteraction,
    handleOnboardingButtonInteraction: commandSurface.handleOnboardingButtonInteraction,
    handleSettingsPanelInteraction: commandSurface.handleSettingsPanelInteraction,
    handleSettingsPanelModalSubmit: commandSurface.handleSettingsPanelModalSubmit,
    routeSlashCommand: commandSurface.routeSlashCommand,
    normalizeSlashCommandName: commandSurface.normalizeSlashCommandName,
  });
  const lifecycle = createDiscordLifecycleFn({
    ...lifecycleOptions,
    bindClientHandlers: entryHandlers.bindClientHandlers,
    cancelAllChannelWork: promptRuntime.cancelAllChannelWork,
  });
  const singleInstanceLock = createSingleInstanceLockFn(singleInstanceLockOptions);

  return {
    core: {
      identity,
      sessionSettings,
      securityPolicy,
      sessionStore,
      commandActions,
      workspaceRuntime,
    },
    promptRuntime,
    commandSurface,
    accessPolicy,
    entryHandlers,
    lifecycle,
    singleInstanceLock,
  };
}

export async function bootApp({
  lifecycle,
  singleInstanceLock,
  reason = 'startup',
} = {}) {
  singleInstanceLock?.acquire?.();
  singleInstanceLock?.setupCleanupHandlers?.();
  lifecycle?.setupProcessSelfHeal?.();
  if (typeof lifecycle?.bootClient === 'function') {
    return lifecycle.bootClient(reason);
  }
  return undefined;
}
