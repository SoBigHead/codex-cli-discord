const PROVIDER_METADATA = Object.freeze({
  codex: Object.freeze({
    aliases: Object.freeze(['codex', 'openai']),
    displayName: 'Codex CLI',
    shortName: 'Codex',
    defaultBin: 'codex',
    binEnvName: 'CODEX_BIN',
    defaultSlashPrefix: 'cx',
    capabilities: Object.freeze({
      reasoningEffortLevels: Object.freeze(['low', 'medium', 'high', 'xhigh']),
      rawConfigOverrides: Object.freeze({
        supported: true,
      }),
      compact: Object.freeze({
        strategies: Object.freeze(['hard', 'native', 'off']),
        supportsNativeStrategy: true,
        supportsNativeLimit: true,
      }),
      workspaceSessionPolicy: 'strict',
    }),
  }),
  claude: Object.freeze({
    aliases: Object.freeze(['claude', 'anthropic']),
    displayName: 'Claude Code',
    shortName: 'Claude',
    defaultBin: 'claude',
    binEnvName: 'CLAUDE_BIN',
    defaultSlashPrefix: 'cc',
    capabilities: Object.freeze({
      reasoningEffortLevels: Object.freeze(['low', 'medium', 'high']),
      rawConfigOverrides: Object.freeze({
        supported: false,
      }),
      compact: Object.freeze({
        strategies: Object.freeze(['hard', 'native', 'off']),
        supportsNativeStrategy: true,
        supportsNativeLimit: false,
      }),
      workspaceSessionPolicy: 'portable',
    }),
  }),
  gemini: Object.freeze({
    aliases: Object.freeze(['gemini', 'google']),
    displayName: 'Gemini CLI',
    shortName: 'Gemini',
    defaultBin: 'gemini',
    binEnvName: 'GEMINI_BIN',
    defaultSlashPrefix: 'gm',
    capabilities: Object.freeze({
      reasoningEffortLevels: Object.freeze([]),
      rawConfigOverrides: Object.freeze({
        supported: false,
      }),
      compact: Object.freeze({
        strategies: Object.freeze(['hard', 'native', 'off']),
        supportsNativeStrategy: true,
        supportsNativeLimit: false,
      }),
      workspaceSessionPolicy: 'strict',
    }),
  }),
  kiro: Object.freeze({
    aliases: Object.freeze(['kiro', 'amazon', 'aws']),
    displayName: 'Kiro CLI',
    shortName: 'Kiro',
    defaultBin: 'kiro-cli',
    binEnvName: 'KIRO_BIN',
    defaultSlashPrefix: 'kr',
    capabilities: Object.freeze({
      reasoningEffortLevels: Object.freeze([]),
      rawConfigOverrides: Object.freeze({
        supported: false,
      }),
      compact: Object.freeze({
        strategies: Object.freeze(['hard', 'off']),
        supportsNativeStrategy: false,
        supportsNativeLimit: false,
      }),
      workspaceSessionPolicy: 'strict',
    }),
  }),
  kimi: Object.freeze({
    aliases: Object.freeze(['kimi', 'moonshot']),
    displayName: 'Kimi CLI',
    shortName: 'Kimi',
    defaultBin: 'kimi',
    binEnvName: 'KIMI_BIN',
    defaultSlashPrefix: 'km',
    capabilities: Object.freeze({
      reasoningEffortLevels: Object.freeze([]),
      rawConfigOverrides: Object.freeze({
        supported: false,
      }),
      compact: Object.freeze({
        strategies: Object.freeze(['hard', 'off']),
        supportsNativeStrategy: false,
        supportsNativeLimit: false,
      }),
      workspaceSessionPolicy: 'strict',
    }),
  }),
});

function normalizeCompactStrategyValue(value) {
  return String(value || '').trim().toLowerCase();
}

function findProviderByAlias(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;

  for (const [provider, metadata] of Object.entries(PROVIDER_METADATA)) {
    if (metadata.aliases.includes(raw)) return provider;
  }

  return null;
}

export function normalizeProvider(value, fallback = 'codex') {
  return findProviderByAlias(value) || fallback;
}

export function parseOptionalProvider(value) {
  return findProviderByAlias(value);
}

export function parseProviderInput(value) {
  return parseOptionalProvider(value);
}

export function getProviderMetadata(provider) {
  const normalized = normalizeProvider(provider);
  return PROVIDER_METADATA[normalized] || PROVIDER_METADATA.codex;
}

export function getProviderCapabilities(provider) {
  return getProviderMetadata(provider).capabilities;
}

export function getProviderDisplayName(provider) {
  return getProviderMetadata(provider).displayName;
}

export function getProviderShortName(provider) {
  return getProviderMetadata(provider).shortName;
}

export function getProviderDefaultBin(provider) {
  return getProviderMetadata(provider).defaultBin;
}

export function getProviderBinEnvName(provider) {
  return getProviderMetadata(provider).binEnvName;
}

export function getProviderDefaultSlashPrefix(provider = null) {
  const normalized = parseOptionalProvider(provider) || 'codex';
  return getProviderMetadata(normalized).defaultSlashPrefix;
}

export function providerSupportsRawConfigOverrides(provider) {
  return getProviderCapabilities(provider).rawConfigOverrides.supported;
}

export function providerSupportsConfigOverrides(provider) {
  return providerSupportsRawConfigOverrides(provider);
}

export function getProviderCompactCapabilities(provider) {
  return getProviderCapabilities(provider).compact;
}

export function providerSupportsNativeCompact(provider) {
  return getProviderCompactCapabilities(provider).supportsNativeStrategy;
}

export function getSupportedCompactStrategies(provider) {
  return [...getProviderCompactCapabilities(provider).strategies];
}

export function providerSupportsCompactStrategy(provider, strategy) {
  const normalizedStrategy = normalizeCompactStrategyValue(strategy);
  if (!normalizedStrategy) return true;
  return getSupportedCompactStrategies(provider).includes(normalizedStrategy);
}

export function providerSupportsCompactConfigAction(provider, action) {
  if (!action || action.type === 'status' || action.type === 'reset') return true;
  if (action.type === 'set_strategy') {
    return providerSupportsCompactStrategy(provider, action.strategy);
  }
  if (action.type === 'set_native_limit') {
    return getProviderCompactCapabilities(provider).supportsNativeLimit;
  }
  return true;
}

export function formatCompactConfigUnsupported(provider, action, language = 'en') {
  const displayName = getProviderDisplayName(provider);
  const compact = getProviderCompactCapabilities(provider);
  const strategyList = compact.strategies
    .filter((value) => value !== 'native')
    .map((value) => `\`${value}\``)
    .join(', ');

  if (action?.type === 'set_strategy' && normalizeCompactStrategyValue(action.strategy) === 'native') {
    if (language === 'en') {
      return `⚠️ Current provider ${displayName} does not expose \`native\` compaction. Use ${strategyList} instead.`;
    }
    return `⚠️ 当前 provider ${displayName} 不支持 \`native\` 压缩。请改用 ${strategyList}。`;
  }

  if (action?.type === 'set_native_limit') {
    if (language === 'en') {
      return `⚠️ Current provider ${displayName} does not expose a configurable \`native_limit\`. Native compaction can still run with the provider default behavior.`;
    }
    return `⚠️ 当前 provider ${displayName} 没有暴露可配置的 \`native_limit\`。native 压缩仍可按 provider 默认行为运行。`;
  }

  if (language === 'en') {
    return `⚠️ Current provider ${displayName} does not support this compact setting.`;
  }
  return `⚠️ 当前 provider ${displayName} 不支持这个 compact 配置。`;
}

export function getProviderSessionWorkspacePolicy(provider) {
  return getProviderCapabilities(provider).workspaceSessionPolicy;
}

export function providerRequiresWorkspaceBoundSession(provider) {
  return getProviderSessionWorkspacePolicy(provider) === 'strict';
}

export function providerBindsSessionsToWorkspace(provider) {
  return providerRequiresWorkspaceBoundSession(provider);
}

export function formatWorkspaceSessionPolicy(provider, language = 'en') {
  const displayName = getProviderDisplayName(provider);
  if (providerRequiresWorkspaceBoundSession(provider)) {
    if (language === 'en') {
      return `${displayName} sessions are treated as workspace-scoped; changing workspace resets the bound session.`;
    }
    return `${displayName} 的 session 按 workspace 绑定处理；切换 workspace 时会重置已绑定 session。`;
  }
  if (language === 'en') {
    return `${displayName} sessions are treated as portable; changing workspace keeps the bound session when possible.`;
  }
  return `${displayName} 的 session 按可迁移处理；切换 workspace 时会尽量保留已绑定 session。`;
}

export function formatWorkspaceSessionResetReason(provider, language = 'en') {
  const displayName = getProviderDisplayName(provider);
  if (providerRequiresWorkspaceBoundSession(provider)) {
    if (language === 'en') {
      return `reset because ${displayName} sessions are treated as workspace-scoped`;
    }
    return `已重置（${displayName} 的 session 按 workspace 绑定处理）`;
  }
  if (language === 'en') {
    return `kept because ${displayName} sessions are treated as portable`;
  }
  return `已保留（${displayName} 的 session 按可迁移处理）`;
}

export function getSupportedReasoningEffortLevels(provider) {
  return [...getProviderCapabilities(provider).reasoningEffortLevels];
}

export function isReasoningEffortSupported(provider, effort) {
  if (!effort) return true;
  return getSupportedReasoningEffortLevels(provider).includes(String(effort || '').trim().toLowerCase());
}

export function formatReasoningEffortUnsupported(provider, language = 'en') {
  const displayName = getProviderDisplayName(provider);
  const levels = getSupportedReasoningEffortLevels(provider);
  if (!levels.length) {
    if (language === 'en') {
      return `⚠️ Reasoning effort is not currently exposed for ${displayName}.`;
    }
    return `⚠️ ${displayName} 当前不支持 reasoning effort。`;
  }
  if (language === 'en') {
    return `⚠️ ${displayName} supports ${levels.map((level) => `\`${level}\``).join(', ')}.`;
  }
  return `⚠️ ${displayName} 当前支持 ${levels.map((level) => `\`${level}\``).join('、')}。`;
}
