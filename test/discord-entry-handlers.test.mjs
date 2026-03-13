import test from 'node:test';
import assert from 'node:assert/strict';

import { createDiscordEntryHandlers } from '../src/discord-entry-handlers.js';

function createLogger() {
  return {
    log() {},
    warn() {},
    error() {},
  };
}

function createHarness(overrides = {}) {
  const calls = {
    registerSlashCommands: [],
    enqueuePrompt: [],
    handleCommand: [],
    routeSlashCommand: [],
    workspaceBrowser: 0,
    onboarding: 0,
  };

  const handlers = createDiscordEntryHandlers({
    logger: createLogger(),
    registerSlashCommands: async (payload) => {
      calls.registerSlashCommands.push(payload);
    },
    REST: { name: 'REST' },
    Routes: { name: 'Routes' },
    discordToken: 'token',
    restProxyAgent: { name: 'agent' },
    slashCommands: ['cmd'],
    withDiscordNetworkRetry: async (fn) => fn(),
    safeReply: async () => {},
    safeError: (err) => err?.message || String(err),
    isIgnorableDiscordRuntimeError: (err) => Number(err?.code) === 10062,
    isRecoverableGatewayCloseCode: (code) => Number(code) !== 4004,
    isAllowedUser: () => true,
    isAllowedChannel: () => true,
    isAllowedInteractionChannel: async () => true,
    getSession: () => ({ id: 'sess-1' }),
    resolveSecurityContext: () => ({ profile: 'team', mentionOnly: false }),
    handleCommand: async (...args) => {
      calls.handleCommand.push(args);
    },
    enqueuePrompt: async (...args) => {
      calls.enqueuePrompt.push(args);
    },
    doesMessageTargetBot: () => false,
    buildPromptFromMessage: (text) => text,
    parseCommandActionButtonId: () => null,
    isWorkspaceBrowserComponentId: () => false,
    isOnboardingButtonId: () => false,
    handleWorkspaceBrowserInteraction: async () => {
      calls.workspaceBrowser += 1;
    },
    handleOnboardingButtonInteraction: async () => {
      calls.onboarding += 1;
    },
    routeSlashCommand: async (payload) => {
      calls.routeSlashCommand.push(payload);
      return false;
    },
    normalizeSlashCommandName: (name) => `norm:${name}`,
    ...overrides,
  });

  return { handlers, calls };
}

test('sendInteractionResponse edits deferred replies and strips flags', async () => {
  const { handlers } = createHarness();
  const edits = [];
  const interaction = {
    deferred: true,
    replied: false,
    async editReply(payload) {
      edits.push(payload);
    },
  };

  await handlers.sendInteractionResponse(interaction, { content: 'hello', flags: 64 });

  assert.deepEqual(edits, [{ content: 'hello' }]);
});

test('handleInteractionCreate rejects command button clicks from other users', async () => {
  const { handlers } = createHarness({
    parseCommandActionButtonId: () => ({ command: 'status', userId: 'owner-1' }),
  });
  const replies = [];
  const interaction = {
    customId: 'command:status',
    user: { id: 'guest-2' },
    isButton: () => true,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => false,
    async reply(payload) {
      replies.push(payload);
    },
  };

  await handlers.handleInteractionCreate(interaction);

  assert.deepEqual(replies, [{ content: '⛔ 这组快捷按钮属于发起命令的用户。', flags: 64 }]);
});

test('handleInteractionCreate defers chat commands and reports unknown commands via editReply', async () => {
  const { handlers, calls } = createHarness();
  const defers = [];
  const edits = [];
  const interaction = {
    commandName: 'ping',
    user: { id: 'user-1' },
    deferred: true,
    replied: false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => true,
    async deferReply(payload) {
      defers.push(payload);
    },
    async editReply(payload) {
      edits.push(payload);
    },
    async reply() {
      throw new Error('unexpected reply');
    },
    async followUp() {
      throw new Error('unexpected followUp');
    },
  };

  await handlers.handleInteractionCreate(interaction);

  assert.deepEqual(defers, [{ flags: 64 }]);
  assert.equal(calls.routeSlashCommand.length, 1);
  assert.equal(calls.routeSlashCommand[0].commandName, 'norm:ping');
  assert.deepEqual(edits, [{ content: '❌ 未知命令：`ping`' }]);
});

test('handleMessageCreate strips bot mention and enqueues prompt', async () => {
  const { handlers, calls } = createHarness({
    doesMessageTargetBot: () => true,
    resolveSecurityContext: () => ({ profile: 'public', mentionOnly: true }),
    buildPromptFromMessage: (text) => `PROMPT:${text}`,
  });
  const message = {
    content: '<@123>  hello world  ',
    system: false,
    author: { id: 'user-1', bot: false, tag: 'demo#0001' },
    channel: {
      id: 'channel-1',
      isThread: () => false,
    },
    attachments: new Map(),
    reactions: { cache: new Map() },
    async react() {},
  };
  const bot = {
    user: { id: '123' },
  };

  await handlers.handleMessageCreate(message, bot);

  assert.equal(calls.enqueuePrompt.length, 1);
  assert.equal(calls.enqueuePrompt[0][1], 'channel-1');
  assert.equal(calls.enqueuePrompt[0][2], 'PROMPT:hello world');
  assert.deepEqual(calls.enqueuePrompt[0][3], { profile: 'public', mentionOnly: true });
});

test('bindClientHandlers wires ready registration and recoverable shard disconnect self-heal', async () => {
  const { handlers, calls } = createHarness();
  const onceHandlers = new Map();
  const onHandlers = new Map();
  const bot = {
    user: { id: 'bot-1', tag: 'bot#0001' },
    once(event, handler) {
      onceHandlers.set(event, handler);
    },
    on(event, handler) {
      onHandlers.set(event, handler);
    },
  };
  const heals = [];

  handlers.bindClientHandlers(bot, {
    scheduleSelfHeal: (reason) => {
      heals.push(reason);
    },
  });

  await onceHandlers.get('ready')();
  onHandlers.get('shardDisconnect')({ code: 1006 }, 2);

  assert.equal(calls.registerSlashCommands.length, 1);
  assert.equal(calls.registerSlashCommands[0].client, bot);
  assert.deepEqual(heals, ['shard_disconnect:2:code=1006']);
});
