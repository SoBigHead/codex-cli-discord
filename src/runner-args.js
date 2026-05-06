import { randomUUID } from 'node:crypto';
import { buildCodexPermissionArgs } from './codex-permissions.js';
import { createClaudeProviderAdapter } from './providers/claude.js';
import { createCodexProviderAdapter } from './providers/codex.js';
import { createGeminiProviderAdapter } from './providers/gemini.js';
import { createProviderAdapterRegistry } from './providers/index.js';

export function uniqueDirs(dirs = []) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    const key = String(dir || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function composePromptWithSystemFallback(prompt, systemPrompt) {
  const systemText = String(systemPrompt || '').trim();
  if (!systemText) return prompt;
  return [
    systemText,
    '',
    String(prompt || ''),
  ].join('\n');
}

export function createRunnerArgsBuilder({
  defaultModel = null,
  normalizeProvider = (value) => String(value || '').trim().toLowerCase(),
  getSessionId = () => null,
  resolveModelSetting = () => ({ value: defaultModel, source: 'provider' }),
  resolveCodexProfileSetting = () => ({ value: null, source: 'provider default', valid: true, isExplicit: false }),
  resolveReasoningEffortSetting = () => ({ value: null, source: 'provider' }),
  resolveFastModeSetting = () => ({ enabled: false, source: 'provider unsupported' }),
  resolveCompactStrategySetting = () => ({ strategy: 'native' }),
  resolveCompactEnabledSetting = () => ({ enabled: false }),
  resolveNativeCompactTokenLimitSetting = () => ({ tokens: 0 }),
} = {}) {
  const providerAdapters = createProviderAdapterRegistry([
    createCodexProviderAdapter({
      buildArgs: ({ session, workspaceDir, prompt, inputImages = [], systemPrompt = '' }) => buildCodexArgs({
        session,
        workspaceDir,
        prompt,
        inputImages,
        systemPrompt,
      }),
    }),
    createClaudeProviderAdapter({
      buildArgs: ({ session, workspaceDir, prompt, additionalWorkspaceDirs = [], systemPrompt = '' }) => buildClaudeArgs({
        session,
        workspaceDir,
        prompt,
        additionalWorkspaceDirs,
        systemPrompt,
      }),
    }),
    createGeminiProviderAdapter({
      buildArgs: ({ session, prompt, systemPrompt = '' }) => buildGeminiArgs({ session, prompt, systemPrompt }),
    }),
  ]);

  function buildSessionRunnerArgs({
    provider,
    session,
    workspaceDir,
    prompt,
    additionalWorkspaceDirs = [],
    inputImages = [],
    systemPrompt = '',
  }) {
    const adapter = providerAdapters.get(provider);
    return adapter.runtime.buildArgs({
      session,
      workspaceDir,
      prompt,
      additionalWorkspaceDirs,
      inputImages,
      systemPrompt,
    });
  }

  function buildCodexArgs({ session, workspaceDir, prompt, inputImages = [], systemPrompt = '' }) {
    const sessionId = getSessionId(session);
    const permissionArgs = buildCodexPermissionArgs(session.mode, { resume: Boolean(sessionId) });
    const model = resolveModelSetting(session).value || defaultModel;
    const codexProfile = resolveCodexProfileSetting(session);
    const effort = resolveReasoningEffortSetting(session).value;
    const fastMode = resolveFastModeSetting(session);
    const extraConfigs = session.configOverrides || [];
    const compactSetting = resolveCompactStrategySetting(session);
    const compactEnabled = resolveCompactEnabledSetting(session);
    const nativeLimit = resolveNativeCompactTokenLimitSetting(session);
    const systemText = String(systemPrompt || '').trim();
    const shouldPassFastMode = fastMode.source === 'session override'
      || fastMode.source === 'parent channel'
      || fastMode.enabled === false;

    const common = [];
    if (systemText) common.push('-c', `developer_instructions=${tomlString(systemText)}`);
    if (codexProfile?.isExplicit) {
      if (!codexProfile.valid) {
        throw new Error(`invalid Codex profile: ${codexProfile.value} (${codexProfile.error || 'unknown error'})`);
      }
      if (codexProfile.value) common.push('--profile', codexProfile.value);
    }
    if (model) common.push('-m', model);
    if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
    if (shouldPassFastMode) {
      common.push('-c', `features.fast_mode=${fastMode.enabled ? 'true' : 'false'}`);
    }
    if (compactSetting.strategy === 'native' && compactEnabled.enabled) {
      common.push('-c', `model_auto_compact_token_limit=${nativeLimit.tokens}`);
    }
    for (const cfg of extraConfigs) common.push('-c', cfg);
    for (const imagePath of inputImages) {
      const value = String(imagePath || '').trim();
      if (value) common.push('--image', value);
    }

    if (sessionId) {
      return ['exec', 'resume', '--json', ...permissionArgs, ...common, sessionId, prompt];
    }

    return ['exec', '--json', '--skip-git-repo-check', ...permissionArgs, '-C', workspaceDir, ...common, prompt];
  }

  function buildClaudeArgs({ session, workspaceDir, prompt, additionalWorkspaceDirs = [], systemPrompt = '' }) {
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
    ];
    const systemText = String(systemPrompt || '').trim();
    for (const dir of uniqueDirs([workspaceDir, ...additionalWorkspaceDirs])) {
      args.push('--add-dir', dir);
    }
    const model = resolveModelSetting(session).value || defaultModel;
    const effort = resolveReasoningEffortSetting(session).value;
    const sessionId = getSessionId(session);
    const pendingForkFromSessionId = String(session?.pendingForkFromSessionId || '').trim();

    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    if (session.mode === 'dangerous') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }

    if (pendingForkFromSessionId) {
      args.push('--resume', pendingForkFromSessionId, '--fork-session');
      args.push('--session-id', sessionId || randomUUID());
    } else if (sessionId) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', randomUUID());
    }

    if (systemText) args.push('--append-system-prompt', systemText);
    args.push('--allowedTools', 'default', '--', prompt);
    return args;
  }

  function buildGeminiArgs({ session, prompt, systemPrompt = '' }) {
    const args = ['--output-format', 'stream-json'];
    const model = resolveModelSetting(session).value || defaultModel;
    const sessionId = getSessionId(session);
    const promptText = composePromptWithSystemFallback(prompt, systemPrompt);

    if (session.mode === 'dangerous') {
      args.push('--yolo');
    } else {
      args.push('--sandbox', '--approval-mode', 'default');
    }

    if (model) args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    args.push('--prompt', promptText);
    return args;
  }

  return {
    buildSessionRunnerArgs,
    buildCodexArgs,
    buildClaudeArgs,
    buildGeminiArgs,
  };
}
