import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendProviderSuffix,
  describeBotMode,
  getDefaultSlashPrefix,
  parseOptionalProvider,
  resolveDiscordToken,
  resolveProviderScopedEnv,
} from '../src/bot-instance-utils.js';

test('parseOptionalProvider accepts empty shared mode', () => {
  assert.equal(parseOptionalProvider(''), null);
  assert.equal(parseOptionalProvider(null), null);
  assert.equal(parseOptionalProvider('codex'), 'codex');
  assert.equal(parseOptionalProvider('anthropic'), 'claude');
  assert.equal(parseOptionalProvider('google'), 'antigravity');
  assert.equal(parseOptionalProvider('gemini'), 'antigravity');
  assert.equal(parseOptionalProvider('unknown'), null);
});

test('resolveProviderScopedEnv prefers provider-scoped key then fallback', () => {
  const env = {
    DISCORD_TOKEN: 'shared-token',
    CODEX__DISCORD_TOKEN: 'codex-prefixed-token',
    DISCORD_TOKEN_CODEX: 'codex-token',
    DISCORD_TOKEN_CLAUDE: 'claude-token',
    GEMINI__DISCORD_TOKEN: 'gemini-prefixed-token',
    DISCORD_TOKEN_GEMINI: 'gemini-token',
    ANTIGRAVITY__DISCORD_TOKEN: 'antigravity-prefixed-token',
    DISCORD_TOKEN_ANTIGRAVITY: 'antigravity-token',
  };

  assert.equal(resolveProviderScopedEnv('DISCORD_TOKEN', 'codex', env), 'codex-prefixed-token');
  assert.equal(resolveProviderScopedEnv('DISCORD_TOKEN', 'claude', env), 'claude-token');
  assert.equal(resolveProviderScopedEnv('DISCORD_TOKEN', 'antigravity', env), 'antigravity-prefixed-token');
  assert.equal(resolveProviderScopedEnv('DISCORD_TOKEN', 'gemini', { GEMINI__DISCORD_TOKEN: 'legacy-token' }), 'legacy-token');
  assert.equal(resolveProviderScopedEnv('DISCORD_TOKEN', null, env), 'shared-token');
  assert.equal(resolveProviderScopedEnv('DISCORD_TOKEN', 'unknown', env), 'shared-token');
});

test('resolveDiscordToken uses provider-specific token in locked mode', () => {
  const env = {
    DISCORD_TOKEN: 'shared-token',
    CLAUDE__DISCORD_TOKEN: 'claude-token',
  };

  assert.equal(resolveDiscordToken({ botProvider: 'claude', env }), 'claude-token');
  assert.equal(resolveDiscordToken({ botProvider: 'codex', env }), 'shared-token');
});

test('appendProviderSuffix namespaces state files', () => {
  assert.equal(appendProviderSuffix('sessions.json', 'claude'), 'sessions.claude.json');
  assert.equal(appendProviderSuffix('bot.lock', 'codex'), 'bot.codex.lock');
  assert.equal(appendProviderSuffix('sessions.json', null), 'sessions.json');
});

test('describeBotMode reflects shared and locked modes', () => {
  assert.equal(describeBotMode(null), 'shared');
  assert.equal(describeBotMode('codex'), 'locked:codex');
  assert.equal(describeBotMode('claude'), 'locked:claude');
  assert.equal(describeBotMode('gemini'), 'locked:antigravity');
  assert.equal(describeBotMode('antigravity'), 'locked:antigravity');
});

test('getDefaultSlashPrefix uses provider-aware defaults', () => {
  assert.equal(getDefaultSlashPrefix(null), 'cx');
  assert.equal(getDefaultSlashPrefix('codex'), 'cx');
  assert.equal(getDefaultSlashPrefix('claude'), 'cc');
  assert.equal(getDefaultSlashPrefix('anthropic'), 'cc');
  assert.equal(getDefaultSlashPrefix('antigravity'), 'ag');
  assert.equal(getDefaultSlashPrefix('gemini'), 'gm');
  assert.equal(getDefaultSlashPrefix('google'), 'ag');
});
