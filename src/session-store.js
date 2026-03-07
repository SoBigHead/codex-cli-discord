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
  normalizeSessionProcessLines,
  normalizeSessionCompactStrategy,
  normalizeSessionCompactEnabled,
  normalizeSessionCompactTokenLimit,
} = {}) {
  let db = loadDb(dataFile);

  function saveDb() {
    fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
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
        processLines: null,
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
    if (session.processLines === undefined) {
      session.processLines = null;
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
    const normalizedProcessLines = normalizeSessionProcessLines(session.processLines);
    if (session.processLines !== normalizedProcessLines) {
      session.processLines = normalizedProcessLines;
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

  function ensureWorkspace(session, key) {
    if (!session.workspaceDir) {
      session.workspaceDir = path.join(workspaceRoot, key);
      saveDb();
    }
    ensureDir(session.workspaceDir);
    ensureGitRepo(session.workspaceDir);
    return session.workspaceDir;
  }

  return {
    getSession,
    saveDb,
    ensureWorkspace,
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
