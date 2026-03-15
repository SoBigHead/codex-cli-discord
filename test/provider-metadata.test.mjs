import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCompactConfigUnsupported,
  formatReasoningEffortUnsupported,
  formatWorkspaceSessionPolicy,
  getProviderBinEnvName,
  getProviderCompactCapabilities,
  getProviderDefaultBin,
  getProviderDefaultSlashPrefix,
  getProviderDisplayName,
  getProviderShortName,
  getSupportedCompactStrategies,
  isReasoningEffortSupported,
  normalizeProvider,
  parseOptionalProvider,
  parseProviderInput,
  providerBindsSessionsToWorkspace,
  providerSupportsCompactConfigAction,
} from '../src/provider-metadata.js';

test('provider-metadata normalizes aliases and optional parsing consistently', () => {
  assert.equal(normalizeProvider('openai'), 'codex');
  assert.equal(normalizeProvider('anthropic'), 'claude');
  assert.equal(normalizeProvider('google'), 'gemini');
  assert.equal(parseOptionalProvider('google'), 'gemini');
  assert.equal(parseOptionalProvider(''), null);
  assert.equal(parseProviderInput('anthropic'), 'claude');
  assert.equal(parseProviderInput('unknown'), null);
});

test('provider-metadata exposes provider labels, bins, and slash prefixes', () => {
  assert.equal(getProviderDisplayName('codex'), 'Codex CLI');
  assert.equal(getProviderDisplayName('claude'), 'Claude Code');
  assert.equal(getProviderDisplayName('gemini'), 'Gemini CLI');
  assert.equal(getProviderShortName('gemini'), 'Gemini');
  assert.equal(getProviderDefaultBin('claude'), 'claude');
  assert.equal(getProviderDefaultBin('gemini'), 'gemini');
  assert.equal(getProviderBinEnvName('codex'), 'CODEX_BIN');
  assert.equal(getProviderBinEnvName('gemini'), 'GEMINI_BIN');
  assert.equal(getProviderDefaultSlashPrefix('codex'), 'cx');
  assert.equal(getProviderDefaultSlashPrefix('claude'), 'cc');
  assert.equal(getProviderDefaultSlashPrefix('gemini'), 'gm');
});

test('provider-metadata exposes workspace, compact, and reasoning capabilities', () => {
  assert.equal(providerBindsSessionsToWorkspace('codex'), true);
  assert.equal(providerBindsSessionsToWorkspace('claude'), false);
  assert.equal(providerBindsSessionsToWorkspace('gemini'), true);
  assert.deepEqual(getSupportedCompactStrategies('codex'), ['hard', 'native', 'off']);
  assert.deepEqual(getSupportedCompactStrategies('claude'), ['hard', 'native', 'off']);
  assert.equal(getProviderCompactCapabilities('gemini').supportsNativeLimit, false);
  assert.equal(providerSupportsCompactConfigAction('claude', { type: 'set_strategy', strategy: 'native' }), true);
  assert.equal(providerSupportsCompactConfigAction('gemini', { type: 'set_native_limit', tokens: 123 }), false);
  assert.equal(providerSupportsCompactConfigAction('gemini', { type: 'set_threshold', tokens: 123 }), true);
  assert.equal(isReasoningEffortSupported('codex', 'xhigh'), true);
  assert.equal(isReasoningEffortSupported('claude', 'xhigh'), false);
  assert.equal(isReasoningEffortSupported('gemini', 'medium'), false);
});

test('provider-metadata formats provider-aware help', () => {
  assert.match(formatReasoningEffortUnsupported('gemini', 'en'), /Gemini CLI/);
  assert.match(formatReasoningEffortUnsupported('claude', 'zh'), /`low`、`medium`、`high`/);
  assert.match(formatCompactConfigUnsupported('gemini', { type: 'set_native_limit' }, 'en'), /native_limit/);
  assert.match(formatWorkspaceSessionPolicy('claude', 'en'), /portable/);
});
