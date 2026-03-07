import test from 'node:test';
import assert from 'node:assert/strict';

import { createOnboardingFlow } from '../src/onboarding-flow.js';

class FakeButtonBuilder {
  constructor() {
    this.data = {};
  }

  setCustomId(value) {
    this.data.customId = value;
    return this;
  }

  setLabel(value) {
    this.data.label = value;
    return this;
  }

  setStyle(value) {
    this.data.style = value;
    return this;
  }

  setDisabled(value) {
    this.data.disabled = value;
    return this;
  }
}

class FakeActionRowBuilder {
  constructor() {
    this.components = [];
  }

  addComponents(...components) {
    this.components.push(...components);
    return this;
  }
}

const ButtonStyle = {
  Primary: 'primary',
  Secondary: 'secondary',
  Success: 'success',
};

function createFlow({ session, saveDb } = {}) {
  return createOnboardingFlow({
    onboardingEnabledByDefault: true,
    defaultUiLanguage: 'zh',
    onboardingTotalSteps: 4,
    workspaceRoot: '/tmp/workspace',
    discordToken: 'discord-token',
    allowedChannelIds: new Set(['channel-1']),
    allowedUserIds: new Set(['user-1']),
    ActionRowBuilder: FakeActionRowBuilder,
    ButtonBuilder: FakeButtonBuilder,
    ButtonStyle,
    getSession: () => session,
    saveDb,
    getSessionProvider: () => 'codex',
    getRuntimeSnapshot: () => ({ queued: 0 }),
    getCliHealth: () => ({ ok: true, version: '1.2.3', bin: 'codex' }),
    resolveSecurityContext: () => ({ profile: 'solo', mentionOnly: false, maxQueuePerChannel: 0 }),
    getEffectiveSecurityProfile: (currentSession) => ({ profile: currentSession?.securityProfile || 'auto', source: 'session override' }),
    resolveTimeoutSetting: (currentSession) => ({ timeoutMs: currentSession?.timeoutMs ?? 60000, source: 'session override' }),
    getSessionLanguage: (currentSession) => currentSession?.language || 'zh',
    normalizeUiLanguage: (value) => String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh',
    slashRef: (base) => `/bot-${base}`,
    formatCliHealth: (health) => `${health.bin} ${health.version}`,
    formatLanguageLabel: (language) => language === 'en' ? 'English' : '中文',
    formatSecurityProfileLabel: (profile) => profile,
    formatTimeoutLabel: (timeoutMs) => timeoutMs > 0 ? `${timeoutMs}ms` : 'off',
    formatQueueLimit: (limit) => limit > 0 ? String(limit) : 'unlimited',
    formatSecurityProfileDisplay: (security) => `${security.profile}/${security.mentionOnly ? 'mention' : 'direct'}`,
    formatConfigCommandStatus: () => 'disabled',
    parseUiLanguageInput: (value) => ['zh', 'en'].includes(value) ? value : null,
    parseSecurityProfileInput: (value) => ['auto', 'solo', 'team', 'public'].includes(value) ? value : null,
    parseTimeoutConfigAction: (value) => {
      const timeoutMs = Number(value);
      if (!Number.isFinite(timeoutMs)) return null;
      return { type: 'set', timeoutMs };
    },
  });
}

test('createOnboardingFlow builds onboarding action rows for language step', () => {
  const session = { language: 'zh', onboardingEnabled: true };
  const flow = createFlow({ session, saveDb: () => {} });

  const rows = flow.buildOnboardingActionRows(1, '12345', session, 'zh');

  assert.equal(rows.length, 2);
  assert.equal(rows[0].components.length, 4);
  assert.equal(rows[1].components.length, 2);
  assert.equal(rows[1].components[0].data.customId, 'onb:set_lang:1:12345:zh');
  assert.equal(rows[1].components[0].data.style, ButtonStyle.Primary);
  assert.equal(rows[1].components[1].data.customId, 'onb:set_lang:1:12345:en');
  assert.equal(rows[1].components[1].data.style, ButtonStyle.Secondary);
});

test('createOnboardingFlow updates session language through button interaction', async () => {
  const session = { language: 'en', onboardingEnabled: true, securityProfile: 'auto', timeoutMs: 60000 };
  let saveCount = 0;
  const updates = [];
  const replies = [];
  const flow = createFlow({
    session,
    saveDb: () => {
      saveCount += 1;
    },
  });

  await flow.handleOnboardingButtonInteraction({
    customId: 'onb:set_lang:1:12345:zh',
    channelId: 'thread-1',
    user: { id: '12345' },
    channel: { id: 'thread-1' },
    async update(payload) {
      updates.push(payload);
    },
    async reply(payload) {
      replies.push(payload);
    },
  });

  assert.equal(session.language, 'zh');
  assert.equal(saveCount, 1);
  assert.equal(replies.length, 0);
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /Onboarding 1\/4：安装自检 \+ 语言设置/);
  assert.equal(updates[0].components.length, 2);
});
