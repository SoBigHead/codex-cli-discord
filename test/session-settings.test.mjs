import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSessionSettings,
  describeCompactStrategy,
  formatLanguageLabel,
  normalizeCompactStrategy,
  normalizeUiLanguage,
  parseCompactConfigAction,
  parseCompactConfigFromText,
  parseReasoningEffortInput,
  parseWorkspaceCommandAction,
} from '../src/session-settings.js';

test('session-settings normalizes ui language labels and fallbacks', () => {
  const settings = createSessionSettings({ defaultUiLanguage: 'en' });

  assert.equal(normalizeUiLanguage('中文'), 'zh');
  assert.equal(normalizeUiLanguage('EN-us'), 'en');
  assert.equal(settings.getSessionLanguage({ language: 'zh-cn' }), 'zh');
  assert.equal(settings.getSessionLanguage({}), 'en');
  assert.equal(formatLanguageLabel('en'), 'en (English)');
  assert.equal(formatLanguageLabel('zh'), 'zh (中文)');
});

test('session-settings resolves timeout security profile and compact values with overrides', () => {
  const settings = createSessionSettings({
    defaultUiLanguage: 'zh',
    securityProfile: 'team',
    codexTimeoutMs: 60_000,
    taskMaxAttempts: 3,
    taskRetryBaseDelayMs: 1000,
    taskRetryMaxDelayMs: 8000,
    compactStrategy: 'native',
    compactOnThreshold: false,
    maxInputTokensBeforeCompact: 250_000,
    modelAutoCompactTokenLimit: 320_000,
  });

  assert.deepEqual(settings.getEffectiveSecurityProfile({ securityProfile: 'public' }), {
    profile: 'public',
    source: 'session override',
  });
  assert.deepEqual(settings.getEffectiveSecurityProfile({}), {
    profile: 'team',
    source: 'env default',
  });
  assert.deepEqual(settings.resolveTimeoutSetting({ timeoutMs: '45000' }), {
    timeoutMs: 45_000,
    source: 'session override',
  });
  assert.deepEqual(settings.resolveTimeoutSetting({}), {
    timeoutMs: 60_000,
    source: 'env default',
  });
  assert.deepEqual(settings.resolveTaskRetrySetting({
    taskMaxAttempts: '4',
    taskRetryBaseDelayMs: '1500',
    taskRetryMaxDelayMs: '9000',
  }), {
    maxAttempts: 4,
    baseDelayMs: 1500,
    maxDelayMs: 9000,
    source: 'session override',
  });
  assert.deepEqual(settings.resolveTaskRetrySetting({}), {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    source: 'env default',
  });
  assert.deepEqual(settings.resolveCompactStrategySetting({ compactStrategy: 'hard' }), {
    strategy: 'hard',
    source: 'session override',
  });
  assert.deepEqual(settings.resolveCompactEnabledSetting({ compactEnabled: 'on' }), {
    enabled: true,
    source: 'session override',
  });
  assert.deepEqual(settings.resolveCompactThresholdSetting({ compactThresholdTokens: '123456' }), {
    tokens: 123_456,
    source: 'session override',
  });
  assert.deepEqual(settings.resolveNativeCompactTokenLimitSetting({ compactThresholdTokens: '200000' }), {
    tokens: 200_000,
    source: 'session threshold fallback',
  });
  assert.deepEqual(settings.resolveNativeCompactTokenLimitSetting({}), {
    tokens: 320_000,
    source: 'env default',
  });
});

test('session-settings parses compact, reasoning and workspace command inputs', () => {
  assert.deepEqual(parseCompactConfigAction('strategy', 'native'), {
    type: 'set_strategy',
    strategy: 'native',
  });
  assert.deepEqual(parseCompactConfigAction('enabled', 'off'), {
    type: 'set_enabled',
    enabled: false,
  });
  assert.deepEqual(parseCompactConfigFromText('token_limit 99999'), {
    type: 'set_threshold',
    tokens: 99_999,
  });
  assert.deepEqual(parseCompactConfigFromText('reset'), { type: 'reset' });
  assert.deepEqual(parseWorkspaceCommandAction('browse'), { type: 'browse' });
  assert.deepEqual(parseWorkspaceCommandAction('~/repo'), { type: 'set', value: '~/repo' });
  assert.equal(parseReasoningEffortInput('HIGH'), 'high');
  assert.equal(parseReasoningEffortInput('default', { allowDefault: true }), 'default');
  assert.equal(parseReasoningEffortInput('invalid'), null);
});

test('session-settings provides compact descriptions and provider defaults', () => {
  const warnings = [];
  const settings = createSessionSettings({
    readCodexDefaults: () => ({ model: 'gpt-5-codex', effort: 'high' }),
    normalizeProvider: (provider) => String(provider || '').trim().toLowerCase() || 'codex',
  });

  assert.equal(normalizeCompactStrategy('native'), 'native');
  assert.equal(normalizeCompactStrategy('weird', { logger: { warn: (line) => warnings.push(line) } }), 'hard');
  assert.match(warnings[0], /Unknown COMPACT_STRATEGY=weird/);
  assert.equal(describeCompactStrategy('native', 'zh'), 'native（Codex CLI 自动压缩并继续当前 session）');
  assert.deepEqual(settings.getProviderDefaults('codex'), {
    model: 'gpt-5-codex',
    effort: 'high',
    source: 'config.toml',
  });
  assert.deepEqual(settings.getProviderDefaults('gemini'), {
    model: '(provider default)',
    effort: '(provider default)',
    source: 'provider',
  });
});
