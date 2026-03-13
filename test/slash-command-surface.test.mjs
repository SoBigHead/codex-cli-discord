import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSlashCommands, normalizeSlashCommandName, slashName, slashRef } from '../src/slash-command-surface.js';

class MockSlashCommandBuilder {
  constructor() {
    this.data = { options: [] };
  }

  setName(name) {
    this.data.name = name;
    return this;
  }

  setDescription(description) {
    this.data.description = description;
    return this;
  }

  addStringOption(configure) {
    const option = new MockSlashOptionBuilder();
    configure(option);
    this.data.options.push(option.data);
    return this;
  }

  toJSON() {
    return this.data;
  }
}

class MockSlashOptionBuilder {
  constructor() {
    this.data = { choices: [] };
  }

  setName(name) {
    this.data.name = name;
    return this;
  }

  setDescription(description) {
    this.data.description = description;
    return this;
  }

  setRequired(required) {
    this.data.required = required;
    return this;
  }

  addChoices(...choices) {
    this.data.choices.push(...choices);
    return this;
  }
}

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

test('buildSlashCommands includes workspace commands and aliases', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'cx',
    botProvider: null,
  }).map((command) => command.toJSON());

  const names = commands.map((command) => command.name);
  assert.ok(names.includes('cx_setdir'));
  assert.ok(names.includes('cx_setdefaultdir'));
  assert.ok(names.includes('cx_new'));
  assert.ok(names.includes('cx_abort'));
  assert.ok(names.includes('cx_onboarding_config'));
  assert.ok(!names.includes('cx_retry'));
  assert.ok(!names.includes('cx_process_lines'));
});

test('buildSlashCommands exposes browse keyword in workspace option descriptions', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'cx',
    botProvider: null,
  }).map((command) => command.toJSON());

  const setdir = commands.find((command) => command.name === 'cx_setdir');
  const setdefaultdir = commands.find((command) => command.name === 'cx_setdefaultdir');

  assert.match(setdir.options[0].description, /browse/);
  assert.match(setdefaultdir.options[0].description, /browse/);
});
