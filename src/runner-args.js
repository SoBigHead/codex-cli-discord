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
      buildArgs: ({ session, workspaceDir, prompt, inputImages = [] }) => buildCodexArgs({ session, workspaceDir, prompt, inputImages }),
    }),
    createClaudeProviderAdapter({
      buildArgs: ({ session, workspaceDir, prompt, additionalWorkspaceDirs = [] }) => buildClaudeArgs({
        session,
        workspaceDir,
        prompt,
        additionalWorkspaceDirs,
      }),
    }),
    createGeminiProviderAdapter({
      buildArgs: ({ session, prompt }) => buildGeminiArgs({ session, prompt }),
    }),
  ]);

  function buildSessionRunnerArgs({ provider, session, workspaceDir, prompt, additionalWorkspaceDirs = [], inputImages = [] }) {
    const adapter = providerAdapters.get(provider);
    return adapter.runtime.buildArgs({ session, workspaceDir, prompt, additionalWorkspaceDirs, inputImages });
  }

  function buildCodexArgs({ session, workspaceDir, prompt, inputImages = [] }) {
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
    const shouldPassFastMode = fastMode.source === 'session override'
      || fastMode.source === 'parent channel'
      || fastMode.enabled === false;

    const common = ['--enable', 'goals'];
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

  function buildClaudeArgs({ session, workspaceDir, prompt, additionalWorkspaceDirs = [] }) {
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
    ];
    for (const dir of uniqueDirs([workspaceDir, ...additionalWorkspaceDirs])) {
      args.push('--add-dir', dir);
    }
    const model = resolveModelSetting(session).value || defaultModel;
    const effort = resolveReasoningEffortSetting(session).value;
    const sessionId = getSessionId(session);

    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    if (session.mode === 'dangerous') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }

    if (sessionId) args.push('--resume', sessionId);
    else args.push('--session-id', randomUUID());

    args.push('--allowedTools', 'default', '--', prompt);
    return args;
  }

  function buildGeminiArgs({ session, prompt }) {
    const args = ['--output-format', 'stream-json'];
    const model = resolveModelSetting(session).value || defaultModel;
    const sessionId = getSessionId(session);

    if (session.mode === 'dangerous') {
      args.push('--yolo');
    } else {
      args.push('--sandbox', '--approval-mode', 'default');
    }

    if (model) args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    args.push('--prompt', prompt);
    return args;
  }

  return {
    buildSessionRunnerArgs,
    buildCodexArgs,
    buildClaudeArgs,
    buildGeminiArgs,
  };
}
