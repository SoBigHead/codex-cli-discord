import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

export function getCodexOpenAICuratedMarketplaceSource(homeDir = os.homedir()) {
  return process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE
    || path.join(homeDir, '.codex', '.tmp', 'plugins');
}

export function buildCodexOpenAICuratedMarketplaceArgs({
  homeDir = os.homedir(),
  exists = existsSync,
} = {}) {
  const source = getCodexOpenAICuratedMarketplaceSource(homeDir);
  if (!exists(source)) return [];
  return [
    '-c',
    'marketplaces.openai-curated.source_type="local"',
    '-c',
    `marketplaces.openai-curated.source=${tomlString(source)}`,
  ];
}

export function applyCodexOpenAICuratedMarketplaceConfig(config, {
  homeDir = os.homedir(),
  exists = existsSync,
} = {}) {
  const source = getCodexOpenAICuratedMarketplaceSource(homeDir);
  if (!exists(source)) return config;
  config.marketplaces = {
    ...(config.marketplaces || {}),
    'openai-curated': {
      ...((config.marketplaces || {})['openai-curated'] || {}),
      source_type: 'local',
      source,
    },
  };
  return config;
}
