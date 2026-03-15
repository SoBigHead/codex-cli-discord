import { randomUUID } from 'node:crypto';
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
  resolveCompactStrategySetting = () => ({ strategy: 'native' }),
  resolveCompactEnabledSetting = () => ({ enabled: false }),
  resolveNativeCompactTokenLimitSetting = () => ({ tokens: 0 }),
} = {}) {
  const providerAdapters = createProviderAdapterRegistry([
    createCodexProviderAdapter({
      buildArgs: ({ session, workspaceDir, prompt }) => buildCodexArgs({ session, workspaceDir, prompt }),
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

  function buildSessionRunnerArgs({ provider, session, workspaceDir, prompt, additionalWorkspaceDirs = [] }) {
    const adapter = providerAdapters.get(provider);
    return adapter.runtime.buildArgs({ session, workspaceDir, prompt, additionalWorkspaceDirs });
  }

  function buildCodexArgs({ session, workspaceDir, prompt }) {
    const modeFlag = session.mode === 'dangerous'
      ? '--dangerously-bypass-approvals-and-sandbox'
      : '--full-auto';

    const model = session.model || defaultModel;
    const effort = session.effort;
    const extraConfigs = session.configOverrides || [];
    const compactSetting = resolveCompactStrategySetting(session);
    const compactEnabled = resolveCompactEnabledSetting(session);
    const nativeLimit = resolveNativeCompactTokenLimitSetting(session);

    const common = [];
    if (model) common.push('-m', model);
    if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
    if (compactSetting.strategy === 'native' && compactEnabled.enabled) {
      common.push('-c', `model_auto_compact_token_limit=${nativeLimit.tokens}`);
    }
    for (const cfg of extraConfigs) common.push('-c', cfg);

    const sessionId = getSessionId(session);
    if (sessionId) {
      return ['exec', 'resume', '--json', modeFlag, ...common, sessionId, prompt];
    }

    return ['exec', '--json', '--skip-git-repo-check', modeFlag, '-C', workspaceDir, ...common, prompt];
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
    const model = session.model || defaultModel;
    const effort = session.effort;
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
    const model = session.model || defaultModel;
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
