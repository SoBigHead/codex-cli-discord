import {
  normalizeProvider as normalizeCliProvider,
  getProviderDisplayName,
  getProviderShortName,
  providerSupportsRawConfigOverrides,
  providerSupportsConfigOverrides,
  getProviderCompactCapabilities,
  providerSupportsCompactStrategy,
  providerSupportsNativeCompact,
} from './provider-metadata.js';
import { buildCodexPermissionArgs } from './codex-permissions.js';

export {
  normalizeCliProvider,
  getProviderDisplayName,
  getProviderShortName,
  providerSupportsRawConfigOverrides,
  providerSupportsConfigOverrides,
  getProviderCompactCapabilities,
  providerSupportsCompactStrategy,
  providerSupportsNativeCompact,
};

export function buildRunnerArgs({
  provider,
  sessionId,
  workspaceDir,
  prompt,
  mode = 'safe',
  model = null,
  effort = null,
  fastMode = null,
  extraConfigs = [],
  compactStrategy = 'native',
  compactOnThreshold = true,
  modelAutoCompactTokenLimit = 0,
  pendingForkFromSessionId = null,
} = {}) {
  const normalizedProvider = normalizeCliProvider(provider);
  if (normalizedProvider === 'claude') {
    return buildClaudeArgs({
      sessionId,
      prompt,
      mode,
      model,
      effort,
      pendingForkFromSessionId,
    });
  }
  if (normalizedProvider === 'gemini') {
    return buildGeminiArgs({
      sessionId,
      prompt,
      mode,
      model,
    });
  }

  return buildCodexArgs({
    sessionId,
    workspaceDir,
    prompt,
    mode,
    model,
    effort,
    fastMode,
    extraConfigs,
    compactStrategy,
    compactOnThreshold,
    modelAutoCompactTokenLimit,
  });
}

function buildCodexArgs({
  sessionId,
  workspaceDir,
  prompt,
  mode,
  model,
  effort,
  fastMode,
  extraConfigs,
  compactStrategy,
  compactOnThreshold,
  modelAutoCompactTokenLimit,
}) {
  const common = [];
  if (model) common.push('-m', model);
  if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
  if (typeof fastMode === 'boolean') {
    common.push('-c', `features.fast_mode=${fastMode ? 'true' : 'false'}`);
  }
  if (compactStrategy === 'native' && compactOnThreshold) {
    common.push('-c', `model_auto_compact_token_limit=${modelAutoCompactTokenLimit}`);
  }
  for (const cfg of extraConfigs || []) common.push('-c', cfg);

  if (sessionId) {
    return ['exec', 'resume', '--json', ...buildCodexPermissionArgs(mode, { resume: true }), ...common, sessionId, prompt];
  }

  return ['exec', '--json', '--skip-git-repo-check', ...buildCodexPermissionArgs(mode, { resume: false }), '-C', workspaceDir, ...common, prompt];
}

function buildClaudeArgs({
  sessionId,
  prompt,
  mode,
  model,
  effort,
  pendingForkFromSessionId,
}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

  if (mode === 'dangerous') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }

  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (pendingForkFromSessionId) {
    args.push('--resume', pendingForkFromSessionId, '--fork-session');
    if (sessionId) args.push('--session-id', sessionId);
  } else if (sessionId) {
    args.push('--resume', sessionId);
  }

  args.push('--allowedTools', 'default', '--', prompt);
  return args;
}

function buildGeminiArgs({
  sessionId,
  prompt,
  mode,
  model,
}) {
  const args = ['--output-format', 'stream-json'];

  if (mode === 'dangerous') {
    args.push('--yolo');
  } else {
    args.push('--sandbox', '--approval-mode', 'default');
  }

  if (model) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);
  args.push('--prompt', prompt);
  return args;
}
