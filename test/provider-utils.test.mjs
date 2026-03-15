import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunnerArgs,
  getProviderCompactCapabilities,
  getProviderDisplayName,
  getProviderShortName,
  normalizeCliProvider,
  providerSupportsCompactStrategy,
  providerSupportsRawConfigOverrides,
  providerSupportsConfigOverrides,
  providerSupportsNativeCompact,
} from '../src/provider-utils.js';

test('normalizeCliProvider falls back to codex', () => {
  assert.equal(normalizeCliProvider('claude'), 'claude');
  assert.equal(normalizeCliProvider('anthropic'), 'claude');
  assert.equal(normalizeCliProvider('gemini'), 'gemini');
  assert.equal(normalizeCliProvider('google'), 'gemini');
  assert.equal(normalizeCliProvider('CODEX'), 'codex');
  assert.equal(normalizeCliProvider('openai'), 'codex');
  assert.equal(normalizeCliProvider('unknown'), 'codex');
  assert.equal(normalizeCliProvider(''), 'codex');
});

test('provider labels are readable', () => {
  assert.equal(getProviderDisplayName('claude'), 'Claude Code');
  assert.equal(getProviderDisplayName('codex'), 'Codex CLI');
  assert.equal(getProviderDisplayName('gemini'), 'Gemini CLI');
  assert.equal(getProviderShortName('claude'), 'Claude');
  assert.equal(getProviderShortName('codex'), 'Codex');
  assert.equal(getProviderShortName('gemini'), 'Gemini');
});

test('provider capabilities distinguish shared native compact vs codex-only passthroughs', () => {
  assert.equal(providerSupportsRawConfigOverrides('codex'), true);
  assert.equal(providerSupportsRawConfigOverrides('claude'), false);
  assert.equal(providerSupportsConfigOverrides('codex'), true);
  assert.equal(providerSupportsConfigOverrides('claude'), false);
  assert.equal(providerSupportsConfigOverrides('gemini'), false);
  assert.equal(providerSupportsCompactStrategy('claude', 'hard'), true);
  assert.equal(providerSupportsCompactStrategy('claude', 'native'), true);
  assert.deepEqual(getProviderCompactCapabilities('gemini').strategies, ['hard', 'native', 'off']);
  assert.equal(providerSupportsNativeCompact('codex'), true);
  assert.equal(providerSupportsNativeCompact('claude'), true);
  assert.equal(providerSupportsNativeCompact('gemini'), true);
});

test('buildRunnerArgs keeps codex resume behavior', () => {
  const args = buildRunnerArgs({
    provider: 'codex',
    sessionId: 'abc-123',
    workspaceDir: '/tmp/work',
    prompt: 'fix it',
    mode: 'dangerous',
    model: 'o3',
    effort: 'high',
    extraConfigs: ['personality="concise"'],
    compactStrategy: 'native',
    compactOnThreshold: true,
    modelAutoCompactTokenLimit: 1234,
  });

  assert.deepEqual(args, [
    'exec',
    'resume',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m',
    'o3',
    '-c',
    'model_reasoning_effort="high"',
    '-c',
    'model_auto_compact_token_limit=1234',
    '-c',
    'personality="concise"',
    'abc-123',
    'fix it',
  ]);
});

test('buildRunnerArgs builds claude print stream command with prompt delimiter', () => {
  const args = buildRunnerArgs({
    provider: 'claude',
    sessionId: 'def-456',
    workspaceDir: '/tmp/work',
    prompt: 'run pwd',
    mode: 'safe',
    model: 'sonnet',
    effort: 'medium',
    extraConfigs: ['ignored=true'],
    compactStrategy: 'native',
    compactOnThreshold: true,
    modelAutoCompactTokenLimit: 999,
  });

  assert.deepEqual(args, [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'acceptEdits',
    '--model',
    'sonnet',
    '--effort',
    'medium',
    '--resume',
    'def-456',
    '--allowedTools',
    'default',
    '--',
    'run pwd',
  ]);
});

test('buildRunnerArgs builds gemini stream-json command with provider-specific permissions', () => {
  const args = buildRunnerArgs({
    provider: 'gemini',
    sessionId: 'ghi-789',
    workspaceDir: '/tmp/work',
    prompt: 'run pwd',
    mode: 'safe',
    model: 'gemini-2.5-pro',
    effort: 'medium',
    extraConfigs: ['ignored=true'],
    compactStrategy: 'native',
    compactOnThreshold: true,
    modelAutoCompactTokenLimit: 999,
  });

  assert.deepEqual(args, [
    '--output-format',
    'stream-json',
    '--sandbox',
    '--approval-mode',
    'default',
    '--model',
    'gemini-2.5-pro',
    '--resume',
    'ghi-789',
    '--prompt',
    'run pwd',
  ]);
});
