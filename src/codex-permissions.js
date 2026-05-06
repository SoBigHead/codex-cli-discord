const CODEX_DANGEROUS_PERMISSION_ARGS = Object.freeze([
  '--dangerously-bypass-approvals-and-sandbox',
]);

const CODEX_SAFE_FRESH_PERMISSION_ARGS = Object.freeze([
  '--sandbox',
  'workspace-write',
  '-c',
  'approval_policy="on-request"',
]);

const CODEX_SAFE_RESUME_PERMISSION_ARGS = Object.freeze([
  '-c',
  'sandbox_mode="workspace-write"',
  '-c',
  'approval_policy="on-request"',
]);

export function buildCodexPermissionArgs(mode, { resume = false } = {}) {
  return mode === 'dangerous'
    ? [...CODEX_DANGEROUS_PERMISSION_ARGS]
    : [...(resume ? CODEX_SAFE_RESUME_PERMISSION_ARGS : CODEX_SAFE_FRESH_PERMISSION_ARGS)];
}

export function formatCodexPermissionsLabel(mode, language = 'en') {
  if (mode === 'dangerous') {
    return language === 'en'
      ? 'full access (--dangerously-bypass-approvals-and-sandbox)'
      : '完全权限（--dangerously-bypass-approvals-and-sandbox）';
  }
  return language === 'en'
    ? 'sandboxed with on-request approvals (workspace-write)'
    : '沙盒模式（workspace-write，approval_policy=on-request）';
}
