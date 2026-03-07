import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSlashCommandName, slashName, slashRef } from '../src/slash-command-surface.js';

test('slashName applies prefix and truncates to Discord limit', () => {
  assert.equal(slashName('status', 'cx'), 'cx_status');
  assert.equal(slashName('a'.repeat(40), 'prefix').length, 32);
});

test('normalizeSlashCommandName strips configured prefix only', () => {
  assert.equal(normalizeSlashCommandName('cx_status', 'cx'), 'status');
  assert.equal(normalizeSlashCommandName('status', 'cx'), 'status');
  assert.equal(normalizeSlashCommandName('cc_status', 'cx'), 'cc_status');
});

test('slashRef renders clickable command reference', () => {
  assert.equal(slashRef('progress', 'cx'), '/cx_progress');
  assert.equal(slashRef('progress', ''), '/progress');
});
