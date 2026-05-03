import fs from 'node:fs';

import { providerRequiresWorkspaceBoundSession } from './provider-metadata.js';
import { switchSessionProviderState } from './session-provider-state.js';

function hasWorkspaceChanged(previousDir, nextDir) {
  return String(previousDir || '') !== String(nextDir || '');
}

function shouldResetSessionForWorkspaceChange(provider, previousDir, nextDir) {
  return providerRequiresWorkspaceBoundSession(provider) && hasWorkspaceChanged(previousDir, nextDir);
}

function normalizeOptionalOverride(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.toLowerCase() === 'default' ? null : text;
}

function normalizeOptionalEffortOverride(value) {
  const text = normalizeOptionalOverride(value);
  return text === null ? null : text.toLowerCase();
}

function normalizeOptionalRuntimeMode(value) {
  const text = normalizeOptionalOverride(value);
  if (text === null) return null;
  const raw = text.toLowerCase();
  if (raw === 'normal' || raw === 'short' || raw === 'cold') return 'normal';
  if (raw === 'long' || raw === 'hot') return 'long';
  throw new Error(`invalid Claude runtime mode: ${value}`);
}

function normalizeOptionalReplyDeliveryMode(value) {
  const text = normalizeOptionalOverride(value);
  if (text === null) return null;
  const raw = text.toLowerCase();
  if (['card_mention', 'stream_mention', 'card_only', 'stream_only'].includes(raw)) return raw;
  throw new Error(`invalid reply delivery mode: ${value}`);
}

function normalizeOptionalExtraInfoText(value) {
  const text = normalizeOptionalOverride(value);
  return text === null ? null : text;
}

function normalizeSessionKey(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeWorkspacePath(value) {
  const text = String(value || '').trim();
  return text || null;
}

function isExistingDirectory(dir) {
  const candidate = normalizeWorkspacePath(dir);
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function createSessionCommandActions({
  saveDb,
  ensureWorkspace,
  getWorkspaceBinding = () => ({ workspaceDir: null, source: 'legacy fallback' }),
  listStoredSessions = () => [],
  readCodexSessionMetaBySessionId = () => null,
  resolveGeminiProjectRootBySessionId = () => null,
  resolveProviderDefaultWorkspace = () => ({ workspaceDir: null, source: 'unset', envKey: null }),
  setProviderDefaultWorkspace = () => ({ workspaceDir: null, source: 'unset', envKey: null }),
  resolveReplyDeliveryDefault = () => ({ mode: 'card_mention', source: 'env default' }),
  setReplyDeliveryDefault = () => ({ mode: 'card_mention', source: 'env default' }),
  readCodexProfileCatalog = () => ({ profiles: [], configPath: '' }),
  resolveDefaultCodexProfile = () => ({ profile: null, source: 'env default' }),
  setDefaultCodexProfile = () => ({ profile: null, source: 'env default' }),
  readCodexDefaults = () => ({
    model: null,
    modelConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: true,
    fastModeConfigured: false,
  }),
  writeCodexDefaults = () => readCodexDefaults(),
  normalizeProvider = (provider) => String(provider || '').trim().toLowerCase() || 'codex',
  clearSessionId,
  getSessionId,
  setSessionId,
  getSessionProvider,
  getSessionLanguage = () => 'zh',
  normalizeUiLanguage = (value) => (String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh'),
  getProviderShortName = (provider) => String(provider || ''),
  resolveFastModeSetting = () => ({ enabled: false, supported: false, source: 'provider unsupported' }),
  formatProviderSessionLabel = (provider, language = 'en', { plural = false } = {}) => (
    language === 'en'
      ? `${getProviderShortName(provider)} ${plural ? 'sessions' : 'session'}`
      : `${getProviderShortName(provider)} ${plural ? 'sessions' : 'session'}`
  ),
  formatRecentSessionsTitle = (provider, language = 'en') => (
    language === 'en' ? `Recent ${getProviderShortName(provider)} Sessions` : `最近 ${getProviderShortName(provider)} Sessions`
  ),
  formatRecentSessionsLookup = () => '',
  resolveTimeoutSetting,
  listRecentSessions,
  humanAge,
} = {}) {
  function validateCodexProfile(value) {
    const normalized = normalizeOptionalOverride(value);
    if (normalized === null) return null;
    const catalog = readCodexProfileCatalog() || {};
    const profiles = Array.isArray(catalog.profiles) ? catalog.profiles : [];
    if (profiles.includes(normalized)) return normalized;
    const configPath = String(catalog.configPath || '~/.codex/config.toml');
    throw new Error(`unknown Codex profile: ${normalized} (not found in ${configPath})`);
  }

  function resolveStrictProviderSessionWorkspace(provider, sessionId) {
    if (!providerRequiresWorkspaceBoundSession(provider)) return null;
    const normalizedSessionId = normalizeSessionKey(sessionId);
    if (!normalizedSessionId) return null;
    if (provider === 'codex') {
      return normalizeWorkspacePath(readCodexSessionMetaBySessionId(normalizedSessionId)?.cwd);
    }
    if (provider === 'gemini') {
      return normalizeWorkspacePath(resolveGeminiProjectRootBySessionId(normalizedSessionId));
    }
    return null;
  }

  function setOnboardingEnabled(session, enabled) {
    session.onboardingEnabled = enabled;
    saveDb();
    return { enabled: session.onboardingEnabled };
  }

  function setLanguage(session, language) {
    session.language = language;
    saveDb();
    return { language: session.language };
  }

  function setSecurityProfile(session, profile) {
    session.securityProfile = profile;
    saveDb();
    return { profile: session.securityProfile };
  }

  function setTimeoutMs(session, timeoutMs) {
    session.timeoutMs = timeoutMs;
    saveDb();
    return { timeoutSetting: resolveTimeoutSetting(session) };
  }

  function setProvider(session, requested) {
    const { previous, provider } = switchSessionProviderState(session, requested, { normalizeProvider });
    if (previous !== provider) clearForkMetadata(session);
    saveDb();
    return { previous, provider };
  }

  function setModel(session, name) {
    session.model = normalizeOptionalOverride(name);
    saveDb();
    return { model: session.model };
  }

  function setCodexProfile(session, profile) {
    session.codexProfile = validateCodexProfile(profile);
    saveDb();
    return { codexProfile: session.codexProfile };
  }

  function setReasoningEffort(session, effort) {
    session.effort = normalizeOptionalEffortOverride(effort);
    saveDb();
    return { effort: session.effort };
  }

  function setFastMode(session, enabled) {
    session.fastMode = enabled;
    saveDb();
    return { fastModeSetting: resolveFastModeSetting(session) };
  }

  function setRuntimeMode(session, mode) {
    session.runtimeMode = normalizeOptionalRuntimeMode(mode);
    saveDb();
    return { runtimeMode: session.runtimeMode };
  }

  function setReplyDeliveryMode(session, mode) {
    session.replyDeliveryMode = normalizeOptionalReplyDeliveryMode(mode);
    saveDb();
    return { replyDeliveryMode: session.replyDeliveryMode };
  }

  function setExtraInfoEnabled(session, enabled) {
    session.extraInfoEnabled = enabled;
    saveDb();
    return { extraInfoEnabled: session.extraInfoEnabled };
  }

  function setExtraInfoText(session, text) {
    session.extraInfoText = normalizeOptionalExtraInfoText(text);
    saveDb();
    return { extraInfoText: session.extraInfoText };
  }

  function resetExtraInfo(session) {
    session.extraInfoEnabled = null;
    session.extraInfoText = null;
    saveDb();
    return { extraInfoEnabled: session.extraInfoEnabled, extraInfoText: session.extraInfoText };
  }

  function setGlobalModelDefault(_session, value) {
    const defaults = writeCodexDefaults({
      model: normalizeOptionalOverride(value),
    });
    return { defaults };
  }

  function setGlobalReasoningEffortDefault(_session, effort) {
    const defaults = writeCodexDefaults({
      effort: normalizeOptionalEffortOverride(effort),
    });
    return { defaults };
  }

  function setGlobalFastModeDefault(_session, enabled) {
    const defaults = writeCodexDefaults({
      fastMode: enabled,
    });
    return { defaults };
  }

  function setGlobalCodexProfileDefault(_session, profile) {
    const normalized = validateCodexProfile(profile) ?? resolveDefaultCodexProfile().profile;
    return setDefaultCodexProfile(normalized);
  }

  function setGlobalReplyDeliveryModeDefault(_session, mode) {
    const normalizedMode = normalizeOptionalReplyDeliveryMode(mode) || resolveReplyDeliveryDefault().mode;
    return setReplyDeliveryDefault(normalizedMode);
  }

  function setCompactStrategy(session, strategy) {
    session.compactStrategy = strategy;
    saveDb();
    return { compactStrategy: session.compactStrategy };
  }

  function applyCompactConfig(session, parsed) {
    if (parsed.type === 'reset') {
      session.compactStrategy = null;
      session.compactEnabled = null;
      session.compactThresholdTokens = null;
      session.nativeCompactTokenLimit = null;
    } else if (parsed.type === 'set_strategy') {
      session.compactStrategy = parsed.strategy;
    } else if (parsed.type === 'set_enabled') {
      session.compactEnabled = parsed.enabled;
    } else if (parsed.type === 'set_threshold') {
      session.compactThresholdTokens = parsed.tokens;
    } else if (parsed.type === 'set_native_limit') {
      session.nativeCompactTokenLimit = parsed.tokens;
    }
    saveDb();
    return {
      compactStrategy: session.compactStrategy,
      compactEnabled: session.compactEnabled,
      compactThresholdTokens: session.compactThresholdTokens,
      nativeCompactTokenLimit: session.nativeCompactTokenLimit,
    };
  }

  function setMode(session, mode) {
    session.mode = mode;
    saveDb();
    return { mode: session.mode };
  }

  function startNewSession(session) {
    clearSessionId(session);
    session.lastInputTokens = null;
    clearForkMetadata(session);
    saveDb();
    return {
      sessionId: getSessionId(session),
      preservedName: session.name || null,
    };
  }

  function bindSession(session, keyOrSessionId, maybeSessionId) {
    const key = maybeSessionId === undefined ? null : normalizeSessionKey(keyOrSessionId);
    const requestedSessionId = maybeSessionId === undefined ? keyOrSessionId : maybeSessionId;
    const provider = getSessionProvider(session);
    setSessionId(session, requestedSessionId);
    clearForkMetadata(session);
    const normalizedSessionId = getSessionId(session);
    const displacedKeys = [];
    const sessionWorkspaceDir = resolveStrictProviderSessionWorkspace(provider, normalizedSessionId);
    let adoptedWorkspaceDir = null;
    let missingWorkspaceDir = null;

    if (providerRequiresWorkspaceBoundSession(provider) && normalizedSessionId) {
      if (sessionWorkspaceDir) {
        if (isExistingDirectory(sessionWorkspaceDir)) {
          session.workspaceDir = sessionWorkspaceDir;
          adoptedWorkspaceDir = sessionWorkspaceDir;
        } else {
          missingWorkspaceDir = sessionWorkspaceDir;
          clearSessionId(session);
        }
      }
      if (!missingWorkspaceDir) {
        for (const { key: storedKey, session: storedSession } of listStoredSessions({ provider })) {
          const normalizedStoredKey = normalizeSessionKey(storedKey);
          if (!storedSession || storedSession === session) continue;
          if (key && normalizedStoredKey === key) continue;
          if (getSessionId(storedSession) !== normalizedSessionId) continue;
          clearSessionId(storedSession);
          displacedKeys.push(normalizedStoredKey || storedKey);
        }
      }
    }

    saveDb();
    return {
      provider,
      providerLabel: getProviderShortName(provider),
      sessionId: getSessionId(session),
      displacedKeys,
      sessionWorkspaceDir,
      adoptedWorkspaceDir,
      missingWorkspaceDir,
    };
  }

  function clearForkMetadata(session) {
    if (!session || typeof session !== 'object') return;
    session.forkedFromProvider = null;
    session.forkedFromSessionId = null;
    session.forkedFromChannelId = null;
    session.forkedAt = null;
  }

  function bindForkedSession(session, {
    sessionId,
    parentSessionId,
    parentChannelId,
    provider = null,
  } = {}) {
    const normalizedProvider = normalizeProvider(provider || getSessionProvider(session));
    const currentProvider = getSessionProvider(session);
    if (currentProvider !== normalizedProvider) {
      switchSessionProviderState(session, normalizedProvider, { normalizeProvider });
    }
    setSessionId(session, sessionId);
    session.forkedFromProvider = normalizedProvider;
    session.forkedFromSessionId = normalizeSessionKey(parentSessionId);
    session.forkedFromChannelId = normalizeSessionKey(parentChannelId);
    session.forkedAt = new Date().toISOString();
    saveDb();
    return {
      provider: normalizedProvider,
      providerLabel: getProviderShortName(normalizedProvider),
      sessionId: getSessionId(session),
      parentSessionId: session.forkedFromSessionId,
      parentChannelId: session.forkedFromChannelId,
      forkedAt: session.forkedAt,
    };
  }

  function renameSession(session, label) {
    session.name = label;
    saveDb();
    return { label: session.name };
  }

  function setWorkspaceDir(session, key, resolvedPath) {
    const provider = getSessionProvider(session);
    const previousBinding = getWorkspaceBinding(session, key);
    session.workspaceDir = resolvedPath;
    const nextBinding = getWorkspaceBinding(session, key);
    const sessionReset = shouldResetSessionForWorkspaceChange(provider, previousBinding.workspaceDir, nextBinding.workspaceDir);
    if (sessionReset) clearSessionId(session);
    saveDb();
    return {
      provider,
      workspaceDir: nextBinding.workspaceDir,
      source: nextBinding.source,
      previousWorkspaceDir: previousBinding.workspaceDir,
      sessionReset,
      sessionId: getSessionId(session),
    };
  }

  function clearWorkspaceDir(session, key) {
    const provider = getSessionProvider(session);
    const previousBinding = getWorkspaceBinding(session, key);
    session.workspaceDir = null;
    const nextBinding = getWorkspaceBinding(session, key);
    const sessionReset = shouldResetSessionForWorkspaceChange(provider, previousBinding.workspaceDir, nextBinding.workspaceDir);
    if (sessionReset) clearSessionId(session);
    saveDb();
    return {
      provider,
      workspaceDir: nextBinding.workspaceDir,
      source: nextBinding.source,
      previousWorkspaceDir: previousBinding.workspaceDir,
      sessionReset,
      sessionId: getSessionId(session),
      clearedOverride: true,
    };
  }

  function setDefaultWorkspaceDir(session, resolvedPath) {
    const provider = getSessionProvider(session);
    const previousDefault = resolveProviderDefaultWorkspace(provider);
    const trackedSessions = listStoredSessions({ provider });
    const beforeBindings = new Map(
      trackedSessions.map(({ key, session: storedSession }) => [key, getWorkspaceBinding(storedSession, key)]),
    );

    const nextDefault = setProviderDefaultWorkspace(provider, resolvedPath);

    let affectedThreads = 0;
    let resetSessions = 0;
    let currentThreadChanged = false;
    let currentSessionReset = false;

    if (providerRequiresWorkspaceBoundSession(provider)) {
      for (const { key, session: storedSession } of trackedSessions) {
        const before = beforeBindings.get(key);
        const after = getWorkspaceBinding(storedSession, key);
        if (!hasWorkspaceChanged(before?.workspaceDir, after.workspaceDir)) continue;
        affectedThreads += 1;
        currentThreadChanged ||= storedSession === session;
        if (getSessionId(storedSession)) {
          clearSessionId(storedSession);
          resetSessions += 1;
          if (storedSession === session) currentSessionReset = true;
        }
      }
      if (affectedThreads > 0 || resetSessions > 0) {
        saveDb();
      }
    } else {
      const currentKey = trackedSessions.find(({ session: storedSession }) => storedSession === session)?.key || null;
      if (currentKey) {
        const before = beforeBindings.get(currentKey);
        const after = getWorkspaceBinding(session, currentKey);
        currentThreadChanged = hasWorkspaceChanged(before?.workspaceDir, after.workspaceDir);
      }
      affectedThreads = trackedSessions.filter(({ key, session: storedSession }) => {
        const before = beforeBindings.get(key);
        const after = getWorkspaceBinding(storedSession, key);
        return hasWorkspaceChanged(before?.workspaceDir, after.workspaceDir);
      }).length;
    }

    return {
      provider,
      defaultWorkspaceDir: nextDefault.workspaceDir,
      defaultSource: nextDefault.source,
      defaultEnvKey: nextDefault.envKey,
      previousDefaultWorkspaceDir: previousDefault.workspaceDir,
      previousDefaultSource: previousDefault.source,
      affectedThreads,
      resetSessions,
      currentThreadChanged,
      currentSessionReset,
    };
  }

  function resetSession(session) {
    clearSessionId(session);
    session.lastInputTokens = null;
    session.configOverrides = [];
    session.extraInfoEnabled = null;
    session.extraInfoText = null;
    clearForkMetadata(session);
    saveDb();
    return { sessionId: getSessionId(session), configOverrides: session.configOverrides };
  }

  function formatRecentSessionsReport({ key, session, resumeRef = '!resume <id>', limit = 10 } = {}) {
    const provider = getSessionProvider(session);
    const language = normalizeUiLanguage(getSessionLanguage(session));
    const sessions = listRecentSessions({ provider, workspaceDir: ensureWorkspace(session, key), limit });
    if (!sessions.length) {
      return language === 'en'
        ? `No recent ${formatProviderSessionLabel(provider, language)} found.`
        : `没有找到任何 ${formatProviderSessionLabel(provider, language, { plural: true })}。`;
    }
    const lookup = formatRecentSessionsLookup(provider, language);
    const lines = sessions.map((entry, index) => {
      const ago = humanAge(Date.now() - entry.mtime);
      return language === 'en'
        ? `${index + 1}. \`${entry.id}\` (${ago} ago)`
        : `${index + 1}. \`${entry.id}\`（${ago}前）`;
    });
    return [
      language === 'en'
        ? `**${formatRecentSessionsTitle(provider, language)}** (resume with \`${resumeRef}\`)`
        : `**${formatRecentSessionsTitle(provider, language)}**（用 \`${resumeRef}\` 继承）`,
      lookup
        ? (language === 'en' ? `• source: ${lookup}` : `• 来源：${lookup}`)
        : null,
      ...lines,
    ].filter(Boolean).join('\n');
  }

  return {
    setOnboardingEnabled,
    setLanguage,
    setSecurityProfile,
    setTimeoutMs,
    setProvider,
    setModel,
    setCodexProfile,
    setReasoningEffort,
    setFastMode,
    setRuntimeMode,
    setReplyDeliveryMode,
    setExtraInfoEnabled,
    setExtraInfoText,
    resetExtraInfo,
    setGlobalModelDefault,
    setGlobalCodexProfileDefault,
    setGlobalReasoningEffortDefault,
    setGlobalFastModeDefault,
    setGlobalReplyDeliveryModeDefault,
    setCompactStrategy,
    applyCompactConfig,
    setMode,
    startNewSession,
    bindSession,
    bindForkedSession,
    renameSession,
    setWorkspaceDir,
    clearWorkspaceDir,
    setDefaultWorkspaceDir,
    resetSession,
    formatRecentSessionsReport,
  };
}
