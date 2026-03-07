import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionStore } from '../src/session-store.js';

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase() === 'claude' ? 'claude' : 'codex';
}

function normalizeUiLanguage(value) {
  return String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh';
}

function normalizeSessionSecurityProfile(value) {
  return ['auto', 'solo', 'team', 'public'].includes(value) ? value : null;
}

function normalizeSessionTimeoutMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n <= 0 ? 0 : Math.floor(n);
}

function normalizeSessionProcessLines(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return n;
}

function normalizeSessionCompactStrategy(value) {
  if (value === null || value === undefined || value === '') return null;
  return ['hard', 'native', 'off'].includes(value) ? value : 'hard';
}

function normalizeSessionCompactEnabled(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  return null;
}

function normalizeSessionCompactTokenLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

test('createSessionStore creates provider-locked default session and persists workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    botProvider: 'claude',
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionProcessLines,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const session = store.getSession('thread-1');
  assert.equal(session.provider, 'claude');
  assert.equal(session.mode, 'safe');
  assert.equal(session.language, 'zh');
  assert.equal(session.onboardingEnabled, true);

  const workspaceDir = store.ensureWorkspace(session, 'thread-1');
  assert.equal(workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(fs.existsSync(workspaceDir), true);

  session.model = 'claude-sonnet';
  store.saveDb();
  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(saved.threads['thread-1'].provider, 'claude');
  assert.equal(saved.threads['thread-1'].model, 'claude-sonnet');
});
