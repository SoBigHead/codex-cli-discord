import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { autoRepairProxyEnv } from './proxy-env.js';

const FEATURES_SECTION = 'features';
const CODEX_MODEL_CATALOG_CACHE = new Map();
const CLAUDE_MODEL_CATALOG_CACHE = new Map();
const ANTIGRAVITY_MODEL_CATALOG_CACHE = new Map();
const ANTIGRAVITY_DOCUMENTED_MODELS = Object.freeze([
  'Gemini 3.5 Flash',
  'Gemini 3.1 Pro (High)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3 Flash',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS-120B',
]);

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveCodexHome(env = process.env) {
  return env.HOME || env.USERPROFILE || '';
}

export function resolveCodexConfigPath({ env = process.env } = {}) {
  return path.join(resolveCodexHome(env), '.codex', 'config.toml');
}

export function resolveAntigravitySettingsPath({ env = process.env } = {}) {
  return path.join(resolveCodexHome(env), '.gemini', 'antigravity-cli', 'settings.json');
}

function resolveAntigravityLogDir({ env = process.env } = {}) {
  return path.join(resolveCodexHome(env), '.gemini', 'antigravity-cli', 'log');
}

function quoteTomlString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalizeOptionalTomlString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeOptionalJsonString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function readJsonObjectFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
}

function normalizeTomlLines(lines) {
  const normalized = [];
  let previousBlank = true;
  for (const line of lines) {
    const current = String(line ?? '');
    const isBlank = current.trim() === '';
    if (isBlank && previousBlank) continue;
    normalized.push(isBlank ? '' : current);
    previousBlank = isBlank;
  }
  while (normalized.length > 0 && normalized[0] === '') normalized.shift();
  while (normalized.length > 0 && normalized[normalized.length - 1] === '') normalized.pop();
  return normalized;
}

function setTopLevelTomlKey(raw, key, renderedLine) {
  const lines = String(raw || '').split(/\r?\n/);
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*=`);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  const searchEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  const matchedIndexes = [];

  for (let index = 0; index < searchEnd; index += 1) {
    if (keyPattern.test(lines[index].trim())) {
      matchedIndexes.push(index);
    }
  }

  if (!renderedLine) {
    for (let index = matchedIndexes.length - 1; index >= 0; index -= 1) {
      lines.splice(matchedIndexes[index], 1);
    }
    return normalizeTomlLines(lines).join('\n');
  }

  if (matchedIndexes.length > 0) {
    lines[matchedIndexes[0]] = renderedLine;
    for (let index = matchedIndexes.length - 1; index >= 1; index -= 1) {
      lines.splice(matchedIndexes[index], 1);
    }
    return normalizeTomlLines(lines).join('\n');
  }

  const insertAt = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  lines.splice(insertAt, 0, renderedLine);
  return normalizeTomlLines(lines).join('\n');
}

function setSectionTomlKey(raw, section, key, renderedLine) {
  const lines = String(raw || '').split(/\r?\n/);
  const sectionHeader = `[${section}]`;
  const sectionIndex = lines.findIndex((line) => line.trim() === sectionHeader);

  if (sectionIndex === -1) {
    if (!renderedLine) return normalizeTomlLines(lines).join('\n');
    if (lines.length > 0 && lines.at(-1).trim() !== '') lines.push('');
    lines.push(sectionHeader, renderedLine);
    return normalizeTomlLines(lines).join('\n');
  }

  let sectionEnd = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*=`);
  const matchedIndexes = [];
  for (let index = sectionIndex + 1; index < sectionEnd; index += 1) {
    if (keyPattern.test(lines[index].trim())) {
      matchedIndexes.push(index);
    }
  }

  if (!renderedLine) {
    for (let index = matchedIndexes.length - 1; index >= 0; index -= 1) {
      lines.splice(matchedIndexes[index], 1);
    }
    return normalizeTomlLines(lines).join('\n');
  }

  if (matchedIndexes.length > 0) {
    lines[matchedIndexes[0]] = renderedLine;
    for (let index = matchedIndexes.length - 1; index >= 1; index -= 1) {
      lines.splice(matchedIndexes[index], 1);
    }
    return normalizeTomlLines(lines).join('\n');
  }

  lines.splice(sectionEnd, 0, renderedLine);
  return normalizeTomlLines(lines).join('\n');
}

export function readCodexDefaults({ env = process.env } = {}) {
  try {
    const configPath = resolveCodexConfigPath({ env });
    const raw = fs.readFileSync(configPath, 'utf-8');
    const modelMatch = raw.match(/^model\s*=\s*"([^"]+)"/m);
    const effortMatch = raw.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
    const fastModeMatch = raw.match(/^\s*fast_mode\s*=\s*(true|false)\s*$/m);
    return {
      model: modelMatch?.[1] || null,
      modelConfigured: Boolean(modelMatch),
      effort: effortMatch?.[1] || null,
      effortConfigured: Boolean(effortMatch),
      fastMode: fastModeMatch ? fastModeMatch[1] === 'true' : true,
      fastModeConfigured: Boolean(fastModeMatch),
    };
  } catch {
    return {
      model: null,
      modelConfigured: false,
      effort: null,
      effortConfigured: false,
      fastMode: true,
      fastModeConfigured: false,
    };
  }
}

export function readCodexProfileCatalog({ env = process.env } = {}) {
  try {
    const configPath = resolveCodexConfigPath({ env });
    const raw = fs.readFileSync(configPath, 'utf-8');
    const profileNames = [];
    const seen = new Set();
    const profileHeaderPattern = /^\s*\[profiles\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm;
    let match = profileHeaderPattern.exec(raw);
    while (match) {
      const name = String(match[1] || match[2] || '').trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        profileNames.push(name);
      }
      match = profileHeaderPattern.exec(raw);
    }
    return {
      profiles: profileNames,
      configPath,
    };
  } catch {
    return {
      profiles: [],
      configPath: resolveCodexConfigPath({ env }),
    };
  }
}

export function readAntigravityDefaults({ env = process.env } = {}) {
  const settingsPath = resolveAntigravitySettingsPath({ env });
  try {
    const settings = readJsonObjectFile(settingsPath);
    const model = normalizeOptionalJsonString(settings.model);
    return {
      model,
      modelConfigured: Boolean(model),
      profile: null,
      profileConfigured: false,
      effort: null,
      effortConfigured: false,
      fastMode: false,
      fastModeConfigured: false,
      source: 'settings.json',
      settingsPath,
      error: null,
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        model: null,
        modelConfigured: false,
        profile: null,
        profileConfigured: false,
        effort: null,
        effortConfigured: false,
        fastMode: false,
        fastModeConfigured: false,
        source: 'provider',
        settingsPath,
        error: null,
      };
    }
    return {
      model: null,
      modelConfigured: false,
      profile: null,
      profileConfigured: false,
      effort: null,
      effortConfigured: false,
      fastMode: false,
      fastModeConfigured: false,
      source: 'settings.json',
      settingsPath,
      error: String(err?.message || err || 'unknown error'),
    };
  }
}

function normalizeCodexModelCatalog(raw) {
  const parsed = JSON.parse(String(raw || ''));
  const models = Array.isArray(parsed?.models) ? parsed.models : [];
  return {
    models: models.map((model) => {
      const slug = String(model?.slug || '').trim();
      const displayName = String(model?.display_name || model?.displayName || slug).trim();
      const supportedReasoningLevels = Array.isArray(model?.supported_reasoning_levels)
        ? model.supported_reasoning_levels
          .map((level) => String(level?.effort || '').trim())
          .filter(Boolean)
        : [];
      return {
        slug,
        displayName: displayName || slug,
        description: String(model?.description || '').trim(),
        defaultReasoningLevel: String(model?.default_reasoning_level || '').trim() || null,
        supportedReasoningLevels,
        visibility: String(model?.visibility || '').trim(),
      };
    }).filter((model) => model.slug),
    error: null,
  };
}

function extractClaudeEffortLevels(raw) {
  const help = String(raw || '');
  const effortLine = help.split(/\r?\n/).find((line) => /--effort\b/.test(line)) || '';
  const parenMatch = effortLine.match(/\(([^)]+)\)/);
  const source = parenMatch?.[1] || '';
  const seen = new Set();
  return source
    .split(/[,/|]/)
    .map((level) => String(level || '').trim().toLowerCase())
    .filter((level) => {
      if (!level || seen.has(level)) return false;
      seen.add(level);
      return true;
    });
}

function normalizeClaudeModelCatalog(raw) {
  const help = String(raw || '');
  const modelHelp = help.split(/\r?\n/)
    .filter((line) => /--model\b|model/i.test(line))
    .join('\n');
  const quoted = [];
  const seen = new Set();
  const modelPattern = /\bclaude-(?:sonnet|opus|haiku)-[a-z0-9-]+|\b(?:sonnet|opus|haiku)\b/gi;
  let match = modelPattern.exec(modelHelp);
  while (match) {
    const value = String(match[0] || '').trim();
    const normalized = value.toLowerCase();
    if (value && !seen.has(normalized)) {
      seen.add(normalized);
      quoted.push(value);
    }
    match = modelPattern.exec(modelHelp);
  }

  const supportedReasoningLevels = extractClaudeEffortLevels(help);
  return {
    models: quoted.map((slug) => ({
      slug,
      displayName: slug,
      description: ['sonnet', 'opus', 'haiku'].includes(slug.toLowerCase())
        ? 'Claude Code model alias from CLI help'
        : 'Claude Code full model name from CLI help',
      defaultReasoningLevel: null,
      supportedReasoningLevels,
      visibility: 'help',
    })),
    error: null,
  };
}

function listRecentAntigravityLogFiles(logDir, limit = 12) {
  try {
    return fs.readdirSync(logDir)
      .filter((name) => /\.log$/i.test(name))
      .map((name) => {
        const file = path.join(logDir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { file, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((entry) => entry.file);
  } catch {
    return [];
  }
}

function collectAntigravityLogModels({ env = process.env, maxFiles = 12 } = {}) {
  const logDir = resolveAntigravityLogDir({ env });
  const models = [];
  const seen = new Set();
  const addModel = (value) => {
    const model = normalizeOptionalJsonString(value);
    if (!model) return;
    const key = model.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    models.push(model);
  };
  const selectedPattern = /selected model override to backend:\s*label="([^"]+)"/gi;
  const resolvingPattern = /Resolving model\s+([^\r\n]+)/gi;

  for (const file of listRecentAntigravityLogFiles(logDir, maxFiles)) {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    let match = selectedPattern.exec(raw);
    while (match) {
      addModel(match[1]);
      match = selectedPattern.exec(raw);
    }
    match = resolvingPattern.exec(raw);
    while (match) {
      addModel(match[1]);
      match = resolvingPattern.exec(raw);
    }
  }

  return models;
}

export function readAntigravityModelCatalog({
  env = process.env,
  now = Date.now,
  ttlMs = 5 * 60_000,
  maxLogFiles = 12,
} = {}) {
  const settingsPath = resolveAntigravitySettingsPath({ env });
  const cacheKey = `${settingsPath}:${maxLogFiles}`;
  const cached = ANTIGRAVITY_MODEL_CATALOG_CACHE.get(cacheKey);
  const currentTime = typeof now === 'function' ? now() : Date.now();
  if (cached && currentTime - cached.timestamp < ttlMs) {
    return cached.catalog;
  }

  const defaults = readAntigravityDefaults({ env });
  const models = [];
  const seen = new Set();
  const addModel = (slug, description, visibility) => {
    const value = normalizeOptionalJsonString(slug);
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    models.push({
      slug: value,
      displayName: value,
      description,
      defaultReasoningLevel: null,
      supportedReasoningLevels: [],
      visibility,
    });
  };

  addModel(defaults.model, 'Antigravity configured model from settings.json', 'settings');
  for (const model of ANTIGRAVITY_DOCUMENTED_MODELS) {
    addModel(model, 'Antigravity documented reasoning model', 'documented');
  }
  for (const model of collectAntigravityLogModels({ env, maxFiles: maxLogFiles })) {
    addModel(model, 'Antigravity model observed in local CLI logs', 'logs');
  }

  const catalog = {
    models,
    error: defaults.error,
  };
  ANTIGRAVITY_MODEL_CATALOG_CACHE.set(cacheKey, { timestamp: currentTime, catalog });
  return catalog;
}

export function readCodexModelCatalog({
  codexBin = 'codex',
  env = process.env,
  execFileSyncFn = execFileSync,
  now = Date.now,
  ttlMs = 5 * 60_000,
} = {}) {
  const bin = String(codexBin || 'codex').trim() || 'codex';
  const cacheKey = bin;
  const cached = CODEX_MODEL_CATALOG_CACHE.get(cacheKey);
  const currentTime = typeof now === 'function' ? now() : Date.now();
  if (cached && currentTime - cached.timestamp < ttlMs) {
    return cached.catalog;
  }

  try {
    const raw = execFileSyncFn(bin, ['debug', 'models'], {
      encoding: 'utf-8',
      env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
    const catalog = normalizeCodexModelCatalog(raw);
    CODEX_MODEL_CATALOG_CACHE.set(cacheKey, { timestamp: currentTime, catalog });
    return catalog;
  } catch (err) {
    const message = String(err?.message || err || 'unknown error').trim();
    const catalog = {
      models: [],
      error: message || 'unknown error',
    };
    CODEX_MODEL_CATALOG_CACHE.set(cacheKey, { timestamp: currentTime, catalog });
    return catalog;
  }
}

export function readClaudeModelCatalog({
  claudeBin = 'claude',
  env = process.env,
  execFileSyncFn = execFileSync,
  now = Date.now,
  ttlMs = 5 * 60_000,
} = {}) {
  const bin = String(claudeBin || 'claude').trim() || 'claude';
  const cacheKey = bin;
  const cached = CLAUDE_MODEL_CATALOG_CACHE.get(cacheKey);
  const currentTime = typeof now === 'function' ? now() : Date.now();
  if (cached && currentTime - cached.timestamp < ttlMs) {
    return cached.catalog;
  }

  try {
    const raw = execFileSyncFn(bin, ['--help'], {
      encoding: 'utf-8',
      env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5000,
    });
    const catalog = normalizeClaudeModelCatalog(raw);
    CLAUDE_MODEL_CATALOG_CACHE.set(cacheKey, { timestamp: currentTime, catalog });
    return catalog;
  } catch (err) {
    const message = String(err?.message || err || 'unknown error').trim();
    const catalog = {
      models: [],
      error: message || 'unknown error',
    };
    CLAUDE_MODEL_CATALOG_CACHE.set(cacheKey, { timestamp: currentTime, catalog });
    return catalog;
  }
}

export function readProviderModelCatalog({
  provider = 'codex',
  codexBin = 'codex',
  claudeBin = 'claude',
  env = process.env,
  execFileSyncFn = execFileSync,
  now = Date.now,
  ttlMs = 5 * 60_000,
} = {}) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'codex') {
    return readCodexModelCatalog({ codexBin, env, execFileSyncFn, now, ttlMs });
  }
  if (normalized === 'claude') {
    return readClaudeModelCatalog({ claudeBin, env, execFileSyncFn, now, ttlMs });
  }
  if (normalized === 'gemini' || normalized === 'agy' || normalized === 'antigravity') {
    return readAntigravityModelCatalog({ env, now, ttlMs });
  }
  return { models: [], error: null };
}

export function writeCodexDefaults({
  env = process.env,
  model = undefined,
  effort = undefined,
  fastMode = undefined,
} = {}) {
  const configPath = resolveCodexConfigPath({ env });
  const configDir = path.dirname(configPath);
  let raw = '';

  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    raw = '';
  }

  if (model !== undefined) {
    const normalizedModel = normalizeOptionalTomlString(model);
    raw = setTopLevelTomlKey(
      raw,
      'model',
      normalizedModel === null ? null : `model = ${quoteTomlString(normalizedModel)}`,
    );
  }

  if (effort !== undefined) {
    const normalizedEffort = normalizeOptionalTomlString(effort);
    raw = setTopLevelTomlKey(
      raw,
      'model_reasoning_effort',
      normalizedEffort === null ? null : `model_reasoning_effort = ${quoteTomlString(normalizedEffort)}`,
    );
  }

  if (fastMode !== undefined) {
    raw = setSectionTomlKey(
      raw,
      FEATURES_SECTION,
      'fast_mode',
      fastMode === null ? null : `fast_mode = ${fastMode ? 'true' : 'false'}`,
    );
  }

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, raw ? `${raw}\n` : '', 'utf-8');
  return readCodexDefaults({ env });
}

export function writeAntigravityModelSetting({
  env = process.env,
  model = undefined,
} = {}) {
  if (model === undefined) {
    return readAntigravityDefaults({ env });
  }

  const settingsPath = resolveAntigravitySettingsPath({ env });
  const settingsDir = path.dirname(settingsPath);
  let settings = {};
  try {
    settings = readJsonObjectFile(settingsPath);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
    settings = {};
  }

  const normalizedModel = normalizeOptionalJsonString(model);
  if (normalizedModel === null) {
    delete settings.model;
  } else {
    settings.model = normalizedModel;
  }

  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  ANTIGRAVITY_MODEL_CATALOG_CACHE.clear();
  return readAntigravityDefaults({ env });
}

export function normalizeSlashPrefix(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');
  if (!raw) return '';
  return raw.slice(0, 12);
}

export function renderMissingDiscordTokenHint({ botProvider = null, env = process.env } = {}) {
  if (botProvider) {
    const providerKey = String(botProvider || '').trim().toUpperCase();
    const legacy = providerKey === 'ANTIGRAVITY' ? ' or DISCORD_TOKEN_GEMINI' : '';
    return `Missing Discord token in environment (${`DISCORD_TOKEN_${providerKey}`}${legacy} or DISCORD_TOKEN)`;
  }

  const hasCodexScopedToken = Boolean(String(env.CODEX__DISCORD_TOKEN || env.DISCORD_TOKEN_CODEX || '').trim());
  const hasClaudeScopedToken = Boolean(String(env.CLAUDE__DISCORD_TOKEN || env.DISCORD_TOKEN_CLAUDE || '').trim());
  const hasAntigravityScopedToken = Boolean(String(env.ANTIGRAVITY__DISCORD_TOKEN || env.DISCORD_TOKEN_ANTIGRAVITY || env.GEMINI__DISCORD_TOKEN || env.DISCORD_TOKEN_GEMINI || '').trim());

  if (hasCodexScopedToken || hasClaudeScopedToken || hasAntigravityScopedToken) {
    const availableProviders = [
      hasCodexScopedToken ? 'codex' : null,
      hasClaudeScopedToken ? 'claude' : null,
      hasAntigravityScopedToken ? 'antigravity' : null,
    ].filter(Boolean).join(', ');
    return `Missing DISCORD_TOKEN in shared mode. Found provider-scoped tokens for: ${availableProviders}. Start with npm run start:codex / npm run start:claude / npm run start:antigravity, or add a shared DISCORD_TOKEN.`;
  }

  return 'Missing DISCORD_TOKEN in environment';
}

export function configureRuntimeProxy({
  env = process.env,
  envFilePath = null,
  autoRepairProxyEnvFn = autoRepairProxyEnv,
  createHttpProxyAgent = (uri) => new ProxyAgent({ uri }),
  createSocksProxyAgent = (uri) => new SocksProxyAgent(uri),
  setGlobalDispatcherFn = setGlobalDispatcher,
  globalTarget = globalThis,
} = {}) {
  const logs = [];
  const proxyRepair = autoRepairProxyEnvFn(envFilePath, { env });
  if (Array.isArray(proxyRepair?.logs) && proxyRepair.logs.length) {
    logs.push(...proxyRepair.logs);
  }

  const httpProxy = String(env.HTTP_PROXY || '').trim() || null;
  const socksProxy = String(env.SOCKS_PROXY || '').trim() || null;
  const insecureTls = String(env.INSECURE_TLS || '0') === '1';
  let restProxyAgent = null;
  let wsProxyAgent = null;

  if (httpProxy) {
    if (insecureTls) env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    restProxyAgent = createHttpProxyAgent(httpProxy);
    setGlobalDispatcherFn(restProxyAgent);
  }

  if (socksProxy) {
    wsProxyAgent = createSocksProxyAgent(socksProxy);
    globalTarget.__discordWsAgent = wsProxyAgent;
  }

  if (httpProxy || socksProxy) {
    logs.push(`🌐 Proxy: REST=${httpProxy || '(none)'} | WS=${socksProxy || '(none)'} | INSECURE_TLS=${insecureTls}`);
  }

  return {
    httpProxy,
    insecureTls,
    logs,
    proxyRepair,
    restProxyAgent,
    socksProxy,
    wsProxyAgent,
  };
}

export function createDiscordClient({
  Client,
  GatewayIntentBits,
  Partials,
  restProxyAgent = null,
} = {}) {
  const bot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  if (restProxyAgent) {
    bot.rest.setAgent(restProxyAgent);
  }

  return bot;
}
