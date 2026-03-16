import {
  getProviderCompactCapabilities,
  getSupportedReasoningEffortLevels,
  normalizeProvider,
} from './provider-metadata.js';

const ACTION_BUTTON_COMMAND_NAMES = Object.freeze(['status', 'sessions', 'queue', 'progress', 'new', 'cancel', 'retry']);

const PROVIDER_NATIVE_SESSION_COMMANDS = Object.freeze({
  codex: Object.freeze({
    resume: 'rollout_resume',
    sessions: 'rollout_sessions',
    sessionTerm: Object.freeze({
      singular: 'rollout session',
      plural: 'rollout sessions',
    }),
  }),
  claude: Object.freeze({
    resume: 'project_resume',
    sessions: 'project_sessions',
    sessionTerm: Object.freeze({
      singular: 'project session',
      plural: 'project sessions',
    }),
  }),
  gemini: Object.freeze({
    resume: 'chat_resume',
    sessions: 'chat_sessions',
    sessionTerm: Object.freeze({
      singular: 'chat session',
      plural: 'chat sessions',
    }),
  }),
});

const ALL_SESSION_COMMAND_ALIASES = Object.freeze({
  sessions: Object.freeze(['rollout_sessions', 'project_sessions', 'chat_sessions']),
  resume: Object.freeze(['rollout_resume', 'project_resume', 'chat_resume']),
});

const REASONING_LEVEL_DISPLAY_ORDER = Object.freeze(['xhigh', 'high', 'medium', 'low']);

const COMMAND_ALIASES = Object.freeze({
  c: 'cancel',
  abort: 'cancel',
  stop: 'cancel',
  fresh: 'new',
  next: 'new',
  start: 'new',
  onboard: 'onboarding',
  guide: 'onboarding',
  lang: 'language',
  cd: 'setdir',
  defaultdir: 'setdefaultdir',
  rollout_sessions: 'sessions',
  project_sessions: 'sessions',
  chat_sessions: 'sessions',
  rollout_resume: 'resume',
  project_resume: 'resume',
  chat_resume: 'resume',
});

export function normalizeCommandName(value, { allowBangPrefix = false } = {}) {
  let raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (allowBangPrefix && raw.startsWith('!')) raw = raw.slice(1);
  return COMMAND_ALIASES[raw] || raw;
}

export function getActionButtonCommandNames() {
  return [...ACTION_BUTTON_COMMAND_NAMES];
}

export function getProviderCommandAlias(provider, commandName) {
  const normalizedProvider = normalizeProvider(provider);
  const surface = PROVIDER_NATIVE_SESSION_COMMANDS[normalizedProvider];
  return surface?.[commandName] || '';
}

function getProviderSessionTerm(provider, { plural = false } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const surface = PROVIDER_NATIVE_SESSION_COMMANDS[normalizedProvider];
  if (!surface?.sessionTerm) return plural ? 'provider sessions' : 'provider session';
  return plural ? surface.sessionTerm.plural : surface.sessionTerm.singular;
}

function getSessionCommandAliases(commandName, botProvider = null) {
  if (!botProvider) return [...(ALL_SESSION_COMMAND_ALIASES[commandName] || [])];
  const alias = getProviderCommandAlias(botProvider, commandName);
  return alias ? [alias] : [];
}

function getSessionAliasDescriptions(aliases = []) {
  return Object.freeze(Object.fromEntries(aliases.map((alias) => {
    if (alias === 'rollout_sessions') return [alias, '列出最近的 rollout sessions（同 sessions）'];
    if (alias === 'project_sessions') return [alias, '列出最近的 project sessions（同 sessions）'];
    if (alias === 'chat_sessions') return [alias, '列出最近的 chat sessions（同 sessions）'];
    if (alias === 'rollout_resume') return [alias, '继承一个已有的 rollout session（同 resume）'];
    if (alias === 'project_resume') return [alias, '继承一个已有的 project session（同 resume）'];
    if (alias === 'chat_resume') return [alias, '继承一个已有的 chat session（同 resume）'];
    return [alias, alias];
  })));
}

function getCompactKeyChoices(botProvider = null) {
  const choices = [
    { name: 'status', value: 'status' },
    { name: 'strategy', value: 'strategy' },
    { name: 'token_limit', value: 'token_limit' },
  ];
  if (!botProvider || getProviderCompactCapabilities(botProvider).supportsNativeLimit) {
    choices.push({ name: 'native_limit', value: 'native_limit' });
  }
  choices.push(
    { name: 'enabled', value: 'enabled' },
    { name: 'reset', value: 'reset' },
  );
  return choices;
}

function getEffortChoices(botProvider = null) {
  if (!botProvider) {
    return [
      { name: 'xhigh', value: 'xhigh' },
      { name: 'high', value: 'high' },
      { name: 'medium', value: 'medium' },
      { name: 'low', value: 'low' },
      { name: 'default', value: 'default' },
    ];
  }
  const supported = new Set(getSupportedReasoningEffortLevels(botProvider));
  const levels = REASONING_LEVEL_DISPLAY_ORDER.filter((level) => supported.has(level));
  if (!levels.length) return [];
  return [
    ...levels.map((level) => ({ name: level, value: level })),
    { name: 'default', value: 'default' },
  ];
}

export function buildSlashCommandEntries({ botProvider = null } = {}) {
  const lockedProvider = botProvider ? normalizeProvider(botProvider) : null;
  const sessionAliases = getSessionCommandAliases('sessions', lockedProvider);
  const resumeAliases = getSessionCommandAliases('resume', lockedProvider);
  const effortChoices = getEffortChoices(lockedProvider);
  const compactKeyChoices = getCompactKeyChoices(lockedProvider);
  const sessionPlural = lockedProvider ? getProviderSessionTerm(lockedProvider, { plural: true }) : 'provider sessions';
  const sessionSingular = lockedProvider ? getProviderSessionTerm(lockedProvider) : 'session';

  return [
    {
      name: 'status',
      description: '查看当前 thread 的 CLI 配置',
    },
    {
      name: 'new',
      description: '切换到新会话，并保留当前频道配置',
    },
    {
      name: 'reset',
      description: '清空当前会话与额外配置，下条消息新开上下文',
    },
    {
      name: 'sessions',
      aliases: sessionAliases,
      description: lockedProvider ? `列出最近的 ${sessionPlural}` : '列出最近的 provider sessions',
      aliasDescriptions: getSessionAliasDescriptions(sessionAliases),
    },
    {
      name: 'setdir',
      description: '设置当前 thread 的工作目录（支持 browse/status/default/clear）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('path').setDescription('绝对路径，或 browse/status/default/clear').setRequired(true));
      },
    },
    {
      name: 'setdefaultdir',
      description: '设置当前 provider 的默认工作目录（支持 browse/status/clear）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('path').setDescription('绝对路径，或 browse/status/clear').setRequired(true));
      },
    },
    !botProvider && {
      name: 'provider',
      description: '切换当前频道使用的 CLI provider',
      configure(builder) {
        return builder.addStringOption(o => o.setName('name').setDescription('provider').setRequired(true)
          .addChoices(
            { name: 'codex', value: 'codex' },
            { name: 'claude', value: 'claude' },
            { name: 'gemini', value: 'gemini' },
            { name: 'status', value: 'status' },
          ));
      },
    },
    {
      name: 'model',
      description: '切换当前 provider 模型',
      configure(builder) {
        return builder.addStringOption(o => o.setName('name').setDescription('模型名（如 o3, gpt-5.3-codex）或 default').setRequired(true));
      },
    },
    effortChoices.length && {
      name: 'effort',
      description: '设置 reasoning effort',
      configure(builder) {
        return builder.addStringOption(o => o.setName('level').setDescription('推理力度').setRequired(true)
          .addChoices(...effortChoices));
      },
    },
    {
      name: 'compact',
      description: lockedProvider && !getProviderCompactCapabilities(lockedProvider).supportsNativeLimit
        ? '配置上下文压缩（hard/native/off、token_limit、enabled、status）'
        : '配置上下文压缩（hard/native/off、limit、enabled、status）',
      configure(builder) {
        return builder
          .addStringOption(o => o.setName('key').setDescription('配置项').setRequired(true)
            .addChoices(...compactKeyChoices))
          .addStringOption(o => o.setName('value').setDescription('值：如 native / 272000 / on / default').setRequired(false));
      },
    },
    {
      name: 'mode',
      description: '执行模式',
      configure(builder) {
        return builder.addStringOption(o => o.setName('type').setDescription('模式').setRequired(true)
          .addChoices(
            { name: 'safe (sandbox + auto-approve)', value: 'safe' },
            { name: 'dangerous (无 sandbox 无审批)', value: 'dangerous' },
          ));
      },
    },
    {
      name: 'name',
      description: lockedProvider ? `给当前 ${sessionSingular} 起个名字，方便识别` : '给当前 session 起个名字，方便识别',
      configure(builder) {
        return builder.addStringOption(o => o.setName('label').setDescription('名字，如「cc-hub诊断」「埋点重构」').setRequired(true));
      },
    },
    {
      name: 'resume',
      aliases: resumeAliases,
      description: lockedProvider ? `继承一个已有的 ${sessionSingular}` : '继承一个已有的 session',
      aliasDescriptions: getSessionAliasDescriptions(resumeAliases),
      configure(builder) {
        return builder.addStringOption(o => o.setName('session_id').setDescription(
          lockedProvider ? `${sessionSingular} UUID` : 'provider session UUID',
        ).setRequired(true));
      },
    },
    {
      name: 'queue',
      description: '查看当前频道的任务队列状态',
    },
    {
      name: 'doctor',
      description: '查看 bot 运行与安全配置体检',
    },
    {
      name: 'onboarding',
      description: '新用户引导：安装后检查与首跑步骤（按钮分步）',
    },
    {
      name: 'onboarding_config',
      description: '配置 onboarding 开关（当前频道）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('action').setDescription('操作').setRequired(true)
          .addChoices(
            { name: 'on', value: 'on' },
            { name: 'off', value: 'off' },
            { name: 'status', value: 'status' },
          ));
      },
    },
    {
      name: 'language',
      description: '设置消息提示语言（中文/English）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('name').setDescription('语言').setRequired(true)
          .addChoices(
            { name: '中文', value: 'zh' },
            { name: 'English', value: 'en' },
          ));
      },
    },
    {
      name: 'profile',
      description: '设置当前频道 security profile（auto/solo/team/public）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('name').setDescription('profile').setRequired(true)
          .addChoices(
            { name: 'auto', value: 'auto' },
            { name: 'solo', value: 'solo' },
            { name: 'team', value: 'team' },
            { name: 'public', value: 'public' },
            { name: 'status', value: 'status' },
          ));
      },
    },
    {
      name: 'timeout',
      description: '设置当前频道 runner timeout（ms/off/status）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('value').setDescription('如 60000 / off / status').setRequired(true));
      },
    },
    {
      name: 'progress',
      description: '查看当前任务的最新执行进度',
    },
    {
      name: 'cancel',
      aliases: ['abort'],
      description: '中断当前任务并清空排队消息',
    },
  ].filter(Boolean);
}
