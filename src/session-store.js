import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
  botProvider = null,
  defaults,
  getSessionId,
  normalizeProvider,
  normalizeUiLanguage,
  normalizeSessionSecurityProfile,
  normalizeSessionTimeoutMs,
  normalizeSessionCompactStrategy,
  normalizeSessionCompactEnabled,
  normalizeSessionCompactTokenLimit,
  resolveDefaultWorkspace = () => ({ workspaceDir: null, source: 'unset', envKey: null }),
} = {}) {
  let db = loadDb(dataFile);

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
    fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
  }

  if (ensureDbShape()) {
    saveDb();
  }

  function getSession(key) {
    db.threads ||= {};
    if (!db.threads[key]) {
      db.threads[key] = {
        workspaceDir: null,
        provider: defaults.provider,
        runnerSessionId: null,
        codexThreadId: null,
        lastInputTokens: null,
        model: null,
        effort: null,
        mode: defaults.mode,
        language: defaults.language,
        onboardingEnabled: defaults.onboardingEnabled,
        securityProfile: null,
        timeoutMs: null,
        compactStrategy: null,
        compactEnabled: null,
        compactThresholdTokens: null,
        nativeCompactTokenLimit: null,
        configOverrides: [],
        updatedAt: new Date().toISOString(),
      };
      saveDb();
    }

    const session = db.threads[key];
    let migrated = false;

    if (botProvider && session.provider !== botProvider) {
      session.provider = botProvider;
      migrated = true;
    }
    if (session.provider === undefined) {
      session.provider = defaults.provider;
      migrated = true;
    }

    const normalizedProvider = normalizeProvider(session.provider);
    if (session.provider !== normalizedProvider) {
      session.provider = normalizedProvider;
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
    if (session.securityProfile === undefined) {
      session.securityProfile = null;
      migrated = true;
    }
    if (session.timeoutMs === undefined) {
      session.timeoutMs = null;
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

    const normalizedWorkspaceDir = normalizeWorkspaceDir(session.workspaceDir);
    if (session.workspaceDir !== normalizedWorkspaceDir) {
      session.workspaceDir = normalizedWorkspaceDir;
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

    session.updatedAt = new Date().toISOString();
    if (migrated) saveDb();
    return session;
  }

  function getWorkspaceBinding(session, key) {
    const provider = normalizeProvider(session?.provider || defaults.provider);
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
    return Object.entries(db.threads)
      .map(([key, session]) => ({ key, session }))
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
