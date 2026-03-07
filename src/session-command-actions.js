export function createSessionCommandActions({
  saveDb,
  ensureWorkspace,
  clearSessionId,
  getSessionId,
  setSessionId,
  getSessionProvider,
  getProviderShortName,
  resolveTimeoutSetting,
  resolveProcessLinesSetting,
  ensureGitRepo,
  listRecentSessions,
  humanAge,
} = {}) {
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

  function setProcessLines(session, lines) {
    session.processLines = lines;
    saveDb();
    return { processLinesSetting: resolveProcessLinesSetting(session) };
  }

  function setProvider(session, requested) {
    const previous = getSessionProvider(session);
    session.provider = requested;
    clearSessionId(session);
    saveDb();
    return { previous, provider: requested };
  }

  function setModel(session, name) {
    session.model = String(name || '').toLowerCase() === 'default' ? null : name;
    saveDb();
    return { model: session.model };
  }

  function setReasoningEffort(session, effort) {
    session.effort = effort === 'default' ? null : effort;
    saveDb();
    return { effort: session.effort };
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

  function bindSession(session, sessionId) {
    setSessionId(session, sessionId);
    saveDb();
    return {
      providerLabel: getProviderShortName(getSessionProvider(session)),
      sessionId: getSessionId(session),
    };
  }

  function renameSession(session, label) {
    session.name = label;
    saveDb();
    return { label: session.name };
  }

  function setWorkspaceDir(session, resolvedPath) {
    ensureGitRepo(resolvedPath);
    session.workspaceDir = resolvedPath;
    clearSessionId(session);
    saveDb();
    return { workspaceDir: session.workspaceDir };
  }

  function resetSession(session) {
    clearSessionId(session);
    session.configOverrides = [];
    saveDb();
    return { sessionId: getSessionId(session), configOverrides: session.configOverrides };
  }

  function formatRecentSessionsReport({ key, session, resumeRef = '!resume <id>', limit = 10 } = {}) {
    const provider = getSessionProvider(session);
    const sessions = listRecentSessions({ provider, workspaceDir: ensureWorkspace(session, key), limit });
    if (!sessions.length) {
      return `没有找到任何 ${getProviderShortName(provider)} session。`;
    }
    const lines = sessions.map((entry, index) => {
      const ago = humanAge(Date.now() - entry.mtime);
      return `${index + 1}. \`${entry.id}\` (${ago} ago)`;
    });
    return [
      `**最近 ${getProviderShortName(provider)} Sessions**（用 \`${resumeRef}\` 继承）`,
      ...lines,
    ].join('\n');
  }

  return {
    setOnboardingEnabled,
    setLanguage,
    setSecurityProfile,
    setTimeoutMs,
    setProcessLines,
    setProvider,
    setModel,
    setReasoningEffort,
    applyCompactConfig,
    setMode,
    bindSession,
    renameSession,
    setWorkspaceDir,
    resetSession,
    formatRecentSessionsReport,
  };
}
