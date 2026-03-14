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
  const sessionSettings = createSessionSettingsFn(sessionSettingsOptions);
  const securityPolicy = createSecurityPolicyFn({
    ...securityPolicyOptions,
    getEffectiveSecurityProfile: sessionSettings.getEffectiveSecurityProfile,
  });
  const sessionStore = createSessionStoreFn({
    ...sessionStoreOptions,
    getSessionId: identity.getSessionId,
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
    resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
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
    },
  );

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
      resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
      resolveTaskRetrySetting: sessionSettings.resolveTaskRetrySetting,
      resolveCompactStrategySetting: sessionSettings.resolveCompactStrategySetting,
      resolveCompactEnabledSetting: sessionSettings.resolveCompactEnabledSetting,
      resolveCompactThresholdSetting: sessionSettings.resolveCompactThresholdSetting,
      acquireWorkspace: workspaceRuntime.acquireWorkspace,
      formatWorkspaceBusyReport,
      slashRef: promptSlashRef,
    },
    channelQueueOptions: {
      ...channelQueueOptions,
      getSession: sessionStore.getSession,
      resolveSecurityContext: securityPolicy.resolveSecurityContext,
    },
    factories: promptRuntimeFactories,
  });

  const {
    onboardingOptions = {},
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
      getSession: sessionStore.getSession,
      saveDb: sessionStore.saveDb,
      getSessionProvider: identity.getSessionProvider,
      getRuntimeSnapshot: promptRuntime.getRuntimeSnapshot,
      resolveSecurityContext: securityPolicy.resolveSecurityContext,
      getEffectiveSecurityProfile: sessionSettings.getEffectiveSecurityProfile,
      resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
      getSessionLanguage: sessionSettings.getSessionLanguage,
      formatQueueLimit: securityPolicy.formatQueueLimit,
      formatSecurityProfileDisplay: securityPolicy.formatSecurityProfileDisplay,
      formatConfigCommandStatus: securityPolicy.formatConfigCommandStatus,
    },
    reportOptions: {
      ...reportOptions,
      getSessionLanguage: sessionSettings.getSessionLanguage,
      getSessionProvider: identity.getSessionProvider,
      getRuntimeSnapshot: promptRuntime.getRuntimeSnapshot,
      resolveSecurityContext: securityPolicy.resolveSecurityContext,
      resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
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
      getEffectiveSecurityProfile: sessionSettings.getEffectiveSecurityProfile,
      getRuntimeSnapshot: promptRuntime.getRuntimeSnapshot,
      resolveSecurityContext: securityPolicy.resolveSecurityContext,
      resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
      commandActions,
      cancelChannelWork: promptRuntime.cancelChannelWork,
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
      getEffectiveSecurityProfile: sessionSettings.getEffectiveSecurityProfile,
      resolveTimeoutSetting: sessionSettings.resolveTimeoutSetting,
      describeConfigPolicy: securityPolicy.describeConfigPolicy,
      isConfigKeyAllowed: securityPolicy.isConfigKeyAllowed,
      cancelChannelWork: promptRuntime.cancelChannelWork,
    },
  });

  const accessPolicy = createDiscordAccessPolicyFn(accessPolicyOptions);
  const entryHandlers = createDiscordEntryHandlersFn({
    ...entryHandlerOptions,
    accessPolicy,
    slashCommands: commandSurface.slashCommands,
    getSession: sessionStore.getSession,
    resolveSecurityContext: securityPolicy.resolveSecurityContext,
    handleCommand: commandSurface.handleCommand,
    enqueuePrompt: promptRuntime.enqueuePrompt,
    isWorkspaceBrowserComponentId: commandSurface.isWorkspaceBrowserComponentId,
    isOnboardingButtonId: commandSurface.isOnboardingButtonId,
    handleWorkspaceBrowserInteraction: commandSurface.handleWorkspaceBrowserInteraction,
    handleOnboardingButtonInteraction: commandSurface.handleOnboardingButtonInteraction,
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
