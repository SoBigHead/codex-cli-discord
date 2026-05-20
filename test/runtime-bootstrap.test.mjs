import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  configureRuntimeProxy,
  createDiscordClient,
  normalizeSlashPrefix,
  readAntigravityDefaults,
  readAntigravityModelCatalog,
  readCodexDefaults,
  readCodexModelCatalog,
  readCodexProfileCatalog,
  readClaudeModelCatalog,
  readProviderModelCatalog,
  renderMissingDiscordTokenHint,
  writeAntigravityModelSetting,
  writeCodexDefaults,
} from '../src/runtime-bootstrap.js';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-runtime-bootstrap-'));
}

test('readCodexDefaults reads model reasoning effort and keeps fast mode on by default', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const configDir = path.join(homeDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['model = "o3"', 'model_reasoning_effort = "high"', '[features]', 'fast_mode = true'].join('\n'),
  );

  assert.deepEqual(readCodexDefaults({ env: { HOME: homeDir } }), {
    model: 'o3',
    modelConfigured: true,
    effort: 'high',
    effortConfigured: true,
    fastMode: true,
    fastModeConfigured: true,
  });

  fs.writeFileSync(
    configPath,
    ['model = "o3"', 'model_reasoning_effort = "high"', '[features]'].join('\n'),
  );
  assert.deepEqual(readCodexDefaults({ env: { HOME: homeDir } }), {
    model: 'o3',
    modelConfigured: true,
    effort: 'high',
    effortConfigured: true,
    fastMode: true,
    fastModeConfigured: false,
  });

  fs.writeFileSync(
    configPath,
    ['model = "o3"', 'model_reasoning_effort = "high"', '[features]', 'fast_mode = false'].join('\n'),
  );
  assert.deepEqual(readCodexDefaults({ env: { HOME: homeDir } }), {
    model: 'o3',
    modelConfigured: true,
    effort: 'high',
    effortConfigured: true,
    fastMode: false,
    fastModeConfigured: true,
  });

  assert.deepEqual(readCodexDefaults({ env: { HOME: path.join(rootDir, 'missing') } }), {
    model: null,
    modelConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: true,
    fastModeConfigured: false,
  });
});

test('writeCodexDefaults updates codex config defaults and can clear back to built-in/provider defaults', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const configDir = path.join(homeDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');

  fs.writeFileSync(
    configPath,
    [
      'model_provider = "tabcode"',
      '[features]',
      'unified_exec = true',
      'fast_mode = false',
    ].join('\n'),
  );

  let defaults = writeCodexDefaults({
    env: { HOME: homeDir },
    model: 'gpt-5.4',
    effort: 'xhigh',
    fastMode: true,
  });

  assert.deepEqual(defaults, {
    model: 'gpt-5.4',
    modelConfigured: true,
    effort: 'xhigh',
    effortConfigured: true,
    fastMode: true,
    fastModeConfigured: true,
  });
  assert.match(fs.readFileSync(configPath, 'utf-8'), /^model = "gpt-5\.4"$/m);
  assert.match(fs.readFileSync(configPath, 'utf-8'), /^model_reasoning_effort = "xhigh"$/m);
  assert.match(fs.readFileSync(configPath, 'utf-8'), /^\[features\]$/m);
  assert.match(fs.readFileSync(configPath, 'utf-8'), /^fast_mode = true$/m);

  defaults = writeCodexDefaults({
    env: { HOME: homeDir },
    model: null,
    effort: null,
    fastMode: null,
  });

  assert.deepEqual(defaults, {
    model: null,
    modelConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: true,
    fastModeConfigured: false,
  });
  const raw = fs.readFileSync(configPath, 'utf-8');
  assert.doesNotMatch(raw, /^model = /m);
  assert.doesNotMatch(raw, /^model_reasoning_effort = /m);
  assert.doesNotMatch(raw, /^fast_mode = /m);
  assert.match(raw, /^\[features\]$/m);
});

test('writeCodexDefaults trims string inputs and clears blank string values', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const configDir = path.join(homeDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');

  const defaults = writeCodexDefaults({
    env: { HOME: homeDir },
    model: '  gpt-5.4  ',
    effort: '   ',
  });

  assert.deepEqual(defaults, {
    model: 'gpt-5.4',
    modelConfigured: true,
    effort: null,
    effortConfigured: false,
    fastMode: true,
    fastModeConfigured: false,
  });

  const raw = fs.readFileSync(configPath, 'utf-8');
  assert.match(raw, /^model = "gpt-5\.4"$/m);
  assert.doesNotMatch(raw, /^model_reasoning_effort = /m);
});

test('readCodexProfileCatalog reads named codex profiles from config.toml', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const configDir = path.join(homeDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');

  fs.writeFileSync(configPath, [
    'model = "gpt-5.4"',
    '',
    '[profiles.default_work]',
    'model = "gpt-5.4"',
    '',
    '[profiles."vision qa"]',
    'model = "gpt-5.4-mini"',
    '',
    '[profiles.default_work]',
    'model = "o3"',
  ].join('\n'));

  assert.deepEqual(readCodexProfileCatalog({ env: { HOME: homeDir } }), {
    profiles: ['default_work', 'vision qa'],
    configPath,
  });
});

test('readCodexModelCatalog reads Codex CLI model catalog', () => {
  const catalog = readCodexModelCatalog({
    codexBin: 'codex-test',
    now: () => 1000,
    execFileSyncFn(bin, args) {
      assert.equal(bin, 'codex-test');
      assert.deepEqual(args, ['debug', 'models']);
      return JSON.stringify({
        models: [{
          slug: 'gpt-5.4',
          display_name: 'gpt-5.4',
          description: 'Strong model',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'medium' },
            { effort: 'high' },
          ],
          visibility: 'list',
        }],
      });
    },
  });

  assert.deepEqual(catalog, {
    models: [{
      slug: 'gpt-5.4',
      displayName: 'gpt-5.4',
      description: 'Strong model',
      defaultReasoningLevel: 'medium',
      supportedReasoningLevels: ['low', 'medium', 'high'],
      visibility: 'list',
    }],
    error: null,
  });
});

test('readCodexModelCatalog reports CLI catalog errors', () => {
  const catalog = readCodexModelCatalog({
    codexBin: 'codex-fail',
    now: () => 2000,
    execFileSyncFn() {
      throw new Error('codex debug models failed');
    },
  });

  assert.deepEqual(catalog, {
    models: [],
    error: 'codex debug models failed',
  });
});

test('readClaudeModelCatalog reads aliases and effort levels from Claude CLI help', () => {
  const catalog = readClaudeModelCatalog({
    claudeBin: 'claude-test',
    now: () => 3000,
    execFileSyncFn(bin, args) {
      assert.equal(bin, 'claude-test');
      assert.deepEqual(args, ['--help']);
      return [
        "--effort <level>    Effort level for the current session (low, medium, high)",
        "--model <model>     Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-4-6').",
      ].join('\n');
    },
  });

  assert.deepEqual(catalog, {
    models: [
      {
        slug: 'sonnet',
        displayName: 'sonnet',
        description: 'Claude Code model alias from CLI help',
        defaultReasoningLevel: null,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        visibility: 'help',
      },
      {
        slug: 'opus',
        displayName: 'opus',
        description: 'Claude Code model alias from CLI help',
        defaultReasoningLevel: null,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        visibility: 'help',
      },
      {
        slug: 'claude-sonnet-4-6',
        displayName: 'claude-sonnet-4-6',
        description: 'Claude Code full model name from CLI help',
        defaultReasoningLevel: null,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        visibility: 'help',
      },
    ],
    error: null,
  });
});

test('readAntigravityDefaults reads settings.json and reports malformed settings', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const settingsDir = path.join(homeDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    colorScheme: 'dark',
    model: 'Claude Opus 4.6 (Thinking)',
  }));

  assert.deepEqual(readAntigravityDefaults({ env: { HOME: homeDir } }), {
    model: 'Claude Opus 4.6 (Thinking)',
    modelConfigured: true,
    profile: null,
    profileConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: false,
    fastModeConfigured: false,
    source: 'settings.json',
    settingsPath,
    error: null,
  });

  fs.writeFileSync(settingsPath, '{bad json');
  const malformed = readAntigravityDefaults({ env: { HOME: homeDir } });
  assert.equal(malformed.model, null);
  assert.equal(malformed.source, 'settings.json');
  assert.match(malformed.error, /Unexpected token|Expected property name/i);
});

test('writeAntigravityModelSetting preserves settings and rejects malformed settings', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const settingsDir = path.join(homeDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    colorScheme: 'dark',
    enableTelemetry: false,
    model: 'Gemini 3.5 Flash (High)',
  }));

  const defaults = writeAntigravityModelSetting({
    env: { HOME: homeDir },
    model: 'Claude Opus 4.6 (Thinking)',
  });
  assert.equal(defaults.model, 'Claude Opus 4.6 (Thinking)');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), {
    colorScheme: 'dark',
    enableTelemetry: false,
    model: 'Claude Opus 4.6 (Thinking)',
  });

  writeAntigravityModelSetting({ env: { HOME: homeDir }, model: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), {
    colorScheme: 'dark',
    enableTelemetry: false,
  });

  fs.writeFileSync(settingsPath, '{bad json');
  assert.throws(
    () => writeAntigravityModelSetting({ env: { HOME: homeDir }, model: 'Gemini 3.5 Flash (High)' }),
    /Unexpected token|Expected property name/i,
  );
});

test('readAntigravityModelCatalog lists configured documented and recently observed models', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const agyDir = path.join(homeDir, '.gemini', 'antigravity-cli');
  const logDir = path.join(agyDir, 'log');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(agyDir, 'settings.json'), JSON.stringify({
    model: 'Claude Opus 4.6 (Thinking)',
  }));
  fs.writeFileSync(path.join(logDir, 'cli-1.log'), [
    'I model_config_manager.go:157] Propagating selected model override to backend: label="Gemini 3.5 Flash (High)"',
    'I model_resolver.go:227] Resolving model Claude Opus 4.6 (Thinking)',
  ].join('\n'));

  const catalog = readAntigravityModelCatalog({
    env: { HOME: homeDir },
    now: () => 10_000,
    ttlMs: 0,
  });

  assert.deepEqual(catalog, {
    models: [
      {
        slug: 'Claude Opus 4.6 (Thinking)',
        displayName: 'Claude Opus 4.6 (Thinking)',
        description: 'Antigravity configured model from settings.json',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'settings',
      },
      {
        slug: 'Gemini 3.5 Flash',
        displayName: 'Gemini 3.5 Flash',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'Gemini 3.1 Pro (High)',
        displayName: 'Gemini 3.1 Pro (High)',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'Gemini 3.1 Pro (Low)',
        displayName: 'Gemini 3.1 Pro (Low)',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'Gemini 3 Flash',
        displayName: 'Gemini 3 Flash',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'Claude Sonnet 4.6 (Thinking)',
        displayName: 'Claude Sonnet 4.6 (Thinking)',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'GPT-OSS-120B',
        displayName: 'GPT-OSS-120B',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'Gemini 3.5 Flash (High)',
        displayName: 'Gemini 3.5 Flash (High)',
        description: 'Antigravity model observed in local CLI logs',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'logs',
      },
    ],
    error: null,
  });
});

test('readProviderModelCatalog dispatches Claude Antigravity and unknown providers', () => {
  const claude = readProviderModelCatalog({
    provider: 'claude',
    claudeBin: 'claude-provider-test',
    now: () => 4000,
    execFileSyncFn() {
      return "--model <model> (e.g. 'sonnet')";
    },
  });
  assert.equal(claude.models[0].slug, 'sonnet');

  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const settingsDir = path.join(homeDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
    model: 'Claude Opus 4.6 (Thinking)',
  }));
  const antigravity = readProviderModelCatalog({
    provider: 'gemini',
    env: { HOME: homeDir },
    now: () => 5000,
    ttlMs: 0,
  });
  assert.equal(antigravity.models[0].slug, 'Claude Opus 4.6 (Thinking)');

  assert.deepEqual(readProviderModelCatalog({ provider: 'unknown' }), { models: [], error: null });
});

test('normalizeSlashPrefix trims strips and truncates invalid input', () => {
  assert.equal(normalizeSlashPrefix('  Codex-Bot__Alpha!!  '), 'codexbot__al');
  assert.equal(normalizeSlashPrefix('___'), '');
  assert.equal(normalizeSlashPrefix(''), '');
});

test('renderMissingDiscordTokenHint explains provider-scoped and shared token states', () => {
  assert.equal(
    renderMissingDiscordTokenHint({ botProvider: 'antigravity', env: {} }),
    'Missing Discord token in environment (DISCORD_TOKEN_ANTIGRAVITY or DISCORD_TOKEN_GEMINI or DISCORD_TOKEN)',
  );
  assert.match(
    renderMissingDiscordTokenHint({
      env: {
        CODEX__DISCORD_TOKEN: 'a',
        ANTIGRAVITY__DISCORD_TOKEN: 'b',
      },
    }),
    /Found provider-scoped tokens for: codex, antigravity/,
  );
  assert.equal(
    renderMissingDiscordTokenHint({ env: {} }),
    'Missing DISCORD_TOKEN in environment',
  );
});

test('configureRuntimeProxy wires repaired proxy settings into agents and logs', () => {
  const env = {
    HTTP_PROXY: 'http://127.0.0.1:7890',
    SOCKS_PROXY: 'socks5h://127.0.0.1:7891',
    INSECURE_TLS: '1',
  };
  const globalTarget = {};
  const dispatcherCalls = [];
  const repairs = [];

  const result = configureRuntimeProxy({
    env,
    envFilePath: '/tmp/.env',
    autoRepairProxyEnvFn: (envFilePath, options) => {
      repairs.push({ envFilePath, options });
      return { logs: ['proxy repaired'] };
    },
    createHttpProxyAgent: (uri) => ({ kind: 'http', uri }),
    createSocksProxyAgent: (uri) => ({ kind: 'socks', uri }),
    setGlobalDispatcherFn: (agent) => dispatcherCalls.push(agent),
    globalTarget,
  });

  assert.equal(repairs[0].envFilePath, '/tmp/.env');
  assert.equal(repairs[0].options.env, env);
  assert.deepEqual(result.restProxyAgent, { kind: 'http', uri: 'http://127.0.0.1:7890' });
  assert.deepEqual(result.wsProxyAgent, { kind: 'socks', uri: 'socks5h://127.0.0.1:7891' });
  assert.deepEqual(dispatcherCalls, [{ kind: 'http', uri: 'http://127.0.0.1:7890' }]);
  assert.equal(globalTarget.__discordWsAgent, result.wsProxyAgent);
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  assert.deepEqual(result.logs, [
    'proxy repaired',
    '🌐 Proxy: REST=http://127.0.0.1:7890 | WS=socks5h://127.0.0.1:7891 | INSECURE_TLS=true',
  ]);
});

test('createDiscordClient applies Discord intents and optional REST proxy agent', () => {
  class FakeClient {
    constructor(options) {
      this.options = options;
      this.rest = {
        setAgent: (agent) => {
          this.agent = agent;
        },
      };
    }
  }

  const restProxyAgent = { kind: 'proxy' };
  const client = createDiscordClient({
    Client: FakeClient,
    GatewayIntentBits: {
      Guilds: 'guilds',
      GuildMessages: 'messages',
      MessageContent: 'content',
    },
    Partials: {
      Channel: 'channel',
      Message: 'message',
    },
    restProxyAgent,
  });

  assert.deepEqual(client.options.intents, ['guilds', 'messages', 'content']);
  assert.deepEqual(client.options.partials, ['channel', 'message']);
  assert.equal(client.agent, restProxyAgent);
});
