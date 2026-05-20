import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import {
  getProviderBinEnvName,
  normalizeProvider,
} from './provider-metadata.js';
import {
  getLaunchctlGuardBinDir,
} from './launchctl-guard.js';

function truncate(text, max) {
  const value = String(text || '');
  if (!value || value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function truncateError(text, max = 220) {
  return truncate(String(text || '').replace(/\s+/g, ' ').trim(), max);
}

function cloneJsonLike(value) {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function decodeJwtPayload(token) {
  const value = String(token || '').trim();
  const parts = value.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const normalized = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function readCodexAuthIdentity({
  spawnEnv = process.env,
  authFile = null,
} = {}) {
  const homeDir = authFile
    ? null
    : (spawnEnv?.HOME || spawnEnv?.USERPROFILE || process.env.HOME || process.env.USERPROFILE || '');
  const resolvedAuthFile = authFile || (homeDir ? path.join(homeDir, '.codex', 'auth.json') : '');
  if (!resolvedAuthFile) return null;

  try {
    const raw = await readFile(resolvedAuthFile, 'utf8');
    const parsed = JSON.parse(raw);
    const tokens = parsed?.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {};
    const idTokenPayload = decodeJwtPayload(tokens.id_token);
    const accessTokenPayload = decodeJwtPayload(tokens.access_token);
    const authClaims = accessTokenPayload?.['https://api.openai.com/auth']
      || idTokenPayload?.['https://api.openai.com/auth']
      || {};
    const profileClaims = accessTokenPayload?.['https://api.openai.com/profile'] || {};
    const organizations = Array.isArray(authClaims.organizations) ? authClaims.organizations : [];
    const primaryOrg = organizations.find((item) => item?.is_default) || organizations[0] || null;
    const email = profileClaims.email
      || idTokenPayload?.email
      || null;
    const name = idTokenPayload?.name || null;
    const planType = authClaims.chatgpt_plan_type || null;
    const accountId = tokens.account_id || authClaims.chatgpt_account_id || null;
    const orgTitle = primaryOrg?.title || null;
    const authMode = parsed?.auth_mode || null;

    if (!authMode && !email && !name && !planType && !accountId && !orgTitle) {
      return null;
    }

    return {
      authMode,
      email,
      name,
      planType,
      accountId,
      organizationTitle: orgTitle,
    };
  } catch {
    return null;
  }
}

export function buildSpawnEnv(env) {
  const out = { ...env };
  const home = out.HOME || out.USERPROFILE || '';
  const delimiter = path.delimiter;
  const rawPath = out.PATH || '';
  const entries = [];
  const seen = new Set();
  const guardBinDir = getLaunchctlGuardBinDir();

  const extras = [
    guardBinDir,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    home ? path.join(home, '.local', 'bin') : null,
    home ? path.join(home, 'bin') : null,
  ].filter(Boolean);

  const addPath = (currentPath) => {
    if (!currentPath || seen.has(currentPath)) return;
    entries.push(currentPath);
    seen.add(currentPath);
  };

  for (const currentPath of extras) {
    addPath(currentPath);
  }

  for (const currentPath of rawPath.split(delimiter).filter(Boolean)) {
    addPath(currentPath);
  }

  out.PATH = entries.join(delimiter);
  return out;
}

export function getProviderBin(provider, options = {}) {
  const {
    codexBin = 'codex',
    claudeBin = 'claude',
    legacyGeminiBin = '',
  } = options;
  const antigravityBin = options.antigravityBin || legacyGeminiBin || 'agy';
  switch (normalizeProvider(provider)) {
    case 'claude':
      return claudeBin;
    case 'antigravity':
      return antigravityBin;
    default:
      return codexBin;
  }
}

function getCliHealthForBin({
  bin,
  envKey,
  spawnEnv,
  safeError = (err) => String(err?.message || err || 'unknown error'),
} = {}) {
  const check = spawnSync(bin, ['--version'], {
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (check.error) {
    return {
      ok: false,
      bin,
      envKey,
      error: safeError(check.error),
    };
  }

  if (check.status !== 0) {
    return {
      ok: false,
      bin,
      envKey,
      error: (check.stderr || check.stdout || `exit=${check.status}`).trim(),
    };
  }

  const versionLine = (check.stdout || check.stderr || '').trim().split('\n')[0] || 'ok';
  return {
    ok: true,
    bin,
    envKey,
    version: versionLine,
  };
}

export function getCliHealth(provider, options = {}) {
  const {
    codexBin = 'codex',
    claudeBin = 'claude',
    antigravityBin,
    legacyGeminiBin,
    spawnEnv = process.env,
    safeError,
  } = options;
  const bin = getProviderBin(provider, {
    codexBin,
    claudeBin,
    antigravityBin,
    legacyGeminiBin,
  });
  return getCliHealthForBin({
    bin,
    envKey: getProviderBinEnvName(provider),
    spawnEnv,
    safeError,
  });
}

export function isCliNotFound(errorText) {
  const message = String(errorText || '').toLowerCase();
  return message.includes('enoent') || message.includes('not found');
}

export function formatCliHealth(health, language = 'zh') {
  if (health.ok) return `✅ \`${health.bin}\` (${health.version})`;
  if (isCliNotFound(health.error)) {
    return language === 'en'
      ? `❌ \`${health.bin}\` not found (set ${health.envKey || 'CLI_BIN'}=/absolute/path/${health.bin} in .env)`
      : `❌ 未找到 \`${health.bin}\`（可在 .env 设置 ${health.envKey || 'CLI_BIN'}=/绝对路径/${health.bin}）`;
  }
  return `❌ ${truncate(String(health.error || 'unknown error'), 220)}`;
}

export async function getCodexAccountRateLimits(provider = 'codex', {
  codexBin = 'codex',
  spawnEnv = process.env,
  timeoutMs = 5000,
  spawnImpl = spawn,
  safeError = (err) => String(err?.message || err || 'unknown error'),
} = {}) {
  if (normalizeProvider(provider) !== 'codex') {
    return {
      ok: false,
      unsupported: true,
      error: 'rate limits are only exposed by Codex app-server',
    };
  }

  const account = await readCodexAuthIdentity({ spawnEnv });

  return new Promise((resolve) => {
    let child = null;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    let accountRequestSent = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
      resolve(account && payload && typeof payload === 'object'
        ? { ...payload, account: payload.account || account }
        : payload);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `codex app-server rate limit query timed out after ${timeoutMs}ms`,
      });
    }, Math.max(1000, Number(timeoutMs || 5000)));

    try {
      child = spawnImpl(codexBin, ['app-server', '--listen', 'stdio://'], {
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({ ok: false, error: safeError(err) });
      return;
    }

    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (err) {
        finish({ ok: false, error: safeError(err) });
      }
    };

    const handleLine = (line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;

      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (err) {
        finish({ ok: false, error: `invalid codex app-server response: ${safeError(err)}` });
        return;
      }

      if (message.id === 1 && message.result && !accountRequestSent) {
        accountRequestSent = true;
        send({ id: 2, method: 'account/rateLimits/read' });
        return;
      }

      if (message.id === 2) {
        if (message.error) {
          finish({
            ok: false,
            error: truncateError(message.error?.message || JSON.stringify(message.error)),
          });
          return;
        }
        finish({
          ok: true,
          account,
          ...message.result,
        });
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let nextNewline = stdoutBuffer.indexOf('\n');
      while (nextNewline >= 0) {
        const line = stdoutBuffer.slice(0, nextNewline);
        stdoutBuffer = stdoutBuffer.slice(nextNewline + 1);
        handleLine(line);
        nextNewline = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer = truncateError(`${stderrBuffer}${chunk}`, 1200);
    });

    child.on('error', (err) => {
      finish({ ok: false, error: safeError(err) });
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      const reason = stderrBuffer || `codex app-server exited before rate limits response (code=${code}, signal=${signal || 'none'})`;
      finish({ ok: false, error: truncateError(reason) });
    });

    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'agents-in-discord',
          title: 'Agents in Discord',
          version: '0.0.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    });
  });
}

export function createCachedProviderRateLimitReader({
  readRateLimits = async () => null,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();

  return async function readProviderRateLimitsWithCache(provider = 'codex') {
    const normalizedProvider = normalizeProvider(provider);
    let live;
    try {
      live = await readRateLimits(provider);
    } catch (err) {
      live = {
        ok: false,
        error: String(err?.message || err || 'unknown error'),
      };
    }

    if (live?.ok !== false && live) {
      cache.set(normalizedProvider, {
        cachedAt: now(),
        payload: cloneJsonLike(live),
      });
      return live;
    }

    const cached = cache.get(normalizedProvider);
    if (!cached?.payload) return live;

    return {
      ...cloneJsonLike(cached.payload),
      ok: true,
      stale: true,
      staleReason: String(live?.error || 'unknown error'),
      cachedAt: cached.cachedAt,
      cacheAgeMs: Math.max(0, now() - cached.cachedAt),
    };
  };
}
