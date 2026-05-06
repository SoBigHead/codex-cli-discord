import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunnerArgsBuilder, uniqueDirs } from '../src/runner-args.js';

test('uniqueDirs removes blanks and duplicates while keeping order', () => {
  assert.deepEqual(
    uniqueDirs([' /repo/a ', '', null, '/repo/b', '/repo/a', '  ', '/repo/b']),
    ['/repo/a', '/repo/b'],
  );
});

test('createRunnerArgsBuilder builds gemini args instead of codex args', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: (session) => ({ value: session.model || null, source: session.model ? 'session override' : 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'gemini',
    session: {
      provider: 'gemini',
      mode: 'dangerous',
      model: 'gemini-2.5-pro',
      runnerSessionId: 'sess-gm-1',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'summarize the repo',
  });

  assert.deepEqual(args, [
    '--output-format',
    'stream-json',
    '--yolo',
    '--model',
    'gemini-2.5-pro',
    '--resume',
    'sess-gm-1',
    '--prompt',
    'summarize the repo',
  ]);
});

test('createRunnerArgsBuilder adds native compact config for fresh codex sessions when enabled', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveFastModeSetting: () => ({ enabled: true, source: 'session override' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 123456 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: ['foo="bar"'],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '-C',
    '/tmp/workspace',
    '-m',
    'gpt-5-codex',
    '-c',
    'features.fast_mode=true',
    '-c',
    'model_auto_compact_token_limit=123456',
    '-c',
    'foo="bar"',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder keeps native compact config for resumed codex sessions', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => 'sess-1',
    resolveFastModeSetting: () => ({ enabled: true, source: 'session override' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 123456 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: ['foo="bar"'],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  assert.deepEqual(args, [
    'exec',
    'resume',
    '--json',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'approval_policy="on-request"',
    '-m',
    'gpt-5-codex',
    '-c',
    'features.fast_mode=true',
    '-c',
    'model_auto_compact_token_limit=123456',
    '-c',
    'foo="bar"',
    'sess-1',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder passes native image inputs to codex exec', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: [],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
    inputImages: ['/tmp/image-a.jpg', '/tmp/image-b.png'],
  });

  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '-C',
    '/tmp/workspace',
    '-m',
    'gpt-5-codex',
    '-c',
    'features.fast_mode=false',
    '--image',
    '/tmp/image-a.jpg',
    '--image',
    '/tmp/image-b.png',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder passes extra context to codex developer instructions', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: [],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
    systemPrompt: '[Via agents-in-discord; discord_thread=thread-1]\nline two',
  });

  const systemIndex = args.indexOf('developer_instructions="[Via agents-in-discord; discord_thread=thread-1]\\nline two"');
  assert.notEqual(systemIndex, -1);
  assert.equal(args[systemIndex - 1], '-c');
  assert.equal(args.at(-1), 'inspect');
});

test('createRunnerArgsBuilder passes fast mode through when inherited from the parent channel', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveFastModeSetting: () => ({ enabled: false, source: 'parent channel' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: [],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '-C',
    '/tmp/workspace',
    '-m',
    'gpt-5-codex',
    '-c',
    'features.fast_mode=false',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder uses inherited model and effort settings', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: 'gpt-5.4', source: 'parent channel' }),
    resolveCodexProfileSetting: () => ({ value: 'work', source: 'parent channel', valid: true, isExplicit: true }),
    resolveReasoningEffortSetting: () => ({ value: 'high', source: 'parent channel' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: [],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '-C',
    '/tmp/workspace',
    '--profile',
    'work',
    '-m',
    'gpt-5.4',
    '-c',
    'model_reasoning_effort="high"',
    '-c',
    'features.fast_mode=false',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder throws when the effective codex profile is invalid', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveCodexProfileSetting: () => ({
      value: 'missing-profile',
      source: 'session override',
      valid: false,
      isExplicit: true,
      error: 'missing in /tmp/codex-config.toml',
    }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  assert.throws(() => buildSessionRunnerArgs({
    provider: 'codex',
    session: { mode: 'safe', configOverrides: [] },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  }), /invalid Codex profile: missing-profile/);
});

test('createRunnerArgsBuilder explicitly disables fast mode when config.toml resolves to off', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: [],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '-C',
    '/tmp/workspace',
    '-m',
    'gpt-5-codex',
    '-c',
    'features.fast_mode=false',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder uses claude dash-p for normal runtime args', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: 'high', source: 'session override' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'claude',
    session: {
      provider: 'claude',
      mode: 'dangerous',
      runnerSessionId: null,
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
  });

  assert.equal(args[0], '-p');
  assert.equal(args.includes('--print'), false);
  assert.equal(args.includes('--effort'), true);
  assert.equal(args.includes('high'), true);
  assert.equal(args.includes('--dangerously-skip-permissions'), true);
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), 'hello');
});

test('createRunnerArgsBuilder passes extra context to Claude append-system-prompt', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: () => 'claude-session-1',
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'claude',
    session: {
      provider: 'claude',
      mode: 'safe',
      runnerSessionId: 'claude-session-1',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
    systemPrompt: '[Via agents-in-discord; discord_thread=thread-1]',
  });

  const systemIndex = args.indexOf('--append-system-prompt');
  assert.notEqual(systemIndex, -1);
  assert.equal(args[systemIndex + 1], '[Via agents-in-discord; discord_thread=thread-1]');
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), 'hello');
});

test('createRunnerArgsBuilder uses Claude fork-session from pending fork parent', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'claude',
    session: {
      provider: 'claude',
      mode: 'safe',
      runnerSessionId: 'child-session',
      pendingForkFromSessionId: 'parent-session',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'first fork turn',
  });

  assert.equal(args[args.indexOf('--resume') + 1], 'parent-session');
  assert.equal(args.includes('--fork-session'), true);
  assert.equal(args[args.indexOf('--session-id') + 1], 'child-session');
  assert.equal(args.at(-1), 'first fork turn');
});

test('createRunnerArgsBuilder falls back to prompt context for Gemini', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'gemini',
    session: {
      provider: 'gemini',
      mode: 'safe',
      runnerSessionId: null,
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
    systemPrompt: '[Via agents-in-discord; discord_thread=thread-1]',
  });

  assert.equal(args.at(-2), '--prompt');
  assert.equal(args.at(-1), '[Via agents-in-discord; discord_thread=thread-1]\n\nhello');
});
