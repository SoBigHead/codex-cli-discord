import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTECTED_SERVICE_LABELS = Object.freeze([
  'com.atou.agents-in-discord',
  'com.atou.agents-in-discord.claude',
  'com.atou.agents-in-discord.gemini',
  'com.atou.agents-in-discord.kiro',
  'com.atou.codex-discord-bot',
  'com.atou.codex-discord-bot.claude',
  'com.atou.codex-discord-bot.gemini',
  'com.atou.codex-discord-bot.kiro',
]);

const PROTECTED_SERVICE_LABEL_SET = new Set(PROTECTED_SERVICE_LABELS);
const SAFE_RESTART_VERBS = new Set(['bootout', 'bootstrap']);
const BLOCKED_VERBS = new Set(['remove', 'disable', 'unload', 'load', 'kill']);

export function getLaunchctlGuardBinDir() {
  const __filename = fileURLToPath(import.meta.url);
  const srcDir = path.dirname(__filename);
  return path.resolve(srcDir, '..', 'scripts', 'guard-bin');
}

export function getSafeRestartScriptPath() {
  const __filename = fileURLToPath(import.meta.url);
  const srcDir = path.dirname(__filename);
  return path.resolve(srcDir, '..', 'scripts', 'restart-discord-bot-service.sh');
}

export function extractProtectedServiceLabels(argv = []) {
  const found = new Set();

  for (const arg of argv) {
    for (const candidate of extractLabelCandidates(arg)) {
      if (PROTECTED_SERVICE_LABEL_SET.has(candidate)) {
        found.add(candidate);
      }
    }
  }

  return [...found];
}

export function classifyLaunchctlInvocation(argv = []) {
  const args = Array.isArray(argv) ? argv.filter((value) => value !== undefined && value !== null).map(String) : [];
  const verb = findLaunchctlVerb(args);
  const protectedLabels = extractProtectedServiceLabels(args);

  if (!verb || protectedLabels.length === 0) {
    return {
      action: 'passthrough',
      args,
      protectedLabels,
      verb,
    };
  }

  if (SAFE_RESTART_VERBS.has(verb) && protectedLabels.length === 1) {
    return {
      action: 'rewrite-safe-restart',
      args,
      protectedLabels,
      targetLabel: protectedLabels[0],
      verb,
    };
  }

  if (SAFE_RESTART_VERBS.has(verb) && protectedLabels.length > 1) {
    return {
      action: 'block',
      args,
      protectedLabels,
      verb,
      reason: 'launchctl restart flow targeted multiple protected bot services in one command',
    };
  }

  if (BLOCKED_VERBS.has(verb)) {
    return {
      action: 'block',
      args,
      protectedLabels,
      targetLabel: protectedLabels[0] || null,
      verb,
      reason: `launchctl ${verb} would unload or disable a protected bot service`,
    };
  }

  return {
    action: 'passthrough',
    args,
    protectedLabels,
    verb,
  };
}

function findLaunchctlVerb(args) {
  for (const arg of args) {
    const trimmed = String(arg || '').trim();
    if (!trimmed || trimmed.startsWith('-')) continue;
    return trimmed.toLowerCase();
  }
  return '';
}

function extractLabelCandidates(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const lower = raw.toLowerCase();
  const candidates = new Set([lower]);

  const slashParts = lower.split('/').filter(Boolean);
  if (slashParts.length) {
    candidates.add(slashParts.at(-1));
  }

  const posixBase = path.posix.basename(lower);
  const nativeBase = path.basename(lower);
  for (const base of [posixBase, nativeBase]) {
    if (!base) continue;
    candidates.add(base);
    if (base.endsWith('.plist')) {
      candidates.add(base.slice(0, -'.plist'.length));
    }
  }

  return [...candidates];
}
