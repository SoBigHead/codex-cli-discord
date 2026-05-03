import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSlashCommandEntries,
  getActionButtonCommandNames,
  normalizeCommandName,
} from '../src/command-spec.js';

test('normalizeCommandName maps text and slash aliases to canonical names', () => {
  assert.equal(normalizeCommandName('!c', { allowBangPrefix: true }), 'cancel');
  assert.equal(normalizeCommandName('!abort', { allowBangPrefix: true }), 'cancel');
  assert.equal(normalizeCommandName('guide'), 'onboarding');
  assert.equal(normalizeCommandName('lang'), 'language');
  assert.equal(normalizeCommandName('cd'), 'setdir');
  assert.equal(normalizeCommandName('extra-info'), 'extra_info');
  assert.equal(normalizeCommandName('extrainfo'), 'extra_info');
  assert.equal(normalizeCommandName('defaultdir'), 'setdefaultdir');
  assert.equal(normalizeCommandName('project_sessions'), 'sessions');
  assert.equal(normalizeCommandName('chat_resume'), 'resume');
});

test('getActionButtonCommandNames exposes canonical button-safe commands', () => {
  assert.deepEqual(getActionButtonCommandNames(), ['status', 'sessions', 'queue', 'progress', 'new', 'cancel', 'retry']);
});

test('buildSlashCommandEntries includes aliases and provider toggle only in shared mode', () => {
  const sharedEntries = buildSlashCommandEntries({ botProvider: null });
  const lockedEntries = buildSlashCommandEntries({ botProvider: 'gemini' });

  const newEntry = sharedEntries.find((entry) => entry.name === 'new');
  const cancelEntry = sharedEntries.find((entry) => entry.name === 'cancel');
  const sessionsEntry = sharedEntries.find((entry) => entry.name === 'sessions');
  const resumeEntry = sharedEntries.find((entry) => entry.name === 'resume');
  const settingsEntry = sharedEntries.find((entry) => entry.name === 'settings');
  const fastEntry = sharedEntries.find((entry) => entry.name === 'fast');
  const runtimeEntry = sharedEntries.find((entry) => entry.name === 'runtime');
  const forkEntry = sharedEntries.find((entry) => entry.name === 'fork');
  const goalEntry = sharedEntries.find((entry) => entry.name === 'goal');
  const extraInfoEntry = sharedEntries.find((entry) => entry.name === 'extra_info');

  assert.equal(Array.isArray(newEntry.aliases), false);
  assert.ok(settingsEntry);
  assert.deepEqual(cancelEntry.aliases, ['abort']);
  assert.deepEqual(sessionsEntry.aliases, ['rollout_sessions', 'project_sessions', 'chat_sessions']);
  assert.deepEqual(resumeEntry.aliases, ['rollout_resume', 'project_resume', 'chat_resume']);
  assert.ok(fastEntry);
  assert.ok(runtimeEntry);
  assert.ok(forkEntry);
  assert.ok(goalEntry);
  assert.deepEqual(extraInfoEntry.aliases, ['extrainfo']);
  assert.ok(sharedEntries.some((entry) => entry.name === 'provider'));
  assert.ok(!lockedEntries.some((entry) => entry.name === 'provider'));
  assert.ok(!lockedEntries.some((entry) => entry.name === 'fast'));
  assert.ok(!lockedEntries.some((entry) => entry.name === 'runtime'));
  assert.ok(!lockedEntries.some((entry) => entry.name === 'fork'));
  assert.ok(!lockedEntries.some((entry) => entry.name === 'goal'));
  assert.ok(buildSlashCommandEntries({ botProvider: 'claude' }).some((entry) => entry.name === 'runtime'));
  assert.ok(buildSlashCommandEntries({ botProvider: 'codex' }).some((entry) => entry.name === 'fork'));
  assert.ok(buildSlashCommandEntries({ botProvider: 'codex' }).some((entry) => entry.name === 'goal'));

  const lockedSessions = lockedEntries.find((entry) => entry.name === 'sessions');
  const lockedResume = lockedEntries.find((entry) => entry.name === 'resume');
  const lockedCompact = lockedEntries.find((entry) => entry.name === 'compact');
  const lockedEffort = lockedEntries.find((entry) => entry.name === 'effort');

  assert.deepEqual(lockedSessions.aliases, ['chat_sessions']);
  assert.equal(lockedSessions.description, '列出最近的 chat sessions');
  assert.deepEqual(lockedResume.aliases, ['chat_resume']);
  assert.equal(lockedResume.description, '继承一个已有的 chat session');
  assert.equal(lockedEffort, undefined);
  assert.deepEqual(
    lockedCompact.configure({
      addStringOption(configure) {
        const option = {
          data: { choices: [] },
          setName() { return this; },
          setDescription() { return this; },
          setRequired() { return this; },
          addChoices(...choices) {
            this.data.choices.push(...choices);
            return this;
          },
        };
        configure(option);
        this.options = this.options || [];
        this.options.push(option.data);
        return this;
      },
    }).options[0].choices.map((choice) => choice.value),
    ['status', 'strategy', 'token_limit', 'enabled', 'reset'],
  );
});
