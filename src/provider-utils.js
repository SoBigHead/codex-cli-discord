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
  extraConfigs = [],
  compactStrategy = 'native',
  compactOnThreshold = true,
  modelAutoCompactTokenLimit = 0,
} = {}) {
  const normalizedProvider = normalizeCliProvider(provider);
  if (normalizedProvider === 'claude') {
    return buildClaudeArgs({
      sessionId,
      prompt,
      mode,
      model,
      effort,
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
  extraConfigs,
  compactStrategy,
  compactOnThreshold,
  modelAutoCompactTokenLimit,
}) {
  const modeFlag = mode === 'dangerous'
    ? '--dangerously-bypass-approvals-and-sandbox'
    : '--full-auto';

  const common = [];
  if (model) common.push('-m', model);
  if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
  if (compactStrategy === 'native' && compactOnThreshold) {
    common.push('-c', `model_auto_compact_token_limit=${modelAutoCompactTokenLimit}`);
  }
  for (const cfg of extraConfigs || []) common.push('-c', cfg);

  if (sessionId) {
    return ['exec', 'resume', '--json', modeFlag, ...common, sessionId, prompt];
  }

  return ['exec', '--json', '--skip-git-repo-check', modeFlag, '-C', workspaceDir, ...common, prompt];
}

function buildClaudeArgs({
  sessionId,
  prompt,
  mode,
  model,
  effort,
}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

  if (mode === 'dangerous') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }

  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (sessionId) args.push('--resume', sessionId);

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
