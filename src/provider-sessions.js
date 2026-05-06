import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { normalizeProvider } from './provider-metadata.js';

export function listRecentSessions({ provider = 'codex', workspaceDir = '', limit = 10 } = {}) {
  switch (normalizeProvider(provider)) {
    case 'claude':
      return listRecentClaudeSessions(limit, workspaceDir);
    case 'gemini':
      return listRecentGeminiSessions(limit, workspaceDir);
    case 'kiro':
      return listRecentKiroSessions(limit, workspaceDir);
    default:
      return listRecentCodexSessions(limit);
  }
}

function listRecentCodexSessions(limit = 10) {
  const sessionsDir = getCodexSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return [];

  const files = findCodexRolloutFiles(sessionsDir);
  const latestById = new Map();

  for (const file of files) {
    const id = parseSessionIdFromRolloutFile(path.basename(file));
    if (!id) continue;

    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }

    const previous = latestById.get(id);
    if (!previous || mtime > previous.mtime) {
      latestById.set(id, { id, mtime });
    }
  }

  return [...latestById.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

function listRecentClaudeSessions(limit = 10, workspaceDir = '') {
  const preferredRoot = getClaudeProjectDir(workspaceDir);
  const searchRoot = preferredRoot && fs.existsSync(preferredRoot) ? preferredRoot : getClaudeProjectsDir();
  if (!searchRoot || !fs.existsSync(searchRoot)) return [];

  return findClaudeSessionFiles(searchRoot)
    .map((file) => {
      const id = parseClaudeSessionIdFromFile(path.basename(file));
      if (!id) return null;
      try {
        const stat = fs.statSync(file);
        return stat.isFile() ? { id, mtime: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

function listRecentGeminiSessions(limit = 10, workspaceDir = '') {
  const roots = getGeminiSearchRoots(workspaceDir);
  if (!roots.length) return [];

  const latestById = new Map();
  for (const root of roots) {
    for (const file of findGeminiSessionFiles(root)) {
      const snapshot = readGeminiSessionFile(file);
      const id = String(snapshot?.sessionId || '').trim();
      if (!id) continue;

      let mtime = Date.parse(String(snapshot?.lastUpdated || snapshot?.startTime || ''));
      if (!Number.isFinite(mtime)) {
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          mtime = 0;
        }
      }

      const previous = latestById.get(id);
      if (!previous || mtime > previous.mtime) {
        latestById.set(id, { id, mtime });
      }
    }
  }

  return [...latestById.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

function listRecentKiroSessions(limit = 10, workspaceDir = '') {
  const result = spawnSync(getKiroBin(), ['chat', '--list-sessions', '--format', 'json'], {
    cwd: workspaceDir || undefined,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 4000,
  });
  if (result.error || result.status !== 0) return [];

  const ids = parseKiroSessionIds(result.stdout || result.stderr || '');
  return ids
    .slice(0, Math.max(0, limit))
    .map((id, index) => ({ id, mtime: Number.MAX_SAFE_INTEGER - index }));
}

export function findLatestRolloutFileBySessionId(sessionId, notOlderThanMs = 0) {
  const targetId = String(sessionId || '').trim().toLowerCase();
  if (!targetId) return null;

  const sessionsDir = getCodexSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return null;

  const files = findCodexRolloutFiles(sessionsDir);
  let latest = null;

  for (const file of files) {
    const id = parseSessionIdFromRolloutFile(path.basename(file));
    if (!id || String(id).toLowerCase() !== targetId) continue;

    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat?.isFile()) continue;
    if (notOlderThanMs > 0 && stat.mtimeMs < notOlderThanMs) continue;

    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = {
        file,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      };
    }
  }

  return latest;
}

function readFirstJsonLine(filePath, maxBytes = 128 * 1024) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat?.isFile?.()) return null;
      const bytesToRead = Math.max(0, Math.min(stat.size, maxBytes));
      if (bytesToRead <= 0) return null;
      const buf = Buffer.allocUnsafe(bytesToRead);
      const readBytes = fs.readSync(fd, buf, 0, bytesToRead, 0);
      const chunk = buf.toString('utf8', 0, readBytes);
      const line = chunk.split('\n')[0] || '';
      if (!line.trim()) return null;
      return JSON.parse(line);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readFirstJsonLineMatching(filePath, predicate, maxBytes = 512 * 1024) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat?.isFile?.()) return null;
      const bytesToRead = Math.max(0, Math.min(stat.size, maxBytes));
      if (bytesToRead <= 0) return null;
      const buf = Buffer.allocUnsafe(bytesToRead);
      const readBytes = fs.readSync(fd, buf, 0, bytesToRead, 0);
      const chunk = buf.toString('utf8', 0, readBytes);
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (predicate(parsed)) return parsed;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  return null;
}

function extractSessionCwd(line) {
  return String(line?.cwd || line?.payload?.cwd || '').trim();
}

export function readCodexSessionMetaBySessionId(sessionId, notOlderThanMs = 0) {
  const match = findLatestRolloutFileBySessionId(sessionId, notOlderThanMs);
  if (!match?.file) return null;

  const first = readFirstJsonLine(match.file);
  const payload = first && typeof first === 'object' ? first.payload : null;
  const cwd = String(payload?.cwd || '').trim();
  if (!cwd) return null;

  return {
    cwd: path.resolve(cwd),
    file: match.file,
    mtimeMs: Number(match.mtimeMs) || 0,
  };
}

export function findLatestClaudeSessionFileBySessionId(sessionId, workspaceDir = '', notOlderThanMs = 0) {
  const targetId = String(sessionId || '').trim().toLowerCase();
  if (!targetId) return null;

  const roots = [];
  const preferredRoot = getClaudeProjectDir(workspaceDir);
  if (preferredRoot) roots.push(preferredRoot);
  const projectsRoot = getClaudeProjectsDir();
  if (projectsRoot && !roots.includes(projectsRoot)) roots.push(projectsRoot);

  let latest = null;
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const file of findClaudeSessionFiles(root)) {
      const id = parseClaudeSessionIdFromFile(path.basename(file));
      if (!id || String(id).toLowerCase() !== targetId) continue;

      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat?.isFile()) continue;
      if (notOlderThanMs > 0 && stat.mtimeMs < notOlderThanMs) continue;

      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
      }
    }
    if (latest) return latest;
  }

  return latest;
}

export function readClaudeSessionMetaBySessionId(sessionId, workspaceDir = '', notOlderThanMs = 0) {
  const match = findLatestClaudeSessionFileBySessionId(sessionId, workspaceDir, notOlderThanMs);
  if (!match?.file) return null;

  const firstWithCwd = readFirstJsonLineMatching(match.file, (line) => Boolean(extractSessionCwd(line)));
  const cwd = extractSessionCwd(firstWithCwd);
  if (!cwd) return null;

  return {
    cwd: path.resolve(cwd),
    file: match.file,
    mtimeMs: Number(match.mtimeMs) || 0,
  };
}

function findLatestGeminiSessionFileBySessionId(sessionId, workspaceDir = '', notOlderThanMs = 0) {
  const targetId = String(sessionId || '').trim().toLowerCase();
  if (!targetId) return null;

  let latest = null;
  for (const root of getGeminiSearchRoots(workspaceDir)) {
    for (const file of findGeminiSessionFiles(root)) {
      const snapshot = readGeminiSessionFile(file);
      const id = String(snapshot?.sessionId || '').trim().toLowerCase();
      if (!id || id !== targetId) continue;

      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat?.isFile()) continue;
      if (notOlderThanMs > 0 && stat.mtimeMs < notOlderThanMs) continue;

      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
      }
    }
    if (latest) return latest;
  }

  return latest;
}

export function resolveGeminiProjectRootBySessionId(sessionId, workspaceDir = '', notOlderThanMs = 0) {
  const match = findLatestGeminiSessionFileBySessionId(sessionId, workspaceDir, notOlderThanMs);
  if (!match?.file) return null;
  const projectDir = path.dirname(path.dirname(match.file));
  const projectRoot = safeReadText(path.join(projectDir, '.project_root'));
  if (!projectRoot) return null;
  return path.resolve(projectRoot);
}

function getCodexSessionsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  return path.join(home, '.codex', 'sessions');
}

function getGeminiRootDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  return path.join(home, '.gemini');
}

function getGeminiTmpDir() {
  const root = getGeminiRootDir();
  if (!root) return '';
  return path.join(root, 'tmp');
}

function getClaudeProjectsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  return path.join(home, '.claude', 'projects');
}

function getClaudeProjectDir(workspaceDir = '') {
  const projectsRoot = getClaudeProjectsDir();
  const slug = encodeClaudeProjectPath(workspaceDir);
  if (!projectsRoot || !slug) return '';
  return path.join(projectsRoot, slug);
}

function encodeClaudeProjectPath(workspaceDir = '') {
  const raw = String(workspaceDir || '').trim();
  if (!raw) return '';
  return path.resolve(raw).replace(/[\\/]/g, '-');
}

function getGeminiProjectDir(workspaceDir = '') {
  const tmpRoot = getGeminiTmpDir();
  const slug = resolveGeminiProjectSlug(workspaceDir);
  if (!tmpRoot || !slug) return '';
  return path.join(tmpRoot, slug);
}

function resolveGeminiProjectSlug(workspaceDir = '') {
  const raw = String(workspaceDir || '').trim();
  if (!raw) return '';
  const normalizedWorkspace = path.resolve(raw);

  const projects = readGeminiProjectsMap();
  const direct = projects.get(normalizedWorkspace);
  if (direct) return direct;

  const tmpRoot = getGeminiTmpDir();
  if (!tmpRoot || !fs.existsSync(tmpRoot)) return '';
  try {
    const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(tmpRoot, entry.name);
      const projectRootFile = path.join(fullPath, '.project_root');
      const projectRoot = safeReadText(projectRootFile);
      if (projectRoot && path.resolve(projectRoot) === normalizedWorkspace) {
        return entry.name;
      }
    }
  } catch {
  }

  return '';
}

function readGeminiProjectsMap() {
  const file = path.join(getGeminiRootDir(), 'projects.json');
  const parsed = readJsonFile(file);
  const projects = parsed?.projects && typeof parsed.projects === 'object' ? parsed.projects : {};
  const out = new Map();
  for (const [workspacePath, slug] of Object.entries(projects)) {
    const normalizedWorkspace = String(workspacePath || '').trim();
    const normalizedSlug = String(slug || '').trim();
    if (!normalizedWorkspace || !normalizedSlug) continue;
    out.set(path.resolve(normalizedWorkspace), normalizedSlug);
  }
  return out;
}

function getGeminiSearchRoots(workspaceDir = '') {
  const roots = [];
  const preferredRoot = getGeminiProjectDir(workspaceDir);
  if (preferredRoot && fs.existsSync(preferredRoot)) roots.push(preferredRoot);

  const tmpRoot = getGeminiTmpDir();
  if (!tmpRoot || !fs.existsSync(tmpRoot)) return roots;

  try {
    const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(tmpRoot, entry.name);
      if (!fs.existsSync(path.join(fullPath, '.project_root'))) continue;
      if (!roots.includes(fullPath)) roots.push(fullPath);
    }
  } catch {
  }

  return roots;
}

function getKiroBin() {
  return String(process.env.KIRO_BIN || 'kiro').trim() || 'kiro';
}

function parseKiroSessionIds(raw) {
  const text = stripAnsiControl(String(raw || '')).trim();
  if (!text) return [];

  const fromJson = parseKiroSessionIdsFromJson(text);
  if (fromJson.length) return fromJson;

  const uuidMatches = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig);
  return dedupeKeepOrder(uuidMatches || []);
}

function parseKiroSessionIdsFromJson(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return collectKiroSessionIdsFromJson(parsed);
}

function collectKiroSessionIdsFromJson(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return dedupeKeepOrder(value.flatMap((item) => collectKiroSessionIdsFromJson(item)));
  }
  if (typeof value !== 'object') return [];

  const direct = String(value.sessionId || value.session_id || value.id || '').trim();
  if (direct) return [direct];

  const nested = [];
  if (Array.isArray(value.sessions)) {
    nested.push(...value.sessions.flatMap((item) => collectKiroSessionIdsFromJson(item)));
  }
  return dedupeKeepOrder(nested);
}

function dedupeKeepOrder(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function stripAnsiControl(value) {
  return String(value || '')
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '');
}

function findFilesRecursive(root, predicate) {
  const out = [];
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && predicate(entry.name, fullPath)) {
        out.push(fullPath);
      }
    }
  }

  return out;
}

function findCodexRolloutFiles(root) {
  return findFilesRecursive(root, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
}

function findClaudeSessionFiles(root) {
  return findFilesRecursive(root, (name) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i.test(name));
}

function findGeminiSessionFiles(root) {
  const chatsDir = path.join(root, 'chats');
  if (!fs.existsSync(chatsDir)) return [];
  return findFilesRecursive(chatsDir, (name) => /^session-.*\.json$/i.test(name));
}

function parseSessionIdFromRolloutFile(filename) {
  const match = filename.match(/^rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
}

function parseClaudeSessionIdFromFile(filename) {
  const match = String(filename || '').match(/^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function readGeminiSessionFile(filePath) {
  return readJsonFile(filePath);
}

export function readGeminiSessionState({ sessionId, workspaceDir = '' } = {}) {
  const match = findLatestGeminiSessionFileBySessionId(sessionId, workspaceDir);
  if (!match?.file) return null;

  const snapshot = readGeminiSessionFile(match.file);
  if (!snapshot || typeof snapshot !== 'object') return null;

  const assistantMessages = Array.isArray(snapshot.messages)
    ? snapshot.messages
      .filter((item) => item && typeof item === 'object' && String(item.type || '').trim().toLowerCase() === 'gemini')
      .map((item) => String(item.content || '').trim())
      .filter(Boolean)
    : [];

  const finalAnswer = assistantMessages.at(-1) || '';
  const messages = finalAnswer ? assistantMessages.slice(0, -1) : assistantMessages;
  const lastAssistant = Array.isArray(snapshot.messages)
    ? [...snapshot.messages].reverse().find((item) => item && typeof item === 'object' && String(item.type || '').trim().toLowerCase() === 'gemini')
    : null;

  return {
    messages,
    finalAnswer,
    usage: lastAssistant?.tokens && typeof lastAssistant.tokens === 'object' ? lastAssistant.tokens : null,
    file: match.file,
  };
}
