import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApp, createAppContext } from '../src/app-context.js';

test('createAppContext wires factories and cross-links composition dependencies', () => {
  const calls = {};
  const identity = {
    clearSessionId: () => {},
    formatSessionIdLabel: (value) => `\`${value}\``,
    getSessionId: () => 'sess-1',
    getSessionProvider: () => 'codex',
    setSessionId: () => {},
  };
  const sessionSettings = {
    getSessionLanguage: () => 'zh',
    getEffectiveSecurityProfile: () => 'team',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000 }),
    resolveTaskRetrySetting: () => ({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveCompactThresholdSetting: () => ({ tokens: 200000 }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 200000 }),
  };
  const securityPolicy = {
    resolveSecurityContext: () => ({ maxQueuePerChannel: 20 }),
  };
  const sessionStore = {
    getSession: () => ({ id: 'session' }),
    saveDb: () => {},
    ensureWorkspace: () => '/repo/demo',
    getWorkspaceBinding: () => ({ workspaceDir: '/repo/demo' }),
    listSessions: () => [],
    listFavoriteWorkspaces: () => [],
    addFavoriteWorkspace: () => {},
    removeFavoriteWorkspace: () => {},
  };
  const commandActions = { setProvider: () => {} };
  const workspaceRuntime = {
    acquireWorkspace: async () => ({ release() {} }),
    readLock: () => null,
  };
  const promptRuntime = {
    cancelAllChannelWork: () => 'cancel-all',
    cancelChannelWork: () => 'cancel-one',
    enqueuePrompt: () => 'queued',
    retryLastPrompt: () => 'retried',
    getRuntimeSnapshot: () => ({ running: false }),
    formatCompletedStepsSummary: () => 'steps',
    formatPermissionsLabel: () => 'permissions',
    formatProgressPlanSummary: () => 'plan',
    formatRuntimeLabel: () => 'runtime',
    formatSessionStatusLabel: () => 'session',
    formatTimeoutLabel: () => '60000ms',
    localizeProgressLines: (lines) => lines,
    renderCompletedStepsLines: () => [],
    renderProcessContentLines: () => [],
    renderProgressPlanLines: () => [],
  };
  const commandSurface = {
    formatWorkspaceBusyReport: () => 'busy',
    handleCommand: () => 'handled',
    handleOnboardingButtonInteraction: () => 'onboarded',
    handleWorkspaceBrowserInteraction: () => 'browsed',
    isOnboardingButtonId: () => false,
    isWorkspaceBrowserComponentId: () => false,
    normalizeSlashCommandName: (name) => name,
    routeSlashCommand: () => 'routed',
    slashCommands: ['cmd'],
    slashRef: (base) => `/bot-${base}`,
  };
  const accessPolicy = { allow: true };
  const entryHandlers = { bindClientHandlers: () => 'bound' };
  const lifecycle = {
    getClient: () => ({ user: { id: 'bot-user-1' } }),
  };
  const singleInstanceLock = {
    acquire: () => {},
    setupCleanupHandlers: () => {},
  };

  const appContext = createAppContext({
    identityOptions: { defaultProvider: 'codex' },
    sessionSettingsOptions: { codexTimeoutMs: 60000 },
    securityPolicyOptions: {
      enableConfigCmd: true,
    },
    sessionStoreOptions: {
      dataFile: '/tmp/sessions.json',
      workspaceRoot: '/tmp/workspaces',
    },
    commandActionsOptions: {
      resolveProviderDefaultWorkspace: () => ({ workspaceDir: '/repo/default' }),
      setProviderDefaultWorkspace: () => {},
      getProviderShortName: () => 'Codex',
      listRecentSessions: () => [],
      humanAge: () => '1s',
    },
    workspaceRuntimeOptions: {
      lockRoot: '/tmp/locks',
    },
    promptRuntimeOptions: {
      runtimePresentationOptions: {
        showReasoning: true,
      },
      promptOrchestratorOptions: {
        safeReply: async () => {},
        withDiscordNetworkRetry: async (fn) => fn(),
        splitForDiscord: (text) => [text],
        getProviderDisplayName: () => 'Codex CLI',
        getProviderShortName: () => 'Codex',
        getProviderDefaultBin: () => 'codex',
        getProviderBinEnvName: () => 'CODEX_BIN',
        acquireWorkspace: async () => ({ release() {} }),
        stopChildProcess: () => {},
        isCliNotFound: () => false,
        safeError: (error) => error?.message || String(error),
        truncate: (text) => text,
        toOptionalInt: () => null,
        humanElapsed: () => '1s',
        createProgressEventDeduper: () => () => false,
        buildProgressEventDedupeKey: () => 'key',
        extractInputTokensFromUsage: () => null,
        composeFinalAnswerText: () => 'answer',
      },
      channelQueueOptions: {
        safeReply: async () => {},
        safeError: (error) => error?.message || String(error),
      },
    },
    commandSurfaceOptions: {
      slashPrefix: 'bot',
      botProvider: null,
      defaultUiLanguage: 'zh',
      enableConfigCmd: true,
      SlashCommandBuilder: class {},
      onboardingOptions: {
        onboardingEnabledByDefault: true,
      },
      reportOptions: {},
      workspaceBrowserOptions: {
        resolveProviderDefaultWorkspace: () => ({ workspaceDir: '/repo/default' }),
      },
      slashRouterOptions: {},
      textCommandOptions: {},
    },
    accessPolicyOptions: {
      allowedChannelIds: ['channel-1'],
      allowedUserIds: ['user-1'],
    },
    entryHandlerOptions: {
      logger: console,
    },
    lifecycleOptions: {
      selfHealEnabled: true,
      createClient: () => ({ client: true }),
    },
    singleInstanceLockOptions: {
      lockFile: '/tmp/bot.lock',
    },
    factories: {
      createSessionIdentityHelpersFn: (options) => {
        calls.identity = options;
        return identity;
      },
      createSessionSettingsFn: (options) => {
        calls.sessionSettings = options;
        return sessionSettings;
      },
      createSecurityPolicyFn: (options) => {
        calls.securityPolicy = options;
        return securityPolicy;
      },
      createSessionStoreFn: (options) => {
        calls.sessionStore = options;
        return sessionStore;
      },
      createSessionCommandActionsFn: (options) => {
        calls.commandActions = options;
        return commandActions;
      },
      createWorkspaceRuntimeFn: (options) => {
        calls.workspaceRuntime = options;
        return workspaceRuntime;
      },
      createPromptRuntimeFn: (options) => {
        calls.promptRuntime = options;
        return promptRuntime;
      },
      createCommandSurfaceFn: (options) => {
        calls.commandSurface = options;
        return commandSurface;
      },
      createDiscordAccessPolicyFn: (options) => {
        calls.accessPolicy = options;
        return accessPolicy;
      },
      createDiscordEntryHandlersFn: (options) => {
        calls.entryHandlers = options;
        return entryHandlers;
      },
      createDiscordLifecycleFn: (options) => {
        calls.lifecycle = options;
        return lifecycle;
      },
      createSingleInstanceLockFn: (options) => {
        calls.singleInstanceLock = options;
        return singleInstanceLock;
      },
    },
  });

  assert.equal(calls.identity.defaultProvider, 'codex');
  assert.equal(calls.securityPolicy.getEffectiveSecurityProfile, sessionSettings.getEffectiveSecurityProfile);
  assert.equal(calls.sessionStore.getSessionId, identity.getSessionId);
  assert.equal(calls.commandActions.saveDb, sessionStore.saveDb);
  assert.equal(calls.commandActions.resolveTimeoutSetting, sessionSettings.resolveTimeoutSetting);
  assert.equal(calls.promptRuntime.runtimePresentationOptions.getSessionId, identity.getSessionId);
  assert.equal(calls.promptRuntime.runnerExecutorOptions.getSessionProvider, identity.getSessionProvider);
  assert.equal(calls.promptRuntime.promptOrchestratorOptions.getSession, sessionStore.getSession);
  assert.equal(calls.promptRuntime.promptOrchestratorOptions.resolveTimeoutSetting, sessionSettings.resolveTimeoutSetting);
  assert.equal(calls.promptRuntime.promptOrchestratorOptions.resolveTaskRetrySetting, sessionSettings.resolveTaskRetrySetting);
  assert.equal(calls.promptRuntime.channelQueueOptions.resolveSecurityContext, securityPolicy.resolveSecurityContext);
  assert.equal(calls.promptRuntime.channelQueueOptions.getCurrentUserId, undefined);
  assert.match(
    calls.promptRuntime.promptOrchestratorOptions.formatWorkspaceBusyReport(
      { language: 'zh' },
      '/repo/demo',
      { provider: 'codex', key: 'thread-1' },
    ),
    /workspace 正忙/,
  );
  assert.equal(calls.promptRuntime.promptOrchestratorOptions.slashRef('status'), '/bot_status');
  assert.equal(calls.commandSurface.reportOptions.getRuntimeSnapshot, promptRuntime.getRuntimeSnapshot);
  assert.equal(calls.commandSurface.workspaceBrowserOptions.commandActions, commandActions);
  assert.equal(calls.commandSurface.slashRouterOptions.cancelChannelWork, promptRuntime.cancelChannelWork);
  assert.equal(calls.commandSurface.slashRouterOptions.retryLastPrompt, promptRuntime.retryLastPrompt);
  assert.equal(calls.commandSurface.textCommandOptions.cancelChannelWork, promptRuntime.cancelChannelWork);
  assert.equal(calls.entryHandlers.enqueuePrompt, promptRuntime.enqueuePrompt);
  assert.equal(calls.entryHandlers.routeSlashCommand, commandSurface.routeSlashCommand);
  assert.equal(calls.lifecycle.bindClientHandlers, entryHandlers.bindClientHandlers);
  assert.equal(calls.lifecycle.cancelAllChannelWork, promptRuntime.cancelAllChannelWork);
  assert.equal(appContext.core.identity, identity);
  assert.equal(appContext.core.sessionStore, sessionStore);
  assert.equal(appContext.promptRuntime, promptRuntime);
  assert.equal(appContext.commandSurface, commandSurface);
  assert.equal(appContext.accessPolicy, accessPolicy);
  assert.equal(appContext.lifecycle, lifecycle);
  assert.equal(appContext.singleInstanceLock, singleInstanceLock);
});

test('bootApp acquires lock sets cleanup and boots lifecycle', async () => {
  const events = [];

  await bootApp({
    singleInstanceLock: {
      acquire: () => events.push('lock.acquire'),
      setupCleanupHandlers: () => events.push('lock.cleanup'),
    },
    lifecycle: {
      setupProcessSelfHeal: () => events.push('lifecycle.heal'),
      bootClient: async (reason) => events.push(`lifecycle.boot:${reason}`),
    },
    reason: 'restart',
  });

  assert.deepEqual(events, [
    'lock.acquire',
    'lock.cleanup',
    'lifecycle.heal',
    'lifecycle.boot:restart',
  ]);
});
