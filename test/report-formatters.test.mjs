import test from 'node:test';
import assert from 'node:assert/strict';

import { createReportFormatters } from '../src/report-formatters.js';

function createFormatters(overrides = {}) {
  const base = {
    botProvider: null,
    allowedChannelIds: new Set(['channel-1', 'channel-2']),
    allowedUserIds: new Set(['user-1']),
    progressProcessLines: 3,
    progressPlanMaxLines: 3,
    progressDoneStepsMax: 3,
    slashRef: (name) => `/bot-${name}`,
    getSessionLanguage: (session) => session?.language || 'zh',
    normalizeUiLanguage: (value) => (String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh'),
    getSessionProvider: (session) => session?.provider || 'codex',
    getProviderDisplayName: (provider) => {
      if (provider === 'gemini') return 'Gemini CLI';
      if (provider === 'claude') return 'Claude Code';
      return 'Codex CLI';
    },
    getProviderShortName: (provider) => {
      if (provider === 'gemini') return 'Gemini';
      if (provider === 'claude') return 'Claude';
      return 'Codex';
    },
    getProviderCompactCapabilities: (provider) => ({
      strategies: ['hard', 'native', 'off'],
      supportsNativeStrategy: true,
      supportsNativeLimit: provider === 'codex',
    }),
    providerSupportsRawConfigOverrides: (provider) => provider === 'codex',
    formatProviderSessionTerm: (provider) => {
      if (provider === 'claude') return 'project session';
      if (provider === 'gemini') return 'chat session';
      return 'rollout session';
    },
    formatProviderRuntimeSummary: (provider) => `runtime:${provider}`,
    formatProviderSessionStoreSurface: (provider) => `store:${provider}`,
    formatProviderResumeSurface: (provider) => `resume:${provider}`,
    formatProviderNativeCompactSurface: (provider) => `compact:${provider}`,
    formatProviderRawConfigSurface: (provider) => `config:${provider}`,
    formatProviderReasoningSurface: (provider) => `reasoning:${provider}`,
    getSupportedReasoningEffortLevels: (provider) => {
      if (provider === 'gemini') return [];
      if (provider === 'claude') return ['low', 'medium', 'high'];
      return ['low', 'medium', 'high', 'xhigh'];
    },
    getProviderDefaults: () => ({ model: 'gpt-5-codex', effort: 'high', source: 'config.toml' }),
    resolveModelSetting: (session) => ({
      value: session?.model || session?.inheritedModel || 'gpt-5-codex',
      source: session?.modelSource || (session?.model ? 'session override' : 'config.toml'),
    }),
    resolveCodexProfileSetting: (session) => ({
      value: session?.codexProfile || session?.inheritedCodexProfile || null,
      source: session?.codexProfileSource
        || (session?.codexProfile ? 'session override' : (session?.inheritedCodexProfile ? 'parent channel' : 'provider default')),
      supported: session?.provider !== 'claude' && session?.provider !== 'gemini',
      valid: session?.codexProfileValid !== false,
      isExplicit: Boolean(session?.codexProfile || session?.inheritedCodexProfile),
      error: session?.codexProfileError || null,
    }),
    resolveReasoningEffortSetting: (session) => ({
      value: session?.effort || session?.inheritedEffort || 'high',
      source: session?.effortSource || (session?.effort ? 'session override' : 'config.toml'),
    }),
    getCliHealth: (provider) => ({ ok: true, version: '1.2.3', bin: `/usr/local/bin/${provider}` }),
    getRuntimeSnapshot: () => ({
      running: false,
      queued: 2,
      progressPlan: null,
      completedSteps: [],
      recentActivities: [],
      progressText: 'building',
      progressAgoMs: 1_234,
      messageId: 'msg-1',
      progressMessageId: 'progress-1',
      progressEvents: 4,
      activeSinceMs: 3_000,
      pid: 1234,
      phase: 'exec',
    }),
    resolveSecurityContext: () => ({ mentionOnly: false, maxQueuePerChannel: 20, profile: 'team' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 60_000, source: 'session override' }),
    resolveFastModeSetting: (session) => ({
      enabled: session?.fastMode ?? true,
      supported: session?.provider !== 'claude' && session?.provider !== 'gemini',
      source: session?.fastMode === null || session?.fastMode === undefined ? 'config.toml' : 'session override',
    }),
    getEffectiveSecurityProfile: () => ({ profile: 'public', source: 'session override' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native', source: 'session override' }),
    resolveCompactEnabledSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactThresholdSetting: () => ({ tokens: 272_000, source: 'session override' }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 320_000, source: 'session threshold fallback' }),
    resolveReplyDeliverySetting: (session) => ({
      mode: session?.replyDeliveryMode || session?.inheritedReplyDeliveryMode || 'card_only',
      source: session?.replyDeliverySource
        || (session?.replyDeliveryMode ? 'session override' : 'env default'),
    }),
    getWorkspaceBinding: (session, key) => ({
      workspaceDir: session?.workspaceDir || `/repo/${key}`,
      source: session?.workspaceDir ? 'thread override' : 'provider default',
      defaultWorkspaceDir: '/repo/default',
      defaultSource: 'provider-scoped env',
      defaultEnvKey: 'CODEX__DEFAULT_WORKSPACE_DIR',
    }),
    readWorkspaceLock: () => ({ owner: { key: 'thread-9' } }),
    formatCliHealth: (health) => `ok ${health.version}`,
    formatPermissionsLabel: (_session, language) => (language === 'en' ? 'sandboxed' : '沙盒模式'),
    formatLanguageLabel: (language) => (language === 'en' ? 'en (English)' : 'zh (中文)'),
    formatSecurityProfileDisplay: (security) => `${security.profile || 'team'} profile`,
    formatSecurityProfileLabel: (profile) => String(profile || 'team'),
    formatQueueLimit: (limit) => String(limit),
    formatRuntimeLabel: (runtime, language = 'en') => {
      if (!runtime.running) return language === 'en' ? 'idle' : '空闲';
      return language === 'en' ? 'running' : '运行中';
    },
    formatTimeoutLabel: (timeoutMs) => `${timeoutMs}ms`,
    describeCompactStrategy: (strategy, language = 'en') => (
      language === 'en' ? `strategy:${strategy}` : `策略:${strategy}`
    ),
    formatWorkspaceSessionPolicy: (provider, language = 'en') => (
      language === 'en'
        ? `${provider} sessions are treated as workspace-scoped`
        : `${provider} session 按 workspace 绑定处理`
    ),
    formatWorkspaceSessionResetReason: (provider, language = 'en') => (
      language === 'en'
        ? `reset because ${provider} sessions are treated as workspace-scoped`
        : `已重置（${provider} session 按 workspace 绑定处理）`
    ),
    humanAge: (ms) => `${Math.round(ms / 1000)}s`,
    formatTokenValue: (value) => (value === null || value === undefined ? '-' : String(value)),
    formatConfigCommandStatus: () => 'enabled',
    describeConfigPolicy: () => 'personality,model_reasoning_effort',
    formatSessionStatusLabel: (session) => (session?.name ? `**${session.name}** (\`sess-1\`)` : '`sess-1`'),
    formatProgressPlanSummary: () => '1/3 completed',
    formatCompletedStepsSummary: () => 'bootstrap',
    renderProcessContentLines: () => ['• process content:', '  · compiling'],
    localizeProgressLines: (lines, language = 'en') => (
      language === 'en' ? lines : lines.map((line) => line.replace(/^• plan:/, '• 计划：'))
    ),
    renderProgressPlanLines: () => ['• plan: 1/3 completed'],
    renderCompletedStepsLines: () => ['• completed steps: bootstrap'],
  };

  return createReportFormatters({ ...base, ...overrides });
}

test('createReportFormatters.formatStatusReport uses provider defaults for model and effort', () => {
  const formatters = createFormatters();
  const session = {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
    lastInputTokens: 321,
    name: 'alpha',
  };

  const report = formatters.formatStatusReport('thread-1', session, { id: 'channel-1' });

  assert.match(report, /model: gpt-5-codex _\(config\.toml\)_/);
  assert.match(report, /effort: high _\(config\.toml\)_/);
  assert.match(report, /workspace: `\/repo\/thread-1` \(provider default\)/);
  assert.match(report, /runtime profile: runtime:codex/);
  assert.match(report, /rollout session: \*\*alpha\*\* \(`sess-1`\)/);
  assert.match(report, /last run input tokens: 321/);
  assert.doesNotMatch(report, /\(unknown\)/);
});

test('createReportFormatters.formatStatusReport shows extra info token cost', () => {
  const formatters = createFormatters({
    resolveExtraInfoSetting: () => ({
      enabled: true,
      enabledSource: 'session override',
      text: '[D {thread} {msg}]',
      textSource: 'session override',
    }),
    estimateExtraInfoTokens: (text) => text.length,
  });
  const report = formatters.formatStatusReport('thread-1', { provider: 'codex', language: 'zh' }, { id: 'thread-1' });

  assert.match(report, /额外信息：on/);
  assert.match(report, /约 31 tokens/);
  assert.doesNotMatch(report, /\[D thread-1 000000000000000000\]/);
});

test('createReportFormatters.formatStatusReport labels lastInputTokens as previous run usage', () => {
  const formatters = createFormatters();
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    lastInputTokens: 654321,
    name: 'alpha',
  };

  const report = formatters.formatStatusReport('thread-1', session, { id: 'channel-1' });

  assert.match(report, /上一轮输入 tokens: 654321/);
  assert.doesNotMatch(report, /最近输入 tokens/);
});

test('createReportFormatters.formatStatusReport shows parent-channel inherited model effort and workspace', () => {
  const formatters = createFormatters({
    getWorkspaceBinding: () => ({
      workspaceDir: '/repo/parent',
      source: 'parent channel',
      defaultWorkspaceDir: '/repo/default',
      defaultSource: 'provider-scoped env',
      defaultEnvKey: 'CODEX__DEFAULT_WORKSPACE_DIR',
    }),
  });
  const session = {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
    inheritedModel: 'gpt-5.4',
    modelSource: 'parent channel',
    inheritedEffort: 'medium',
    effortSource: 'parent channel',
    parentChannelId: 'channel-1',
  };

  const report = formatters.formatStatusReport('thread-1', session, { id: 'thread-1' });

  assert.match(report, /model: `gpt-5\.4` \(parent channel\)/);
  assert.match(report, /effort: `medium` \(parent channel\)/);
  assert.match(report, /workspace: `\/repo\/parent` \(parent channel\)/);
});

test('createReportFormatters.formatStatusReport shows codex profile and invalid state', () => {
  const formatters = createFormatters();
  const session = {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
    inheritedCodexProfile: 'work',
    codexProfileSource: 'parent channel',
    codexProfileValid: false,
    codexProfileError: 'missing in /tmp/codex-config.toml',
    parentChannelId: 'channel-1',
  };

  const report = formatters.formatStatusReport('thread-1', session, { id: 'thread-1' });

  assert.match(report, /codex profile: `work` \(parent channel\) \[invalid: missing in \/tmp\/codex-config\.toml\]/);
});

test('createReportFormatters.formatStatusReport shows reply delivery with inheritance source', () => {
  const formatters = createFormatters();
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    inheritedReplyDeliveryMode: 'stream_mention',
    replyDeliverySource: 'parent channel',
    parentChannelId: 'channel-1',
  };

  const report = formatters.formatStatusReport('thread-1', session, { id: 'thread-1' });

  assert.match(report, /回复方式：发送过程消息，完成时触发 @（父频道默认）/);
});

test('createReportFormatters.formatStatusReportWithLiveData shows Codex 5h and weekly quota', async () => {
  const formatters = createFormatters({
    getProviderRateLimits: async () => ({
      ok: true,
      account: {
        name: 'Demo User',
        email: 'demo@example.com',
        authMode: 'chatgpt',
        planType: 'pro',
        organizationTitle: 'Personal',
      },
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1776169989 },
        secondary: { usedPercent: 12.5, windowDurationMins: 10080, resetsAt: 1776756789 },
        credits: null,
        planType: 'pro',
      },
      rateLimitsByLimitId: null,
    }),
  });

  const report = await formatters.formatStatusReportWithLiveData('thread-1', {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
  }, { id: 'channel-1' });

  assert.match(report, /Codex 账号: Demo User <demo@example\.com> · chatgpt · pro · Personal/);
  assert.match(report, /Codex 5h 余量: 98%（已用 2%，重置 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）/);
  assert.match(report, /Codex weekly 余量: 87\.5%（已用 12\.5%，重置 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）/);
});

test('createReportFormatters.formatStatusReportWithLiveData shows Codex quota query failures', async () => {
  const formatters = createFormatters({
    getProviderRateLimits: async () => ({
      ok: false,
      error: 'login required',
      account: {
        email: 'demo@example.com',
        authMode: 'chatgpt',
        planType: 'pro',
        organizationTitle: 'Personal',
      },
    }),
  });

  const report = await formatters.formatStatusReportWithLiveData('thread-1', {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
  }, { id: 'channel-1' });

  assert.match(report, /Codex account: demo@example\.com · chatgpt · pro · Personal/);
  assert.match(report, /Codex quota: unavailable \(login required\)/);
});

test('createReportFormatters.formatStatusReportWithLiveData labels stale Codex quota snapshots', async () => {
  const formatters = createFormatters({
    getProviderRateLimits: async () => ({
      ok: true,
      stale: true,
      staleReason: 'network timeout',
      cacheAgeMs: 120000,
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: 1776169989 },
        secondary: { usedPercent: 55, windowDurationMins: 10080, resetsAt: 1776756789 },
      },
      rateLimitsByLimitId: null,
    }),
    humanAge: (ms) => `${Math.round(ms / 1000)}s`,
  });

  const report = await formatters.formatStatusReportWithLiveData('thread-1', {
    provider: 'codex',
    mode: 'dangerous',
    language: 'en',
  }, { id: 'channel-1' });

  assert.match(report, /Codex quota: live query unavailable \(network timeout\); showing cached snapshot from 120s ago/);
  assert.match(report, /Codex 5h quota: 91% remaining \(used 9%, resets \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/);
  assert.match(report, /Codex weekly quota: 45% remaining \(used 55%, resets \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/);
});

test('createReportFormatters.formatStatusReportWithLiveData shows Codex goal state', async () => {
  const formatters = createFormatters({
    getSessionId: () => 'thread-1',
    getProviderRateLimits: async () => null,
    getCodexThreadGoal: async ({ threadId }) => ({
      goal: {
        threadId,
        objective: 'ship Discord goal command',
        status: 'active',
        tokenBudget: 90000,
        tokensUsed: 1200,
      },
    }),
  });

  const report = await formatters.formatStatusReportWithLiveData('thread-1', {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
  }, { id: 'channel-1' });

  assert.match(report, /Codex goal: 进行中；目标：ship Discord goal command；预算：1200\/90000/);
  assert.match(report, /active goal 应继续推进，直到 runner 标记完成或报告阻塞/);
});

test('createReportFormatters.formatStatusReportWithLiveData surfaces Codex goal query failures', async () => {
  const formatters = createFormatters({
    getSessionId: () => 'thread-1',
    getProviderRateLimits: async () => null,
    getCodexThreadGoal: async () => {
      throw new Error('thread not found');
    },
  });

  const report = await formatters.formatStatusReportWithLiveData('thread-1', {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
  }, { id: 'channel-1' });

  assert.match(report, /Codex goal: unavailable \(thread not found\)/);
});

test('createReportFormatters.formatProgressReport returns localized idle hint', () => {
  const formatters = createFormatters({
    resolveSecurityContext: () => ({ mentionOnly: true, maxQueuePerChannel: 5, profile: 'public' }),
  });

  const report = formatters.formatProgressReport('thread-1', { language: 'zh' }, { id: 'channel-1' });

  assert.match(report, /当前没有运行中的任务/);
  assert.match(report, /队列上限: 5/);
  assert.match(report, /`\/bot-status`/);
  assert.doesNotMatch(report, /`\/bot-progress`/);
});

test('createReportFormatters.formatProgressReport keeps running hints minimal', () => {
  const formatters = createFormatters({
    getRuntimeSnapshot: () => ({
      running: true,
      queued: 1,
      progressPlan: null,
      completedSteps: [],
      recentActivities: [],
      progressText: 'building',
      progressAgoMs: 1_234,
      messageId: 'msg-1',
      progressMessageId: 'progress-1',
      progressEvents: 4,
      activeSinceMs: 3_000,
      pid: 1234,
      phase: 'exec',
    }),
  });

  const report = formatters.formatProgressReport('thread-1', { language: 'zh' }, { id: 'channel-1' });

  assert.match(report, /`!c`/);
  assert.match(report, /effort: high/);
  assert.match(report, /fast mode: 开启（config\.toml）/);
  assert.doesNotMatch(report, /`\/bot-status`/);
  assert.doesNotMatch(report, /!cancel/);
  assert.doesNotMatch(report, /\/bot-cancel/);
});

test('createReportFormatters shows concrete provider model values without provider default wording', () => {
  const formatters = createFormatters({
    getProviderDefaults: () => ({ model: 'gpt-5.4', effort: null, source: 'provider' }),
    resolveModelSetting: () => ({ value: 'gpt-5.4', source: 'provider' }),
    getSupportedReasoningEffortLevels: () => [],
    getRuntimeSnapshot: () => ({
      running: true,
      queued: 0,
      progressPlan: null,
      completedSteps: [],
      recentActivities: [],
      progressText: 'building',
      progressAgoMs: 1_234,
      messageId: 'msg-1',
      progressMessageId: 'progress-1',
      progressEvents: 1,
      activeSinceMs: 3_000,
      pid: 1234,
      phase: 'exec',
    }),
  });

  const report = formatters.formatProgressReport('thread-1', { provider: 'codex', language: 'en' }, { id: 'channel-1' });

  assert.match(report, /^• model: gpt-5\.4$/m);
});

test('createReportFormatters.formatDoctorReport includes allowlist and workspace lock diagnostics', () => {
  const formatters = createFormatters({ botProvider: 'gemini' });
  const session = { provider: 'gemini', language: 'en', workspaceDir: '/repo/live' };

  const report = formatters.formatDoctorReport('thread-1', session, { id: 'channel-1' });

  assert.match(report, /bot mode: locked to `gemini` \(Gemini CLI\)/);
  assert.match(report, /workspace serialization: busy/);
  assert.match(report, /runtime session store: store:gemini/);
  assert.match(report, /runtime resume surface: resume:gemini/);
  assert.match(report, /runtime native compact: compact:gemini/);
  assert.match(report, /runtime raw config: config:gemini/);
  assert.match(report, /runtime reasoning: reasoning:gemini/);
  assert.match(report, /ALLOWED_CHANNEL_IDS: 2 configured/);
  assert.match(report, /ALLOWED_USER_IDS: 1 configured/);
});

test('createReportFormatters.formatHelpReport documents browse actions and provider switching', () => {
  const sharedFormatters = createFormatters();
  const lockedFormatters = createFormatters({ botProvider: 'codex' });
  const geminiHelp = sharedFormatters.formatHelpReport({ language: 'en', provider: 'gemini' });

  const sharedHelp = sharedFormatters.formatHelpReport({ language: 'en' });
  const lockedHelp = lockedFormatters.formatHelpReport({ language: 'en' });

  assert.match(sharedHelp, /!provider <codex\|claude\|gemini\|kiro\|status>/);
  assert.match(sharedHelp, /!setdir <path\|browse\|default\|status>/);
  assert.match(sharedHelp, /!setdefaultdir <path\|browse\|clear\|status>/);
  assert.match(sharedHelp, /native runtime store/);
  assert.match(sharedHelp, /!rollout_resume/);
  assert.match(sharedHelp, /!rollout_sessions/);
  assert.match(geminiHelp, /!chat_resume/);
  assert.match(geminiHelp, /!chat_sessions/);
  assert.doesNotMatch(geminiHelp, /!config <key=value>/);
  assert.doesNotMatch(geminiHelp, /!effort </);
  assert.match(geminiHelp, /raw config passthrough/);
  assert.doesNotMatch(lockedHelp, /!provider <codex\|claude\|gemini\|kiro\|status>/);
});

test('createReportFormatters.workspace reports explain session reset and lock owner', () => {
  const formatters = createFormatters();

  const updateReport = formatters.formatWorkspaceUpdateReport(
    'thread-1',
    { provider: 'gemini', language: 'en', workspaceDir: '/repo/next' },
    { sessionReset: true, clearedOverride: false },
  );
  const busyReport = formatters.formatWorkspaceBusyReport(
    { language: 'zh' },
    '/repo/next',
    { provider: 'gemini', key: 'thread-9', acquiredAt: '2026-03-13T08:00:00.000Z' },
  );

  assert.match(updateReport, /reset because gemini sessions are treated as workspace-scoped/);
  assert.match(busyReport, /workspace 正忙/);
  assert.match(busyReport, /当前持有 provider: `gemini`/);
  assert.match(busyReport, /当前持有频道: `thread-9`/);
  assert.match(busyReport, /立刻把当前频道切到独立 workspace/);
  assert.match(busyReport, /后续新子 thread 默认独立 workspace/);
  assert.match(busyReport, /\/bot-setdefaultdir path:browse/);
});

test('createReportFormatters config helpers and reports remain available from one factory', () => {
  const formatters = createFormatters();

  const compactHelp = formatters.formatCompactStrategyConfigHelp('en');
  const geminiCompactHelp = formatters.formatCompactStrategyConfigHelp('en', 'gemini');
  const compactReport = formatters.formatCompactConfigReport('zh', {}, true);
  const geminiCompactReport = formatters.formatCompactConfigReport('en', { provider: 'gemini', language: 'en' }, false);
  const timeoutHelp = formatters.formatTimeoutConfigHelp('en');
  const languageReport = formatters.formatLanguageConfigReport('en', true);
  const profileReport = formatters.formatProfileConfigReport('zh', 'team', false);
  const effortHelp = formatters.formatReasoningEffortHelp('zh', 'claude');
  const geminiEffortHelp = formatters.formatReasoningEffortHelp('en', 'gemini');

  assert.match(compactHelp, /\/bot-compact key:<\.\.\.> value:<\.\.\.>/);
  assert.match(compactHelp, /native_limit/);
  assert.doesNotMatch(compactHelp, /compact continue/);
  assert.match(compactHelp, /continue automatically/);
  assert.match(geminiCompactHelp, /!compact <status\|strategy\|token_limit\|enabled\|reset>/);
  assert.match(compactReport, /compact 配置已更新/);
  assert.match(compactReport, /策略:native（频道覆盖）/);
  assert.doesNotMatch(compactReport, /!compact continue/);
  assert.match(compactReport, /bot 会明确显示新的 session id/);
  assert.match(geminiCompactReport, /native compact: provider default behavior/);
  assert.doesNotMatch(geminiCompactReport, /native compact limit:/);
  assert.match(timeoutHelp, /\/bot-timeout <ms\|off\|status>/);
  assert.equal(languageReport, '✅ Message language set to en (English)');
  assert.equal(profileReport, 'ℹ️ 当前安全策略 profile 为 team');
  assert.equal(effortHelp, '用法：`!effort <high|medium|low|default>`');
  assert.match(geminiEffortHelp, /does not expose reasoning effort/);
});
