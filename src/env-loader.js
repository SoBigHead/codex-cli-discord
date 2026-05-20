import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

import { parseOptionalProvider } from './bot-instance-utils.js';

export function loadRuntimeEnv({ rootDir, env = process.env } = {}) {
  const resolvedRoot = path.resolve(String(rootDir || process.cwd()));
  const immutableKeys = new Set(Object.keys(env));
  const loadedKeys = new Set();
  const loadedFiles = [];

  const baseFile = path.join(resolvedRoot, '.env');
  loadEnvFile(baseFile, { env, immutableKeys, loadedKeys, loadedFiles });

  const explicitFiles = parseExplicitEnvFiles(env.ENV_FILE, resolvedRoot);
  if (explicitFiles.length) {
    for (const filePath of explicitFiles) {
      loadEnvFile(filePath, { env, immutableKeys, loadedKeys, loadedFiles });
    }
  }

  const appliedProviderScope = parseOptionalProvider(env.BOT_PROVIDER);
  const appliedScopedKeys = appliedProviderScope
    ? applyProviderScopedEnv(appliedProviderScope, { env, immutableKeys, loadedKeys })
    : [];

  if (!env.BOT_PROVIDER) {
    const inferredProvider = inferProviderFromFiles(loadedFiles);
    if (inferredProvider) {
      env.BOT_PROVIDER = inferredProvider;
    }
  }

  return {
    appliedProviderScope,
    appliedScopedKeys,
    loadedFiles,
    writableEnvFile: loadedFiles.at(-1) || baseFile,
  };
}

function applyProviderScopedEnv(provider, { env, immutableKeys, loadedKeys }) {
  const prefixes = provider === 'antigravity'
    ? ['GEMINI__', 'ANTIGRAVITY__']
    : [`${provider.toUpperCase()}__`];
  const appliedKeys = [];
  const entries = Object.entries({ ...env });

  for (const prefix of prefixes) {
    for (const [key, value] of entries) {
      if (!key.startsWith(prefix)) continue;

      const targetKey = key.slice(prefix.length).trim();
      if (!targetKey) continue;
      if (immutableKeys.has(targetKey) && !loadedKeys.has(targetKey)) continue;

      env[targetKey] = value;
      loadedKeys.add(targetKey);
      appliedKeys.push(targetKey);
    }
  }

  return appliedKeys;
}

function loadEnvFile(filePath, { env, immutableKeys, loadedKeys, loadedFiles }) {
  const resolvedPath = path.resolve(filePath);
  if (loadedFiles.includes(resolvedPath)) return false;
  if (!fs.existsSync(resolvedPath)) return false;

  const parsed = dotenv.parse(fs.readFileSync(resolvedPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (immutableKeys.has(key) && !loadedKeys.has(key)) continue;
    env[key] = value;
    loadedKeys.add(key);
  }

  loadedFiles.push(resolvedPath);
  return true;
}

function parseExplicitEnvFiles(value, rootDir) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (path.isAbsolute(item) ? item : path.join(rootDir, item)));
}

function inferProviderFromFiles(files) {
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const provider = parseOptionalProvider(path.basename(files[index]).replace(/^\.env\./, ''));
    if (provider) return provider;
  }
  return null;
}
