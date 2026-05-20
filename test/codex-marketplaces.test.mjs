import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCodexOpenAICuratedMarketplaceConfig,
  buildCodexOpenAICuratedMarketplaceArgs,
  getCodexOpenAICuratedMarketplaceSource,
} from '../src/codex-marketplaces.js';

test('buildCodexOpenAICuratedMarketplaceArgs pins openai-curated to an existing local cache', () => {
  const previous = process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
  delete process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
  try {
    assert.deepEqual(buildCodexOpenAICuratedMarketplaceArgs({
      homeDir: '/Users/example',
      exists: (candidate) => candidate === '/Users/example/.codex/.tmp/plugins',
    }), [
      '-c',
      'marketplaces.openai-curated.source_type="local"',
      '-c',
      'marketplaces.openai-curated.source="/Users/example/.codex/.tmp/plugins"',
    ]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
    else process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE = previous;
  }
});

test('buildCodexOpenAICuratedMarketplaceArgs does not pass a broken local cache path', () => {
  const previous = process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
  process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE = '/missing/cache';
  try {
    assert.deepEqual(buildCodexOpenAICuratedMarketplaceArgs({
      exists: () => false,
    }), []);
  } finally {
    if (previous === undefined) delete process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
    else process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE = previous;
  }
});

test('getCodexOpenAICuratedMarketplaceSource honors explicit override', () => {
  const previous = process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
  process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE = '/cache/override';
  try {
    assert.equal(getCodexOpenAICuratedMarketplaceSource('/Users/example'), '/cache/override');
  } finally {
    if (previous === undefined) delete process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
    else process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE = previous;
  }
});

test('applyCodexOpenAICuratedMarketplaceConfig preserves existing config and writes local marketplace', () => {
  const previous = process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
  delete process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
  try {
    const config = {
      features: { fast_mode: false },
      marketplaces: {
        'openai-bundled': { source_type: 'local', source: '/bundled' },
      },
    };
    assert.equal(applyCodexOpenAICuratedMarketplaceConfig(config, {
      homeDir: '/Users/example',
      exists: () => true,
    }), config);
    assert.deepEqual(config, {
      features: { fast_mode: false },
      marketplaces: {
        'openai-bundled': { source_type: 'local', source: '/bundled' },
        'openai-curated': {
          source_type: 'local',
          source: '/Users/example/.codex/.tmp/plugins',
        },
      },
    });
  } finally {
    if (previous === undefined) delete process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
    else process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE = previous;
  }
});
