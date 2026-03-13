import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractInputTokensFromUsage,
  formatTokenValue,
  humanAge,
  humanElapsed,
  normalizeIntervalMs,
  safeError,
  toInt,
  toOptionalInt,
  truncate,
} from '../src/runtime-utils.js';

test('runtime-utils normalize integers and intervals', () => {
  assert.equal(toInt('12', 0), 12);
  assert.equal(toInt('x', 7), 7);
  assert.equal(toOptionalInt('12.9'), 12);
  assert.equal(toOptionalInt('x'), null);
  assert.equal(normalizeIntervalMs('2500', 1000, 500), 2500);
  assert.equal(normalizeIntervalMs('10', 1000, 500), 500);
  assert.equal(normalizeIntervalMs('off', 1000, 500), 1000);
});

test('runtime-utils format token and human times', () => {
  assert.equal(formatTokenValue(undefined), '(unknown)');
  assert.equal(formatTokenValue('42'), '42');
  assert.equal(humanAge(45_000), '45s');
  assert.equal(humanAge(3_600_000), '1h');
  assert.equal(humanElapsed(45_000), '45s');
  assert.equal(humanElapsed(125_000), '2m 5s');
});

test('runtime-utils truncate and safeError are stable', () => {
  assert.equal(truncate('abcdef', 4), 'a...');
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(safeError(new Error('boom')), 'boom');
  assert.equal(safeError('plain'), 'plain');
  assert.equal(safeError(null), 'unknown error');
});

test('runtime-utils extracts input tokens from direct and nested usage payloads', () => {
  assert.equal(extractInputTokensFromUsage({ input_tokens: 123 }), 123);
  assert.equal(extractInputTokensFromUsage({ nested: { prompt_token_count: 456 } }), 456);
  assert.equal(extractInputTokensFromUsage({ nested: { value: 'x' } }), null);
});
