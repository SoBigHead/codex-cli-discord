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

function createFlow({
  session,
  botProvider = null,
  saveDb = () => {},
  commandActions = {},
  openWorkspaceBrowser,
  getWorkspaceBinding,
} = {}) {
  return createOnboardingFlow({
    onboardingEnabledByDefault: true,
    defaultUiLanguage: 'zh',
    onboardingTotalSteps: 4,
    botProvider,
    ActionRowBuilder: FakeActionRowBuilder,
    ButtonBuilder: FakeButtonBuilder,
    ButtonStyle,
    getSession: () => session,
    saveDb,
    getSessionProvider: (currentSession) => currentSession?.provider || 'codex',
    getSessionLanguage: (currentSession) => currentSession?.language || 'zh',
    getWorkspaceBinding: getWorkspaceBinding || ((currentSession) => ({
      workspaceDir: currentSession?.workspaceDir || '/tmp/provider-default',
      source: currentSession?.workspaceSource || (currentSession?.workspaceDir ? 'thread override' : 'provider default'),
    })),
    getProviderDisplayName: (provider) => ({
      codex: 'Codex CLI',
      claude: 'Claude Code',
      antigravity: 'Antigravity CLI',
      gemini: 'Antigravity CLI',
    }[provider] || provider),
    getCliHealth: (provider) => ({ ok: true, version: '1.2.3', bin: provider }),
    resolveSecurityContext: () => ({ mentionOnly: false }),
    normalizeUiLanguage: (value) => String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh',
    slashRef: (base) => `/bot-${base}`,
    formatCliHealth: (health) => `${health.bin} ${health.version}`,
    formatLanguageLabel: (language) => language === 'en' ? 'English' : '中文',
    parseUiLanguageInput: (value) => ['zh', 'en'].includes(value) ? value : null,
    commandActions,
    openWorkspaceBrowser,
  });
}

test('createOnboardingFlow builds language step action rows', () => {
  const session = { language: 'zh', provider: 'codex', onboardingEnabled: true };
  const flow = createFlow({ session });

  const rows = flow.buildOnboardingActionRows(1, 'thread-1', '12345', session, 'zh');

  assert.equal(rows.length, 2);
  assert.equal(rows[0].components.length, 4);
  assert.equal(rows[1].components.length, 2);
  assert.equal(rows[1].components[0].data.customId, 'onb:set_lang:1:12345:zh');
  assert.equal(rows[1].components[0].data.style, ButtonStyle.Primary);
  assert.equal(rows[1].components[1].data.customId, 'onb:set_lang:1:12345:en');
  assert.equal(rows[1].components[1].data.style, ButtonStyle.Secondary);
});

test('createOnboardingFlow updates session language through button interaction', async () => {
  const session = { language: 'en', provider: 'codex', onboardingEnabled: true };
  let saveCount = 0;
  const updates = [];
  const replies = [];
  const flow = createFlow({
    session,
    commandActions: {
      setLanguage(currentSession, language) {
        currentSession.language = language;
        saveCount += 1;
        return { language };
      },
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
  assert.match(updates[0].content, /首跑引导 1\/4：语言/);
  assert.equal(updates[0].components.length, 2);
});

test('createOnboardingFlow builds provider buttons in shared mode', () => {
  const session = { language: 'zh', provider: 'claude', onboardingEnabled: true };
  const flow = createFlow({ session });

  const rows = flow.buildOnboardingActionRows(2, 'thread-1', '12345', session, 'zh');

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows[1].components.map((component) => component.data.label),
    ['codex', 'claude', 'antigravity'],
  );
  assert.equal(rows[1].components[1].data.style, ButtonStyle.Primary);
});

test('createOnboardingFlow hides provider buttons when bot provider is locked', () => {
  const session = { language: 'zh', provider: 'antigravity', onboardingEnabled: true };
  const flow = createFlow({ session, botProvider: 'antigravity' });

  const rows = flow.buildOnboardingActionRows(2, 'thread-1', '12345', session, 'zh');
  const report = flow.formatOnboardingStepReport(2, 'thread-1', session, { id: 'thread-1' }, 'zh');

  assert.equal(rows.length, 1);
  assert.match(report, /已锁定单一 provider/);
});

test('createOnboardingFlow updates provider through button interaction', async () => {
  const session = { language: 'zh', provider: 'codex', onboardingEnabled: true };
  const updates = [];
  const flow = createFlow({
    session,
    commandActions: {
      setProvider(currentSession, provider) {
        currentSession.provider = provider;
        return { previous: 'codex', provider };
      },
    },
  });

  await flow.handleOnboardingButtonInteraction({
    customId: 'onb:set_provider:2:12345:antigravity',
    channelId: 'thread-1',
    user: { id: '12345' },
    channel: { id: 'thread-1' },
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
  });

  assert.equal(session.provider, 'antigravity');
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /Antigravity CLI/);
});

test('createOnboardingFlow opens workspace browser in a separate reply', async () => {
  const session = { language: 'zh', provider: 'codex', onboardingEnabled: true };
  const updates = [];
  const replies = [];
  const flow = createFlow({
    session,
    openWorkspaceBrowser: ({ key, userId, mode, flags }) => ({
      content: `browse:${mode}:${key}:${userId}`,
      components: [],
      flags,
    }),
  });

  await flow.handleOnboardingButtonInteraction({
    customId: 'onb:workspace_browse:3:12345',
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

  assert.equal(updates.length, 0);
  assert.deepEqual(replies, [{
    content: 'browse:thread:thread-1:12345',
    components: [],
    flags: 64,
  }]);
});

test('createOnboardingFlow clears thread workspace override through default button', async () => {
  const session = {
    language: 'zh',
    provider: 'codex',
    onboardingEnabled: true,
    workspaceDir: '/repo/override',
    workspaceSource: 'thread override',
  };
  const updates = [];
  let clearCalls = 0;
  const flow = createFlow({
    session,
    commandActions: {
      clearWorkspaceDir(currentSession) {
        clearCalls += 1;
        currentSession.workspaceDir = null;
        currentSession.workspaceSource = 'provider default';
        return { workspaceDir: '/tmp/provider-default', source: 'provider default' };
      },
    },
  });

  await flow.handleOnboardingButtonInteraction({
    customId: 'onb:workspace_default:3:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    channel: { id: 'thread-1' },
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
  });

  assert.equal(clearCalls, 1);
  assert.equal(session.workspaceDir, null);
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /provider 默认 workspace|provider 默认/);
  assert.equal(updates[0].components[1].components[0].data.disabled, true);
});
