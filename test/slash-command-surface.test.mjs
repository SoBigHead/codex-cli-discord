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

  addSubcommand(configure) {
    const option = new MockSlashSubcommandBuilder();
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

class MockSlashSubcommandBuilder extends MockSlashOptionBuilder {
  constructor() {
    super();
    this.data.type = 'subcommand';
    this.data.options = [];
  }

  addStringOption(configure) {
    const option = new MockSlashOptionBuilder();
    configure(option);
    this.data.options.push(option.data);
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
  assert.ok(names.includes('cx_fork'));
  assert.ok(names.includes('cx_goal'));
  assert.ok(names.includes('cx_settings'));
  assert.ok(names.includes('cx_abort'));
  assert.ok(names.includes('cx_project_sessions'));
  assert.ok(names.includes('cx_chat_resume'));
  assert.ok(names.includes('cx_onboarding_config'));
  assert.ok(!names.includes('cx_retry'));
  assert.ok(!names.includes('cx_process_lines'));

  const goal = commands.find((command) => command.name === 'cx_goal');
  const goalSet = goal.options.find((option) => option.name === 'set');
  const goalPause = goal.options.find((option) => option.name === 'pause');
  assert.ok(goalSet);
  assert.equal(goalSet.options.find((option) => option.name === 'objective').required, true);
  assert.equal(goalPause.options?.length, 0);
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

test('buildSlashCommands exposes gemini as provider choice', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'cx',
    botProvider: null,
  }).map((command) => command.toJSON());

  const provider = commands.find((command) => command.name === 'cx_provider');
  const choices = provider.options[0].choices.map((choice) => choice.value);

  assert.deepEqual(choices, ['codex', 'claude', 'gemini', 'status']);
});

test('buildSlashCommands lets model open panel or set effort', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'cx',
    botProvider: 'codex',
  }).map((command) => command.toJSON());

  const model = commands.find((command) => command.name === 'cx_model');
  assert.equal(model.options[0].name, 'name');
  assert.equal(model.options[0].required, false);
  assert.equal(model.options[1].name, 'effort');
  assert.equal(model.options[1].required, false);
  assert.deepEqual(model.options[1].choices.map((choice) => choice.value), ['xhigh', 'high', 'medium', 'low', 'default']);
});

test('buildSlashCommands gives provider-native alias descriptions to session aliases', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'cx',
    botProvider: null,
  }).map((command) => command.toJSON());

  const projectSessions = commands.find((command) => command.name === 'cx_project_sessions');
  const chatResume = commands.find((command) => command.name === 'cx_chat_resume');

  assert.match(projectSessions.description, /project sessions/);
  assert.match(chatResume.description, /chat session/);
});

test('buildSlashCommands narrows locked-provider surfaces to native aliases and supported knobs', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'gm',
    botProvider: 'gemini',
  }).map((command) => command.toJSON());

  const names = commands.map((command) => command.name);
  const compact = commands.find((command) => command.name === 'gm_compact');
  const sessions = commands.find((command) => command.name === 'gm_sessions');
  const resume = commands.find((command) => command.name === 'gm_resume');

  assert.ok(!names.includes('gm_provider'));
  assert.ok(!names.includes('gm_fork'));
  assert.ok(!names.includes('gm_effort'));
  assert.ok(names.includes('gm_chat_sessions'));
  assert.ok(!names.includes('gm_project_sessions'));
  assert.ok(names.includes('gm_chat_resume'));
  assert.ok(!names.includes('gm_rollout_resume'));
  assert.equal(sessions.description, '列出最近的 chat sessions');
  assert.equal(resume.description, '继承一个已有的 chat session');
  assert.deepEqual(compact.options[0].choices.map((choice) => choice.value), [
    'status',
    'strategy',
    'token_limit',
    'enabled',
    'reset',
  ]);
});
