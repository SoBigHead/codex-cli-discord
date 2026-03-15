import {
  getSupportedReasoningEffortLevels,
  getProviderShortName,
  normalizeProvider,
  providerSupportsRawConfigOverrides,
} from './provider-metadata.js';

const PROVIDER_RUNTIME_SURFACES = Object.freeze({
  codex: Object.freeze({
    sessionTerm: Object.freeze({
      en: Object.freeze({ singular: 'rollout session', plural: 'rollout sessions' }),
      zh: Object.freeze({ singular: 'rollout session', plural: 'rollout sessions' }),
    }),
    recentSessionsTitle: Object.freeze({
      en: 'Recent Codex Sessions',
      zh: '最近 Codex Sessions',
    }),
    recentSessionsLookup: Object.freeze({
      en: 'global rollout history in `~/.codex/sessions`',
      zh: '全局 rollout 历史，来源 `~/.codex/sessions`',
    }),
    runtimeSummary: Object.freeze({
      en: 'global rollout sessions, raw config passthrough, configurable native limit',
      zh: '全局 rollout sessions、原生 config 透传、可配置 native limit',
    }),
    sessionStore: Object.freeze({
      en: 'global rollout history (`~/.codex/sessions`)',
      zh: '全局 rollout 历史（`~/.codex/sessions`）',
    }),
    resumeSurface: Object.freeze({
      en: 'session-id resume; workspace binding is handled separately by the bot',
      zh: '按 session id 恢复；workspace 绑定由 bot 单独处理',
    }),
    nativeCompactSurface: Object.freeze({
      en: 'provider-native compaction with configurable token limit',
      zh: 'provider 原生压缩，并支持可配置 token limit',
    }),
    rawConfigSurface: Object.freeze({
      en: 'stable raw config passthrough via `-c key=value`',
      zh: '暴露稳定的 raw config passthrough（`-c key=value`）',
    }),
  }),
  claude: Object.freeze({
    sessionTerm: Object.freeze({
      en: Object.freeze({ singular: 'project session', plural: 'project sessions' }),
      zh: Object.freeze({ singular: 'project session', plural: 'project sessions' }),
    }),
    recentSessionsTitle: Object.freeze({
      en: 'Recent Claude Project Sessions',
      zh: '最近 Claude Project Sessions',
    }),
    recentSessionsLookup: Object.freeze({
      en: 'prefers current workspace in `~/.claude/projects/<workspace>`, then falls back to other Claude projects',
      zh: '优先读取当前 workspace 对应的 `~/.claude/projects/<workspace>`，再回退到其他 Claude projects',
    }),
    runtimeSummary: Object.freeze({
      en: 'project sessions, portable resume, provider-default native compaction',
      zh: 'project sessions、可迁移 resume、provider 默认 native 压缩',
    }),
    sessionStore: Object.freeze({
      en: 'project session files (`~/.claude/projects/<workspace>`)',
      zh: 'project session 文件（`~/.claude/projects/<workspace>`）',
    }),
    resumeSurface: Object.freeze({
      en: 'project-session resume; workspace changes usually keep the bound session',
      zh: '按 project session 恢复；切换 workspace 时通常保留已绑定 session',
    }),
    nativeCompactSurface: Object.freeze({
      en: 'provider-native compaction; no exposed native limit override',
      zh: 'provider 原生压缩；不暴露 native limit 覆盖',
    }),
    rawConfigSurface: Object.freeze({
      en: 'no stable raw config passthrough surface exposed by the CLI',
      zh: 'CLI 没有暴露稳定的 raw config passthrough',
    }),
  }),
  gemini: Object.freeze({
    sessionTerm: Object.freeze({
      en: Object.freeze({ singular: 'chat session', plural: 'chat sessions' }),
      zh: Object.freeze({ singular: 'chat session', plural: 'chat sessions' }),
    }),
    recentSessionsTitle: Object.freeze({
      en: 'Recent Gemini Chat Sessions',
      zh: '最近 Gemini Chat Sessions',
    }),
    recentSessionsLookup: Object.freeze({
      en: 'prefers current workspace in `~/.gemini/tmp/<project>/chats`, then scans other Gemini project caches',
      zh: '优先读取当前 workspace 对应的 `~/.gemini/tmp/<project>/chats`，再扫描其他 Gemini project cache',
    }),
    runtimeSummary: Object.freeze({
      en: 'workspace chat sessions, workspace-bound resume, provider-default native compaction',
      zh: 'workspace chat sessions、workspace 绑定 resume、provider 默认 native 压缩',
    }),
    sessionStore: Object.freeze({
      en: 'project chat snapshots (`~/.gemini/tmp/<project>/chats`)',
      zh: 'project chat 快照（`~/.gemini/tmp/<project>/chats`）',
    }),
    resumeSurface: Object.freeze({
      en: 'workspace chat resume; workspace changes reset the bound session',
      zh: '按 workspace chat 恢复；切换 workspace 时会重置已绑定 session',
    }),
    nativeCompactSurface: Object.freeze({
      en: 'provider-native compaction; no exposed native limit override',
      zh: 'provider 原生压缩；不暴露 native limit 覆盖',
    }),
    rawConfigSurface: Object.freeze({
      en: 'no stable raw config passthrough surface exposed by the CLI',
      zh: 'CLI 没有暴露稳定的 raw config passthrough',
    }),
  }),
});

function getSurface(provider) {
  return PROVIDER_RUNTIME_SURFACES[normalizeProvider(provider)] || PROVIDER_RUNTIME_SURFACES.codex;
}

function readLocalized(value, language = 'en') {
  if (!value || typeof value !== 'object') return '';
  return language === 'zh' ? value.zh || value.en || '' : value.en || value.zh || '';
}

export function formatProviderRuntimeSummary(provider, language = 'en') {
  return readLocalized(getSurface(provider).runtimeSummary, language);
}

export function formatProviderSessionTerm(provider, language = 'en', { plural = false } = {}) {
  const surface = getSurface(provider);
  const localized = language === 'zh' ? surface.sessionTerm?.zh : surface.sessionTerm?.en;
  if (!localized || typeof localized !== 'object') return plural ? 'sessions' : 'session';
  return plural ? localized.plural || localized.singular || 'sessions' : localized.singular || 'session';
}

export function formatProviderSessionLabel(provider, language = 'en', { plural = false } = {}) {
  return `${getProviderShortName(provider)} ${formatProviderSessionTerm(provider, language, { plural })}`.trim();
}

export function formatProviderSessionStoreSurface(provider, language = 'en') {
  return readLocalized(getSurface(provider).sessionStore, language);
}

export function formatProviderResumeSurface(provider, language = 'en') {
  return readLocalized(getSurface(provider).resumeSurface, language);
}

export function formatProviderNativeCompactSurface(provider, language = 'en') {
  return readLocalized(getSurface(provider).nativeCompactSurface, language);
}

export function formatProviderRawConfigSurface(provider, language = 'en') {
  if (providerSupportsRawConfigOverrides(provider)) {
    return readLocalized(PROVIDER_RUNTIME_SURFACES.codex.rawConfigSurface, language);
  }
  return readLocalized(getSurface(provider).rawConfigSurface, language);
}

export function formatProviderReasoningSurface(provider, language = 'en') {
  const levels = getSupportedReasoningEffortLevels(provider);
  if (!levels.length) {
    return language === 'zh' ? '未暴露 reasoning effort 能力面' : 'reasoning effort not exposed';
  }
  return levels.map((level) => `\`${level}\``).join(language === 'zh' ? '、' : ', ');
}

export function formatRecentSessionsTitle(provider, language = 'en') {
  return readLocalized(getSurface(provider).recentSessionsTitle, language);
}

export function formatRecentSessionsLookup(provider, language = 'en') {
  return readLocalized(getSurface(provider).recentSessionsLookup, language);
}
