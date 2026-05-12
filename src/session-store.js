import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  commitSessionProviderState,
  ensureSessionProviderStates,
  projectSessionProviderState,
  switchSessionProviderState,
} from './session-provider-state.js';

const SESSION_PROVIDER_STATE_READY = Symbol('sessionProviderStateReady');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensureGitRepo(dir) {
  const check = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: dir,
    stdio: 'ignore',
  });
  if (check.status === 0) return;

  spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
}

function normalizeWorkspaceDir(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return path.resolve(raw);
}

export function normalizeChildThreadWorkspaceMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'separate') return 'separate';
  return 'inherit';
}

function normalizeChannelId(value) {
  const raw = String(value || '').trim();
  return raw || null;
}

function resolveParentChannelId(channel, key = null) {
  if (!channel) return null;
  const isThread = typeof channel.isThread === 'function'
    ? channel.isThread()
    : Boolean(channel.parentId);
  if (!isThread) return null;
  const parentId = normalizeChannelId(channel.parentId || channel.parent?.id);
  const currentKey = normalizeChannelId(key);
  if (!parentId || parentId === currentKey) return null;
  return parentId;
}

function normalizeSessionMode(value, fallback = 'safe') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'dangerous') return 'dangerous';
  if (raw === 'safe') return 'safe';
  return fallback === 'dangerous' ? 'dangerous' : 'safe';
}

function normalizeSessionRuntimeMode(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().toLowerCase();
  if (raw === 'normal' || raw === 'exec') return 'normal';
  if (raw === 'long') return 'long';
  return null;
}

function normalizeBusyPromptMode(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().toLowerCase().replace(/-/g, '_');
  if (raw === 'queue' || raw === 'queued') return 'queue';
  if (raw === 'steer' || raw === 'steer_if_possible') return 'steer_if_possible';
  return null;
}

function normalizeWorkspaceFavoritesMap(value, normalizeProvider) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};

  for (const [providerKey, dirs] of Object.entries(source)) {
    const provider = typeof normalizeProvider === 'function' ? normalizeProvider(providerKey) : providerKey;
    const normalizedDirs = [];
    const seen = new Set();
    for (const dir of Array.isArray(dirs) ? dirs : []) {
      const normalized = normalizeWorkspaceDir(dir);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      normalizedDirs.push(normalized);
    }
    if (normalizedDirs.length > 0) {
      out[provider] = normalizedDirs;
    }
  }

  return out;
}

export function createSessionStore({
  dataFile,
  workspaceRoot,
  childThreadWorkspaceMode = 'inherit',
  resolveChildThreadWorkspaceMode = null,
  botProvider = null,
  defaults,
  getSessionId,
  normalizeProvider,
  normalizeUiLanguage,
  normalizeSessionSecurityProfile,
  normalizeSessionFastMode = () => null,
  normalizeSessionTimeoutMs,
  normalizeSessionCompactStrategy,
  normalizeSessionCompactEnabled,
  normalizeSessionCompactTokenLimit,
  normalizeExtraInfoEnabled = () => null,
  normalizeExtraInfoText = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
  },
  normalizeReplyDeliveryMode = () => null,
  resolveDefaultWorkspace = () => ({ workspaceDir: null, source: 'unset', envKey: null }),
} = {}) {
  let db = loadDb(dataFile);
  const getChildThreadWorkspaceMode = (provider) => {
    if (typeof resolveChildThreadWorkspaceMode === 'function') {
      return normalizeChildThreadWorkspaceMode(resolveChildThreadWorkspaceMode(provider));
    }
    return normalizeChildThreadWorkspaceMode(childThreadWorkspaceMode);
  };

  function ensureDbShape() {
    let changed = false;

    if (!db || typeof db !== 'object' || Array.isArray(db)) {
      db = { threads: {}, workspaceFavorites: {} };
      return true;
    }

    if (!db.threads || typeof db.threads !== 'object' || Array.isArray(db.threads)) {
      db.threads = {};
      changed = true;
    }

    const normalizedFavorites = normalizeWorkspaceFavoritesMap(db.workspaceFavorites, normalizeProvider);
    const currentFavorites = db.workspaceFavorites && typeof db.workspaceFavorites === 'object' && !Array.isArray(db.workspaceFavorites)
      ? db.workspaceFavorites
      : {};
    if (JSON.stringify(currentFavorites) !== JSON.stringify(normalizedFavorites)) {
      db.workspaceFavorites = normalizedFavorites;
      changed = true;
    } else if (db.workspaceFavorites !== currentFavorites) {
      db.workspaceFavorites = currentFavorites;
      changed = true;
    }

    return changed;
  }

  function saveDb() {
    if (db?.threads && typeof db.threads === 'object') {
      for (const session of Object.values(db.threads)) {
        if (!session?.[SESSION_PROVIDER_STATE_READY]) continue;
        commitSessionProviderState(session, { normalizeProvider });
      }
    }
    fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
  }

  if (ensureDbShape()) {
    saveDb();
  }

  function hydrateSession(key, {
    createIfMissing = false,
    touchUpdatedAt = false,
    channel = null,
    parentChannelId = undefined,
  } = {}) {
    db.threads ||= {};
    if (!db.threads[key]) {
      if (!createIfMissing) {
        return { session: null, migrated: false };
      }
      db.threads[key] = {
        workspaceDir: null,
        provider: defaults.provider,
        runnerSessionId: null,
        codexThreadId: null,
        lastInputTokens: null,
        model: null,
        effort: null,
        fastMode: null,
        mode: defaults.mode,
        language: defaults.language,
        onboardingEnabled: defaults.onboardingEnabled,
        parentChannelId: null,
        securityProfile: null,
        timeoutMs: null,
        codexProfile: null,
        replyDeliveryMode: null,
        extraInfoEnabled: null,
        extraInfoText: null,
        compactStrategy: null,
        compactEnabled: null,
        compactThresholdTokens: null,
        nativeCompactTokenLimit: null,
        runtimeMode: null,
        busyPromptMode: null,
        forkedFromProvider: null,
        forkedFromSessionId: null,
        forkedFromChannelId: null,
        forkedAt: null,
        pendingForkFromSessionId: null,
        pendingCompactSummary: null,
        pendingCompactSourceSessionId: null,
        configOverrides: [],
        updatedAt: new Date().toISOString(),
      };
    }

    const session = db.threads[key];
    const providerStateReady = session[SESSION_PROVIDER_STATE_READY] === true;
    let migrated = !providerStateReady;
    const defaultMode = normalizeSessionMode(defaults?.mode, 'safe');

    if (session.provider === undefined) {
      session.provider = defaults.provider;
      migrated = true;
    }
    const ensuredProviderState = ensureSessionProviderStates(session, {
      normalizeProvider,
      provider: session.provider,
      hydrateFromTopLevel: !providerStateReady,
    });
    if (session.provider !== ensuredProviderState.provider) {
      session.provider = ensuredProviderState.provider;
      migrated = true;
    }
    if (!providerStateReady) {
      projectSessionProviderState(session, {
        normalizeProvider,
        provider: session.provider,
      });
    }
    if (botProvider && session.provider !== botProvider) {
      switchSessionProviderState(session, botProvider, { normalizeProvider });
      migrated = true;
    }

    const normalizedProvider = normalizeProvider(session.provider);
    if (session.provider !== normalizedProvider) {
      session.provider = normalizedProvider;
      migrated = true;
    }
    const normalizedMode = normalizeSessionMode(session.mode, defaultMode);
    if (session.mode !== normalizedMode) {
      session.mode = normalizedMode;
      migrated = true;
    }
    if (session.runnerSessionId === undefined) {
      session.runnerSessionId = session.codexThreadId || null;
      migrated = true;
    }

    const normalizedSessionId = getSessionId(session);
    if (session.runnerSessionId !== normalizedSessionId || session.codexThreadId !== normalizedSessionId) {
      session.runnerSessionId = normalizedSessionId;
      session.codexThreadId = normalizedSessionId;
      migrated = true;
    }
    if (session.workspaceDir === undefined) {
      session.workspaceDir = null;
      migrated = true;
    }
    if (session.effort === undefined) {
      session.effort = null;
      migrated = true;
    }
    if (session.codexProfile === undefined) {
      session.codexProfile = null;
      migrated = true;
    }
    if (session.configOverrides === undefined) {
      session.configOverrides = [];
      migrated = true;
    }
    if (session.name === undefined) {
      session.name = null;
      migrated = true;
    }
    if (session.lastInputTokens === undefined) {
      session.lastInputTokens = null;
      migrated = true;
    }
    if (session.language === undefined) {
      session.language = defaults.language;
      migrated = true;
    }
    if (session.onboardingEnabled === undefined) {
      session.onboardingEnabled = defaults.onboardingEnabled;
      migrated = true;
    }
    if (session.parentChannelId === undefined) {
      session.parentChannelId = null;
      migrated = true;
    }
    if (session.securityProfile === undefined) {
      session.securityProfile = null;
      migrated = true;
    }
    if (session.timeoutMs === undefined) {
      session.timeoutMs = null;
      migrated = true;
    }
    if (session.fastMode === undefined) {
      session.fastMode = null;
      migrated = true;
    }
    if (session.replyDeliveryMode === undefined) {
      session.replyDeliveryMode = null;
      migrated = true;
    }
    if (session.extraInfoEnabled === undefined) {
      session.extraInfoEnabled = null;
      migrated = true;
    }
    if (session.extraInfoText === undefined) {
      session.extraInfoText = null;
      migrated = true;
    }
    if (session.compactStrategy === undefined) {
      session.compactStrategy = null;
      migrated = true;
    }
    if (session.compactEnabled === undefined) {
      session.compactEnabled = null;
      migrated = true;
    }
    if (session.compactThresholdTokens === undefined) {
      session.compactThresholdTokens = null;
      migrated = true;
    }
    if (session.nativeCompactTokenLimit === undefined) {
      session.nativeCompactTokenLimit = null;
      migrated = true;
    }
    if (session.runtimeMode === undefined) {
      session.runtimeMode = null;
      migrated = true;
    }
    if (session.busyPromptMode === undefined) {
      session.busyPromptMode = null;
      migrated = true;
    }
    if (session.forkedFromProvider === undefined) {
      session.forkedFromProvider = null;
      migrated = true;
    }
    if (session.forkedFromSessionId === undefined) {
      session.forkedFromSessionId = null;
      migrated = true;
    }
    if (session.forkedFromChannelId === undefined) {
      session.forkedFromChannelId = null;
      migrated = true;
    }
    if (session.forkedAt === undefined) {
      session.forkedAt = null;
      migrated = true;
    }
    if (session.pendingForkFromSessionId === undefined) {
      session.pendingForkFromSessionId = null;
      migrated = true;
    }

    const normalizedWorkspaceDir = normalizeWorkspaceDir(session.workspaceDir);
    if (session.workspaceDir !== normalizedWorkspaceDir) {
      session.workspaceDir = normalizedWorkspaceDir;
      migrated = true;
    }

    let normalizedParentChannelId = normalizeChannelId(session.parentChannelId);
    if (normalizedParentChannelId === normalizeChannelId(key)) {
      normalizedParentChannelId = null;
    }
    if (parentChannelId !== undefined) {
      normalizedParentChannelId = normalizeChannelId(parentChannelId);
    } else if (channel) {
      normalizedParentChannelId = resolveParentChannelId(channel, key);
    }
    if (session.parentChannelId !== normalizedParentChannelId) {
      session.parentChannelId = normalizedParentChannelId;
      migrated = true;
    }

    const legacyWorkspaceDir = normalizeWorkspaceDir(path.join(workspaceRoot, key));
    if (session.workspaceDir && legacyWorkspaceDir && session.workspaceDir === legacyWorkspaceDir) {
      session.workspaceDir = null;
      migrated = true;
    }

    const normalizedLanguage = normalizeUiLanguage(session.language);
    if (session.language !== normalizedLanguage) {
      session.language = normalizedLanguage;
      migrated = true;
    }
    const normalizedSecurityProfile = normalizeSessionSecurityProfile(session.securityProfile);
    if (session.securityProfile !== normalizedSecurityProfile) {
      session.securityProfile = normalizedSecurityProfile;
      migrated = true;
    }
    const normalizedTimeoutMs = normalizeSessionTimeoutMs(session.timeoutMs);
    if (session.timeoutMs !== normalizedTimeoutMs) {
      session.timeoutMs = normalizedTimeoutMs;
      migrated = true;
    }
    const normalizedFastMode = normalizeSessionFastMode(session.fastMode);
    if (session.fastMode !== normalizedFastMode) {
      session.fastMode = normalizedFastMode;
      migrated = true;
    }
    const normalizedReplyDeliveryMode = normalizeReplyDeliveryMode(session.replyDeliveryMode);
    if (session.replyDeliveryMode !== normalizedReplyDeliveryMode) {
      session.replyDeliveryMode = normalizedReplyDeliveryMode;
      migrated = true;
    }
    const normalizedExtraInfoEnabled = normalizeExtraInfoEnabled(session.extraInfoEnabled);
    if (session.extraInfoEnabled !== normalizedExtraInfoEnabled) {
      session.extraInfoEnabled = normalizedExtraInfoEnabled;
      migrated = true;
    }
    const normalizedExtraInfoText = normalizeExtraInfoText(session.extraInfoText);
    if (session.extraInfoText !== normalizedExtraInfoText) {
      session.extraInfoText = normalizedExtraInfoText;
      migrated = true;
    }
    if ('lastPrompt' in session) {
      delete session.lastPrompt;
      migrated = true;
    }
    if ('lastPromptAt' in session) {
      delete session.lastPromptAt;
      migrated = true;
    }
    if ('processLines' in session) {
      delete session.processLines;
      migrated = true;
    }
    const normalizedCompactStrategy = normalizeSessionCompactStrategy(session.compactStrategy);
    if (session.compactStrategy !== normalizedCompactStrategy) {
      session.compactStrategy = normalizedCompactStrategy;
      migrated = true;
    }
    const normalizedCompactEnabled = normalizeSessionCompactEnabled(session.compactEnabled);
    if (session.compactEnabled !== normalizedCompactEnabled) {
      session.compactEnabled = normalizedCompactEnabled;
      migrated = true;
    }
    const normalizedCompactThresholdTokens = normalizeSessionCompactTokenLimit(session.compactThresholdTokens);
    if (session.compactThresholdTokens !== normalizedCompactThresholdTokens) {
      session.compactThresholdTokens = normalizedCompactThresholdTokens;
      migrated = true;
    }
    const normalizedNativeCompactTokenLimit = normalizeSessionCompactTokenLimit(session.nativeCompactTokenLimit);
    if (session.nativeCompactTokenLimit !== normalizedNativeCompactTokenLimit) {
      session.nativeCompactTokenLimit = normalizedNativeCompactTokenLimit;
      migrated = true;
    }
    const normalizedRuntimeMode = normalizeSessionRuntimeMode(session.runtimeMode);
    if (session.runtimeMode !== normalizedRuntimeMode) {
      session.runtimeMode = normalizedRuntimeMode;
      migrated = true;
    }
    const normalizedBusyPromptMode = normalizeBusyPromptMode(session.busyPromptMode);
    if (session.busyPromptMode !== normalizedBusyPromptMode) {
      session.busyPromptMode = normalizedBusyPromptMode;
      migrated = true;
    }
    const normalizedForkedFromProvider = session.forkedFromProvider
      ? normalizeProvider(session.forkedFromProvider)
      : null;
    if (session.forkedFromProvider !== normalizedForkedFromProvider) {
      session.forkedFromProvider = normalizedForkedFromProvider;
      migrated = true;
    }
    const normalizedForkedFromSessionId = normalizeChannelId(session.forkedFromSessionId);
    if (session.forkedFromSessionId !== normalizedForkedFromSessionId) {
      session.forkedFromSessionId = normalizedForkedFromSessionId;
      migrated = true;
    }
    const normalizedForkedFromChannelId = normalizeChannelId(session.forkedFromChannelId);
    if (session.forkedFromChannelId !== normalizedForkedFromChannelId) {
      session.forkedFromChannelId = normalizedForkedFromChannelId;
      migrated = true;
    }
    const normalizedForkedAt = normalizeChannelId(session.forkedAt);
    if (session.forkedAt !== normalizedForkedAt) {
      session.forkedAt = normalizedForkedAt;
      migrated = true;
    }
    const normalizedPendingForkFromSessionId = normalizeChannelId(session.pendingForkFromSessionId);
    if (session.pendingForkFromSessionId !== normalizedPendingForkFromSessionId) {
      session.pendingForkFromSessionId = normalizedPendingForkFromSessionId;
      migrated = true;
    }

    commitSessionProviderState(session, {
      normalizeProvider,
      provider: session.provider,
    });
    projectSessionProviderState(session, {
      normalizeProvider,
      provider: session.provider,
    });
    session[SESSION_PROVIDER_STATE_READY] = true;
    if (touchUpdatedAt) {
      session.updatedAt = new Date().toISOString();
    }
    return { session, migrated };
  }

  function getSession(key, options = {}) {
    const { session, migrated } = hydrateSession(key, {
      createIfMissing: true,
      touchUpdatedAt: true,
      ...options,
    });
    if (migrated) saveDb();
    return session;
  }

  function peekSession(key, options = {}) {
    const { session, migrated } = hydrateSession(key, {
      createIfMissing: false,
      touchUpdatedAt: false,
      ...options,
    });
    if (migrated) saveDb();
    return session;
  }

  function getParentSession(session) {
    const parentChannelId = normalizeChannelId(session?.parentChannelId);
    if (!parentChannelId) return null;
    return peekSession(parentChannelId);
  }

  function getWorkspaceBinding(session, key, visited = new Set()) {
    const provider = normalizeProvider(session?.provider || defaults.provider);
    const childThreadWorkspaceModeValue = getChildThreadWorkspaceMode(provider);
    const defaultBinding = resolveDefaultWorkspace(provider) || {};
    const defaultWorkspaceDir = normalizeWorkspaceDir(defaultBinding.workspaceDir);
    const legacyWorkspaceDir = normalizeWorkspaceDir(path.join(workspaceRoot, key));
    const explicitWorkspaceDir = normalizeWorkspaceDir(session?.workspaceDir);

    if (explicitWorkspaceDir) {
      return {
        provider,
        workspaceDir: explicitWorkspaceDir,
        source: 'thread override',
        defaultWorkspaceDir,
        defaultSource: defaultBinding.source || 'unset',
        defaultEnvKey: defaultBinding.envKey || null,
        legacyWorkspaceDir,
      };
    }

    const normalizedKey = normalizeChannelId(key);
    if (normalizedKey) {
      if (visited.has(normalizedKey)) {
        return {
          provider,
          workspaceDir: defaultWorkspaceDir || legacyWorkspaceDir,
          source: defaultWorkspaceDir ? 'provider default' : 'legacy fallback',
          defaultWorkspaceDir,
          defaultSource: defaultBinding.source || 'unset',
          defaultEnvKey: defaultBinding.envKey || null,
          legacyWorkspaceDir,
        };
      }
      visited.add(normalizedKey);
    }

    if (childThreadWorkspaceModeValue === 'inherit') {
      const parentSession = getParentSession(session);
      const parentChannelId = normalizeChannelId(session?.parentChannelId);
      const parentExplicitWorkspaceDir = normalizeWorkspaceDir(parentSession?.workspaceDir);
      if (parentSession && parentChannelId && parentExplicitWorkspaceDir) {
        const parentBinding = getWorkspaceBinding(parentSession, parentChannelId, visited);
        if (parentBinding?.workspaceDir) {
          return {
            provider,
            workspaceDir: parentBinding.workspaceDir,
            source: 'parent channel',
            parentChannelId,
            parentSource: parentBinding.source,
            defaultWorkspaceDir,
            defaultSource: defaultBinding.source || 'unset',
            defaultEnvKey: defaultBinding.envKey || null,
            legacyWorkspaceDir,
          };
        }
      }
    }

    if (defaultWorkspaceDir) {
      return {
        provider,
        workspaceDir: defaultWorkspaceDir,
        source: 'provider default',
        defaultWorkspaceDir,
        defaultSource: defaultBinding.source || 'unset',
        defaultEnvKey: defaultBinding.envKey || null,
        legacyWorkspaceDir,
      };
    }

    return {
      provider,
      workspaceDir: legacyWorkspaceDir,
      source: 'legacy fallback',
      defaultWorkspaceDir: null,
      defaultSource: defaultBinding.source || 'unset',
      defaultEnvKey: defaultBinding.envKey || null,
      legacyWorkspaceDir,
    };
  }

  function ensureWorkspace(session, key) {
    const binding = getWorkspaceBinding(session, key);
    if (binding.source === 'legacy fallback') {
      ensureDir(binding.workspaceDir);
      return binding.workspaceDir;
    }

    if (!fs.existsSync(binding.workspaceDir)) {
      throw new Error(`Workspace directory does not exist: ${binding.workspaceDir}`);
    }
    const stat = fs.statSync(binding.workspaceDir);
    if (!stat.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${binding.workspaceDir}`);
    }
    return binding.workspaceDir;
  }

  function listSessions({ provider = null } = {}) {
    db.threads ||= {};
    const normalizedProvider = provider ? normalizeProvider(provider) : null;
    return Object.keys(db.threads)
      .map((key) => {
        const { session } = hydrateSession(key, {
          createIfMissing: false,
          touchUpdatedAt: false,
        });
        return session ? { key, session } : null;
      })
      .filter(Boolean)
      .filter(({ session }) => !normalizedProvider || normalizeProvider(session?.provider || defaults.provider) === normalizedProvider);
  }

  function listFavoriteWorkspaces({ provider = null } = {}) {
    ensureDbShape();
    const normalizedProvider = provider ? normalizeProvider(provider) : null;
    if (normalizedProvider) {
      return [...(db.workspaceFavorites?.[normalizedProvider] || [])];
    }

    return Object.entries(db.workspaceFavorites || {})
      .map(([providerKey, workspaceDirs]) => ({
        provider: providerKey,
        workspaceDirs: [...workspaceDirs],
      }));
  }

  function addFavoriteWorkspace(provider, workspaceDir) {
    ensureDbShape();
    const normalizedProvider = normalizeProvider(provider || defaults.provider);
    const normalizedWorkspaceDir = normalizeWorkspaceDir(workspaceDir);
    const current = [...(db.workspaceFavorites[normalizedProvider] || [])];

    if (!normalizedWorkspaceDir) {
      return {
        provider: normalizedProvider,
        workspaceDir: null,
        changed: false,
        favorites: current,
      };
    }

    if (current.includes(normalizedWorkspaceDir)) {
      return {
        provider: normalizedProvider,
        workspaceDir: normalizedWorkspaceDir,
        changed: false,
        favorites: current,
      };
    }

    db.workspaceFavorites[normalizedProvider] = [normalizedWorkspaceDir, ...current];
    saveDb();
    return {
      provider: normalizedProvider,
      workspaceDir: normalizedWorkspaceDir,
      changed: true,
      favorites: [...db.workspaceFavorites[normalizedProvider]],
    };
  }

  function removeFavoriteWorkspace(provider, workspaceDir) {
    ensureDbShape();
    const normalizedProvider = normalizeProvider(provider || defaults.provider);
    const normalizedWorkspaceDir = normalizeWorkspaceDir(workspaceDir);
    const current = [...(db.workspaceFavorites[normalizedProvider] || [])];

    if (!normalizedWorkspaceDir || !current.includes(normalizedWorkspaceDir)) {
      return {
        provider: normalizedProvider,
        workspaceDir: normalizedWorkspaceDir,
        changed: false,
        favorites: current,
      };
    }

    const next = current.filter((dir) => dir !== normalizedWorkspaceDir);
    if (next.length > 0) {
      db.workspaceFavorites[normalizedProvider] = next;
    } else {
      delete db.workspaceFavorites[normalizedProvider];
    }
    saveDb();
    return {
      provider: normalizedProvider,
      workspaceDir: normalizedWorkspaceDir,
      changed: true,
      favorites: [...next],
    };
  }

  return {
    getSession,
    peekSession,
    getParentSession,
    saveDb,
    ensureWorkspace,
    getWorkspaceBinding,
    listSessions,
    listFavoriteWorkspaces,
    addFavoriteWorkspace,
    removeFavoriteWorkspace,
  };
}

function loadDb(dataFile) {
  try {
    if (!fs.existsSync(dataFile)) return { threads: {} };
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (err) {
    console.error('Failed to load DB, using empty state:', err);
    return { threads: {} };
  }
}
