import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspaceBrowser } from '../src/workspace-browser.js';

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

class FakeStringSelectMenuBuilder {
  constructor() {
    this.data = { options: [] };
  }

  setCustomId(value) {
    this.data.customId = value;
    return this;
  }

  setPlaceholder(value) {
    this.data.placeholder = value;
    return this;
  }

  addOptions(...options) {
    this.data.options.push(...options.flat());
    return this;
  }

  setDisabled(value) {
    this.data.disabled = value;
    return this;
  }
}

const ButtonStyle = {
  Primary: 'primary',
  Secondary: 'secondary',
  Danger: 'danger',
  Success: 'success',
};

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-workspace-browser-'));
}

function createBrowser({
  rootDir,
  session,
  commandActions = {},
  listStoredSessions = () => [],
  listFavoriteWorkspaces = () => [],
  addFavoriteWorkspace = () => ({ changed: false, favorites: [] }),
  removeFavoriteWorkspace = () => ({ changed: false, favorites: [] }),
  formatWorkspaceUpdateReport = () => '',
  formatDefaultWorkspaceUpdateReport = () => '',
} = {}) {
  return createWorkspaceBrowser({
    ActionRowBuilder: FakeActionRowBuilder,
    ButtonBuilder: FakeButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder: FakeStringSelectMenuBuilder,
    commandActions,
    workspaceRoot: rootDir,
    homeDir: rootDir,
    createToken: () => 'token123',
    getSession: () => session,
    getSessionLanguage: (currentSession) => currentSession?.language || 'zh',
    getSessionProvider: (currentSession) => currentSession?.provider || 'codex',
    getWorkspaceBinding: (currentSession) => ({
      workspaceDir: currentSession?.workspaceDir || rootDir,
      source: currentSession?.workspaceDir ? 'thread override' : 'legacy fallback',
    }),
    listStoredSessions,
    listFavoriteWorkspaces,
    addFavoriteWorkspace,
    removeFavoriteWorkspace,
    resolveProviderDefaultWorkspace: () => ({
      workspaceDir: session?.defaultWorkspaceDir || null,
      source: session?.defaultWorkspaceDir ? 'provider-scoped env' : 'unset',
    }),
    formatWorkspaceUpdateReport,
    formatDefaultWorkspaceUpdateReport,
  });
}

function createComponentInteraction({ customId, values = [], updates, replies } = {}) {
  return {
    customId,
    values,
    channelId: 'thread-1',
    user: { id: '12345' },
    channel: { id: 'thread-1' },
    async update(payload) {
      updates.push(payload);
    },
    async reply(payload) {
      replies.push(payload);
    },
  };
}

test('createWorkspaceBrowser builds a selector payload with child directory options', () => {
  const rootDir = createTempWorkspace();
  fs.mkdirSync(path.join(rootDir, 'repo-a'));
  fs.mkdirSync(path.join(rootDir, 'repo-b'));
  const session = { provider: 'codex', language: 'zh', workspaceDir: rootDir };
  const browser = createBrowser({ rootDir, session });

  const payload = browser.openWorkspaceBrowser({
    key: 'thread-1',
    session,
    userId: '12345',
    mode: 'thread',
  });

  assert.match(payload.content, /路径选择器/);
  assert.equal(payload.components.length, 3);
  assert.equal(payload.components[0].components[1].data.label, '使用当前目录');
  assert.equal(payload.components[0].components[1].data.disabled, true);
  assert.equal(payload.components[1].components[0].data.placeholder, '选择一个子目录');
  assert.equal(payload.components.at(-1).components.at(-1).data.label, '收藏当前');
  assert.deepEqual(
    payload.components[1].components[0].data.options.map((option) => option.label),
    ['repo-a', 'repo-b'],
  );
});

test('createWorkspaceBrowser navigates into a child directory and applies it as workspace', async () => {
  const rootDir = createTempWorkspace();
  const repoDir = path.join(rootDir, 'repo-a');
  fs.mkdirSync(repoDir);
  const session = { provider: 'codex', language: 'zh', workspaceDir: rootDir };
  let setWorkspaceCalls = 0;
  const browser = createBrowser({
    rootDir,
    session,
    commandActions: {
      setWorkspaceDir(currentSession, key, nextDir) {
        setWorkspaceCalls += 1;
        currentSession.workspaceDir = nextDir;
        return {
          provider: currentSession.provider,
          workspaceDir: nextDir,
          source: 'thread override',
          previousWorkspaceDir: rootDir,
          sessionReset: true,
        };
      },
      setDefaultWorkspaceDir() {
        throw new Error('should not be called');
      },
    },
    formatWorkspaceUpdateReport: (_key, _session, result) => `updated:${result.workspaceDir}`,
  });

  const initialPayload = browser.openWorkspaceBrowser({
    key: 'thread-1',
    session,
    userId: '12345',
    mode: 'thread',
  });

  const selectUpdates = [];
  const selectReplies = [];
  await browser.handleWorkspaceBrowserInteraction(createComponentInteraction({
    customId: initialPayload.components[1].components[0].data.customId,
    values: ['0'],
    updates: selectUpdates,
    replies: selectReplies,
  }));

  assert.equal(selectReplies.length, 0);
  assert.equal(selectUpdates.length, 1);
  assert.match(selectUpdates[0].content, /repo-a/);

  const applyButton = selectUpdates[0].components[0].components.find((component) => component.data.label === '使用当前目录');
  const applyUpdates = [];
  const applyReplies = [];
  await browser.handleWorkspaceBrowserInteraction(createComponentInteraction({
    customId: applyButton.data.customId,
    updates: applyUpdates,
    replies: applyReplies,
  }));

  assert.equal(applyReplies.length, 0);
  assert.equal(setWorkspaceCalls, 1);
  assert.equal(session.workspaceDir, repoDir);
  assert.deepEqual(applyUpdates, [{
    content: `updated:${repoDir}`,
    components: [],
  }]);
});

test('createWorkspaceBrowser exposes recent directories and jumps to selected recent folder', async () => {
  const rootDir = createTempWorkspace();
  const currentDir = path.join(rootDir, 'current');
  const recentDir = path.join(rootDir, 'recent');
  fs.mkdirSync(currentDir);
  fs.mkdirSync(recentDir);
  const session = { provider: 'codex', language: 'zh', workspaceDir: currentDir };
  const browser = createBrowser({
    rootDir,
    session,
    listStoredSessions: () => [
      {
        key: 'thread-2',
        session: {
          provider: 'codex',
          workspaceDir: recentDir,
          updatedAt: '2026-03-11T12:00:00.000Z',
        },
      },
    ],
  });

  const payload = browser.openWorkspaceBrowser({
    key: 'thread-1',
    session,
    userId: '12345',
    mode: 'thread',
  });

  assert.equal(payload.components.length, 3);
  assert.equal(payload.components[1].components[0].data.placeholder, '跳到最近使用的目录');
  assert.deepEqual(
    payload.components[1].components[0].data.options.map((option) => option.label),
    ['recent'],
  );

  const updates = [];
  const replies = [];
  await browser.handleWorkspaceBrowserInteraction(createComponentInteraction({
    customId: payload.components[1].components[0].data.customId,
    values: ['0'],
    updates,
    replies,
  }));

  assert.equal(replies.length, 0);
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /recent/);
});

test('createWorkspaceBrowser toggles favorites and jumps through favorites menu', async () => {
  const rootDir = createTempWorkspace();
  const currentDir = path.join(rootDir, 'current');
  const favoriteDir = path.join(rootDir, 'favorite');
  fs.mkdirSync(currentDir);
  fs.mkdirSync(favoriteDir);
  const session = { provider: 'codex', language: 'zh', workspaceDir: currentDir };
  let favorites = [];
  const browser = createBrowser({
    rootDir,
    session,
    listFavoriteWorkspaces: () => [...favorites],
    addFavoriteWorkspace: (_provider, workspaceDir) => {
      favorites = favorites.includes(workspaceDir) ? favorites : [workspaceDir, ...favorites];
      return { changed: true, favorites: [...favorites] };
    },
    removeFavoriteWorkspace: (_provider, workspaceDir) => {
      favorites = favorites.filter((dir) => dir !== workspaceDir);
      return { changed: true, favorites: [...favorites] };
    },
  });

  const initialPayload = browser.openWorkspaceBrowser({
    key: 'thread-1',
    session,
    userId: '12345',
    mode: 'thread',
  });

  const favoriteButton = initialPayload.components.at(-1).components.find((component) => component.data.label === '收藏当前');
  const toggleUpdates = [];
  const toggleReplies = [];
  await browser.handleWorkspaceBrowserInteraction(createComponentInteraction({
    customId: favoriteButton.data.customId,
    updates: toggleUpdates,
    replies: toggleReplies,
  }));

  assert.equal(toggleReplies.length, 0);
  assert.deepEqual(favorites, [currentDir]);
  assert.match(toggleUpdates[0].content, /已收藏/);
  assert.equal(toggleUpdates[0].components.at(-1).components.at(-1).data.label, '取消收藏');

  favorites = [favoriteDir, ...favorites];
  const refreshed = browser.openWorkspaceBrowser({
    key: 'thread-1',
    session,
    userId: '12345',
    mode: 'thread',
  });

  assert.equal(refreshed.components[1].components[0].data.placeholder, '跳到收藏目录');
  const jumpUpdates = [];
  const jumpReplies = [];
  await browser.handleWorkspaceBrowserInteraction(createComponentInteraction({
    customId: refreshed.components[1].components[0].data.customId,
    values: ['0'],
    updates: jumpUpdates,
    replies: jumpReplies,
  }));

  assert.equal(jumpReplies.length, 0);
  assert.equal(jumpUpdates.length, 1);
  assert.match(jumpUpdates[0].content, /favorite/);
});
