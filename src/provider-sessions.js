import fs from 'node:fs';
import path from 'node:path';

import { normalizeProvider } from './provider-metadata.js';

export function listRecentSessions({ provider = 'codex', workspaceDir = '', limit = 10 } = {}) {
  switch (normalizeProvider(provider)) {
    case 'claude':
      return listRecentClaudeSessions(limit, workspaceDir);
    case 'antigravity':
      return listRecentAntigravitySessions(limit, workspaceDir);
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

function listRecentAntigravitySessions(limit = 10, workspaceDir = '') {
  const antigravityConversation = readAntigravityLastConversation(workspaceDir);
  if (antigravityConversation?.id) {
    return [{
      id: antigravityConversation.id,
      mtime: antigravityConversation.mtime,
    }];
  }

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

export function buildClaudeSessionRescueSummary({
  sessionId,
  workspaceDir = '',
  maxTaskItems = 24,
  maxAssistantItems = 8,
} = {}) {
  const match = findLatestClaudeSessionFileBySessionId(sessionId, workspaceDir);
  if (!match?.file) {
    return { ok: false, error: 'claude session file not found', summary: '' };
  }

  const rows = readJsonLines(match.file);
  if (!rows.length) {
    return { ok: false, error: 'claude session file is empty', summary: '' };
  }

  const taskResults = [];
  const assistantNotes = [];
  const errors = [];
  let lastPrompt = '';

  for (const row of rows) {
    if (row?.type === 'last-prompt') {
      const prompt = normalizeOneLine(row.lastPrompt || '');
      if (prompt) lastPrompt = prompt;
      continue;
    }

    if (row?.type === 'user') {
      const text = extractClaudeRowText(row);
      const prompt = normalizeOneLine(text);
      if (prompt && !prompt.includes('<task-notification>') && !prompt.includes('请压缩总结当前会话上下文')) {
        lastPrompt = prompt;
      }
      const task = extractTaskNotification(text);
      if (task) taskResults.push(task);
      continue;
    }

    if (row?.type !== 'assistant') continue;
    const text = extractClaudeRowText(row);
    const normalized = normalizeOneLine(text);
    if (!normalized) continue;
    if (row.isApiErrorMessage || normalized.includes('context window limit') || normalized.includes('API Error')) {
      errors.push(normalized);
      continue;
    }
    assistantNotes.push(normalized);
  }

  const recentTasks = taskResults.slice(-Math.max(1, maxTaskItems));
  const recentAssistantNotes = assistantNotes.slice(-Math.max(1, maxAssistantItems));
  if (!recentTasks.length && !recentAssistantNotes.length && !lastPrompt) {
    return { ok: false, error: 'no compactable Claude session content found', summary: '' };
  }

  const completedTasks = taskResults.filter((item) => item.status === 'completed').length;
  const failedTasks = taskResults.filter((item) => item.status && item.status !== 'completed').length;
  const lines = [
    `目标：延续 Claude project session ${sessionId} 的工作。该 session 已超过上下文窗，以下摘要从本地 session 文件救援提取，不是模型原生压缩。`,
    lastPrompt ? `最近用户意图：${truncateText(lastPrompt, 260)}` : '',
    `进展概览：本地记录中识别到 ${taskResults.length} 个任务通知，其中完成 ${completedTasks} 个${failedTasks ? `，非完成 ${failedTasks} 个` : ''}。`,
    recentTasks.length ? '最近任务结果：' : '',
    ...recentTasks.map((item) => {
      const parts = [
        item.summary || item.id || '未命名任务',
        item.status ? `状态 ${item.status}` : '',
        item.outputFile ? `输出 ${item.outputFile}` : '',
        item.result ? truncateText(item.result, 220) : '',
      ].filter(Boolean);
      return `- ${parts.join('；')}`;
    }),
    recentAssistantNotes.length ? '最近可见回复：' : '',
    ...recentAssistantNotes.map((note) => `- ${truncateText(note, 220)}`),
    errors.length ? `风险与约束：最近出现 ${errors.length} 次 API/context 错误，最新错误是 ${truncateText(errors[errors.length - 1], 180)}。后续必须使用新 session 继续，不能再 resume 旧 session。` : '风险与约束：旧 session 已接近或超过上下文窗，后续必须使用新 session 继续。',
    '下一步建议：从最近用户意图继续；如果是在批量报告任务中，先盘点已生成目录和失败项，再用小批次继续，避免把完整历史和大量 task-notification 重新塞回上下文。',
  ].filter(Boolean);

  return {
    ok: true,
    summary: truncateText(lines.join('\n'), 6000),
    sourceFile: match.file,
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

export function resolveAntigravityProjectRootBySessionId(sessionId, workspaceDir = '', notOlderThanMs = 0) {
  const antigravityConversation = readAntigravityLastConversation(workspaceDir);
  if (antigravityConversation?.id && antigravityConversation.id === String(sessionId || '').trim()) {
    return path.resolve(workspaceDir);
  }

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

function getAntigravityCliDir() {
  const root = getGeminiRootDir();
  if (!root) return '';
  return path.join(root, 'antigravity-cli');
}

function readAntigravityLastConversation(workspaceDir = '', notOlderThanMs = 0) {
  const rawWorkspace = String(workspaceDir || '').trim();
  if (!rawWorkspace) return null;

  const cliDir = getAntigravityCliDir();
  if (!cliDir) return null;

  const file = path.join(cliDir, 'cache', 'last_conversations.json');
  const parsed = readJsonFile(file);
  if (!parsed || typeof parsed !== 'object') return null;

  const normalizedWorkspace = path.resolve(rawWorkspace);
  const directId = String(parsed[normalizedWorkspace] || parsed[rawWorkspace] || '').trim();
  if (!directId) return null;

  let mtime = Date.now();
  try {
    const stat = fs.statSync(file);
    if (stat?.isFile()) mtime = stat.mtimeMs;
  } catch {
  }
  if (notOlderThanMs > 0 && mtime < notOlderThanMs) return null;

  return {
    id: directId,
    mtime,
    file,
  };
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

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        try {
          return JSON.parse(trimmed);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractClaudeRowText(row) {
  const parts = [];
  collectTextParts(row?.message, parts);
  collectTextParts(row?.content, parts);
  return parts.join('\n\n').trim();
}

function collectTextParts(value, out) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextParts(item, out);
    return;
  }
  if (typeof value !== 'object') return;
  const type = String(value.type || '').trim().toLowerCase();
  if (type === 'thinking' || type === 'tool_use') return;
  collectTextParts(value.text, out);
  collectTextParts(value.result, out);
  collectTextParts(value.content, out);
}

function extractTaskNotification(text) {
  const raw = String(text || '');
  if (!raw.includes('<task-notification>')) return null;
  return {
    id: extractTag(raw, 'task-id'),
    status: extractTag(raw, 'status'),
    summary: extractTag(raw, 'summary'),
    outputFile: extractTag(raw, 'output-file'),
    result: normalizeOneLine(stripMarkdown(extractTag(raw, 'result'))),
  };
}

function extractTag(text, tag) {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  return String(text.match(pattern)?.[1] || '').trim();
}

function normalizeOneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/[*_`#>]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1');
}

function truncateText(value, maxChars) {
  const text = String(value || '').trim();
  const max = Math.max(20, Number(maxChars) || 200);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
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

export function readAntigravitySessionState({ sessionId, workspaceDir = '', notOlderThanMs = 0 } = {}) {
  const antigravityConversation = readAntigravityLastConversation(workspaceDir, notOlderThanMs);
  if (antigravityConversation?.id && (!sessionId || antigravityConversation.id === String(sessionId || '').trim())) {
    return {
      sessionId: antigravityConversation.id,
      messages: [],
      finalAnswer: '',
      usage: null,
      file: antigravityConversation.file,
    };
  }

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
    sessionId: String(snapshot?.sessionId || sessionId || '').trim() || null,
    messages,
    finalAnswer,
    usage: lastAssistant?.tokens && typeof lastAssistant.tokens === 'object' ? lastAssistant.tokens : null,
    file: match.file,
  };
}

export const resolveGeminiProjectRootBySessionId = resolveAntigravityProjectRootBySessionId;
export const readGeminiSessionState = readAntigravitySessionState;
