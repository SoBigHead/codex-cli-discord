import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { uniqueDirs } from './runner-args.js';

function collectClaudeTextParts(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectClaudeTextParts(item));
  }
  if (typeof value !== 'object') return [];

  const type = String(value.type || '').trim().toLowerCase();
  if (type === 'tool_use' || type === 'tool_result' || type === 'server_tool_use' || type === 'thinking') {
    return [];
  }

  return [
    ...collectClaudeTextParts(value.text),
    ...collectClaudeTextParts(value.output_text),
    ...collectClaudeTextParts(value.input_text),
    ...collectClaudeTextParts(value.reasoning_text),
    ...collectClaudeTextParts(value.message),
    ...collectClaudeTextParts(value.content),
    ...collectClaudeTextParts(value.result),
  ];
}

function extractClaudeText(event) {
  return collectClaudeTextParts([
    event?.text,
    event?.message,
    event?.content,
    event?.result,
  ]).join('\n\n').trim();
}

function extractSessionId(event) {
  return String(
    event?.session_id
    || event?.sessionId
    || event?.thread_id
    || '',
  ).trim() || null;
}

function buildClaudeLongArgs({
  session,
  workspaceDir,
  additionalWorkspaceDirs = [],
  sessionId,
  pendingForkFromSessionId = null,
  resolveModelSetting,
  resolveReasoningEffortSetting,
}) {
  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
  ];

  for (const dir of uniqueDirs([workspaceDir, ...additionalWorkspaceDirs])) {
    args.push('--add-dir', dir);
  }

  const model = resolveModelSetting(session).value;
  const effort = resolveReasoningEffortSetting(session).value;
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);

  if (session?.mode === 'dangerous') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }

  const forkFromSessionId = String(pendingForkFromSessionId || '').trim();
  if (forkFromSessionId) {
    args.push('--resume', forkFromSessionId, '--fork-session');
    if (!sessionId) sessionId = randomUUID();
    args.push('--session-id', sessionId);
  } else if (sessionId) {
    args.push('--resume', sessionId);
  } else {
    sessionId = randomUUID();
    args.push('--session-id', sessionId);
  }

  args.push('--allowedTools', 'default');
  return { args, sessionId };
}

function buildRuntimeSignature({
  session,
  workspaceDir,
  additionalWorkspaceDirs = [],
  resolveModelSetting,
  resolveReasoningEffortSetting,
}) {
  return JSON.stringify({
    workspaceDir,
    additionalWorkspaceDirs: uniqueDirs(additionalWorkspaceDirs),
    mode: session?.mode || 'safe',
    model: resolveModelSetting(session).value || null,
    effort: resolveReasoningEffortSetting(session).value || null,
  });
}

function formatError(err) {
  return String(err?.message || err || 'unknown error');
}

function formatLogValue(value) {
  const text = String(value ?? '').trim();
  return text || 'none';
}

function formatArgs(args) {
  return JSON.stringify(args);
}

function composePromptWithSystemFallback(prompt, systemPrompt) {
  const systemText = String(systemPrompt || '').trim();
  if (!systemText) return String(prompt || '');
  return [
    systemText,
    '',
    String(prompt || ''),
  ].join('\n');
}

function formatClaudeApiRetry(event) {
  if (event?.type !== 'system' || event?.subtype !== 'api_retry') return '';
  const status = event.error_status || event.status || '';
  const error = String(event.error || event.message || '').trim();
  const attempt = event.attempt ?? null;
  const maxRetries = event.max_retries ?? event.maxRetries ?? null;
  const retryMs = event.retry_delay_ms ?? event.retryDelayMs ?? null;
  const parts = [
    'Claude API retry',
    status ? `status=${status}` : null,
    error ? `error=${error}` : null,
    attempt !== null ? `attempt=${attempt}` : null,
    maxRetries !== null ? `maxRetries=${maxRetries}` : null,
    retryMs !== null ? `retryDelayMs=${Math.round(Number(retryMs) || 0)}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

function logClaudeLongEvent(log, event, fields = {}) {
  if (typeof log !== 'function') return;
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(' ');
  log(`[claude-long] ${event}${detail ? ` ${detail}` : ''}`);
}

export function createClaudeLongRunner({
  spawnEnv = process.env,
  getProviderBin = () => 'claude',
  getSessionId = () => null,
  resolveModelSetting = () => ({ value: null }),
  resolveReasoningEffortSetting = () => ({ value: null }),
  normalizeTimeoutMs = (value, fallback) => Number(value || fallback || 0),
  resolveTimeoutSetting = () => ({ timeoutMs: 0 }),
  safeError = formatError,
  stopChildProcess = (child) => child?.kill?.('SIGTERM'),
  idleMs = 15 * 60_000,
  maxSessions = 8,
  spawnFn = spawn,
  log = (message) => console.log(message),
} = {}) {
  const entries = new Map();

  function closeEntry(entry, reason = 'closed') {
    if (!entry || entry.closed) return false;
    logClaudeLongEvent(log, 'close', {
      key: entry.key,
      pid: entry.child?.pid ?? null,
      sessionId: entry.sessionId,
      reason,
      active: Boolean(entry.currentTurn),
    });
    entry.closed = true;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.currentTurn) {
      const turn = entry.currentTurn;
      entry.currentTurn = null;
      if (turn.timeout) clearTimeout(turn.timeout);
      turn.resolve({
        ok: false,
        cancelled: Boolean(turn.wasCancelled?.()),
        timedOut: Boolean(turn.timedOut),
        error: reason,
        logs: turn.logs,
        messages: turn.messages,
        finalAnswerMessages: turn.finalAnswerMessages,
        reasonings: turn.reasonings,
        usage: turn.usage,
        threadId: turn.threadId || entry.sessionId,
      });
    }
    try {
      stopChildProcess(entry.child);
    } catch {
      try { entry.child?.kill?.('SIGTERM'); } catch {}
    }
    entries.delete(entry.key);
    return true;
  }

  function scheduleIdleClose(entry) {
    if (idleMs <= 0 || entry.closed) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    logClaudeLongEvent(log, 'idle-scheduled', {
      key: entry.key,
      pid: entry.child?.pid ?? null,
      sessionId: entry.sessionId,
      idleMs,
    });
    entry.idleTimer = setTimeout(() => {
      if (!entry.currentTurn) closeEntry(entry, 'idle timeout');
    }, idleMs);
    entry.idleTimer.unref?.();
  }

  function evictIfNeeded() {
    if (entries.size < maxSessions) return;
    let oldest = null;
    for (const entry of entries.values()) {
      if (entry.currentTurn) continue;
      if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) oldest = entry;
    }
    if (!oldest) {
      throw new Error('all Claude long sessions are busy');
    }
    closeEntry(oldest, 'evicted');
  }

  function attachLineHandlers(entry) {
    const rl = createInterface({ input: entry.child.stdout });
    entry.readline = rl;

    const handleLine = (line, source = 'stdout') => {
      const raw = String(line || '').trim();
      if (!raw) return;
      const turn = entry.currentTurn;
      if (source === 'stderr') {
        if (turn) {
          turn.logs.push(raw);
          turn.onLog?.(raw, 'stderr');
        }
        return;
      }

      let event = null;
      try {
        event = JSON.parse(raw);
      } catch {
        if (turn) {
          turn.logs.push(raw);
          turn.onLog?.(raw, 'stdout');
        }
        return;
      }

      if (turn) turn.onEvent?.(event);
      const nextSessionId = extractSessionId(event);
      if (nextSessionId) {
        entry.sessionId = nextSessionId;
        if (turn) turn.threadId = nextSessionId;
      }

      if (!turn) return;

      const retryLog = formatClaudeApiRetry(event);
      if (retryLog) {
        turn.logs.push(retryLog);
        return;
      }

      if (event.type === 'assistant') {
        const text = extractClaudeText(event);
        if (text) turn.responseText += `${turn.responseText ? '\n\n' : ''}${text}`;
        return;
      }

      if (event.type !== 'result') return;

      if (event.usage) turn.usage = event.usage;
      const resultText = extractClaudeText(event);
      const finalText = (turn.responseText || resultText || '').trim();
      if (finalText) turn.finalAnswerMessages.push(finalText);

      if (turn.timeout) clearTimeout(turn.timeout);
      entry.currentTurn = null;
      entry.lastUsedAt = Date.now();
      scheduleIdleClose(entry);

      const errors = Array.isArray(event.errors) ? event.errors.join('\n') : '';
      logClaudeLongEvent(log, 'result', {
        key: entry.key,
        pid: entry.child?.pid ?? null,
        sessionId: entry.sessionId,
        ok: !event.is_error,
        usageInputTokens: event.usage?.input_tokens ?? event.usage?.inputTokens ?? null,
      });
      turn.resolve({
        ok: !event.is_error,
        cancelled: Boolean(turn.wasCancelled?.()),
        timedOut: false,
        error: event.is_error ? (errors || resultText || turn.logs.at(-1) || 'Claude long runner returned an error') : '',
        logs: turn.logs,
        messages: turn.messages,
        finalAnswerMessages: turn.finalAnswerMessages,
        reasonings: turn.reasonings,
        usage: turn.usage,
        threadId: turn.threadId || entry.sessionId,
      });
    };

    rl.on('line', (line) => handleLine(line, 'stdout'));
    entry.child.stderr?.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) handleLine(line, 'stderr');
    });
    entry.child.on('close', (code, signal) => {
      if (entry.closed) return;
      const turn = entry.currentTurn;
      logClaudeLongEvent(log, 'process-close', {
        key: entry.key,
        pid: entry.child?.pid ?? null,
        sessionId: entry.sessionId,
        code,
        signal,
        active: Boolean(turn),
      });
      entry.closed = true;
      entries.delete(entry.key);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (!turn) return;
      entry.currentTurn = null;
      if (turn.timeout) clearTimeout(turn.timeout);
      turn.resolve({
        ok: false,
        cancelled: Boolean(turn.wasCancelled?.()),
        timedOut: Boolean(turn.timedOut),
        error: turn.timedOut
          ? `Claude long runner timed out`
          : `Claude long runner exited${signal ? ` via signal ${signal}` : ` with code ${code}`}`,
        logs: turn.logs,
        messages: turn.messages,
        finalAnswerMessages: turn.finalAnswerMessages,
        reasonings: turn.reasonings,
        usage: turn.usage,
        threadId: turn.threadId || entry.sessionId,
      });
    });
    entry.child.on('error', (err) => {
      const turn = entry.currentTurn;
      if (!turn) return;
      turn.logs.push(safeError(err));
    });
  }

  function getOrCreateEntry({ key, session, workspaceDir, additionalWorkspaceDirs = [] }) {
    const requestedSessionId = getSessionId(session);
    const signature = buildRuntimeSignature({
      session,
      workspaceDir,
      additionalWorkspaceDirs,
      resolveModelSetting,
      resolveReasoningEffortSetting,
    });
    const existing = entries.get(key);
    if (existing) {
      const currentSessionId = requestedSessionId || null;
      const existingSessionId = existing.sessionId || null;
      if (existing.signature === signature && currentSessionId === existingSessionId) {
        existing.lastUsedAt = Date.now();
        if (existing.idleTimer) {
          clearTimeout(existing.idleTimer);
          existing.idleTimer = null;
        }
        logClaudeLongEvent(log, 'reuse', {
          key,
          pid: existing.child?.pid ?? null,
          sessionId: existing.sessionId,
        });
        return existing;
      }
      closeEntry(existing, 'runtime config changed');
    }

    evictIfNeeded();

    const { args, sessionId: initialSessionId } = buildClaudeLongArgs({
      session,
      workspaceDir,
      additionalWorkspaceDirs,
      sessionId: requestedSessionId,
      pendingForkFromSessionId: session?.pendingForkFromSessionId,
      resolveModelSetting,
      resolveReasoningEffortSetting,
    });
    const child = spawnFn(getProviderBin('claude'), args, {
      cwd: workspaceDir,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const entry = {
      key,
      child,
      args,
      signature,
      sessionId: initialSessionId || requestedSessionId || null,
      currentTurn: null,
      idleTimer: null,
      lastUsedAt: Date.now(),
      closed: false,
    };
    entries.set(key, entry);
    attachLineHandlers(entry);
    logClaudeLongEvent(log, 'spawn', {
      key,
      pid: child.pid ?? null,
      sessionId: entry.sessionId,
      cwd: workspaceDir,
      mode: 'stream-json-stdin',
      dashP: 'false',
      args: formatArgs(args),
    });
    return entry;
  }

  async function runTask({
    session,
    sessionKey,
    workspaceDir,
    prompt,
    systemPrompt = '',
    additionalWorkspaceDirs = [],
    onSpawn,
    wasCancelled,
    onEvent,
    onLog,
  }) {
    const key = String(sessionKey || workspaceDir || '').trim();
    if (!key) {
      return {
        ok: false,
        cancelled: false,
        timedOut: false,
        error: 'missing Claude long session key',
        logs: [],
        messages: [],
        finalAnswerMessages: [],
        reasonings: [],
        usage: null,
        threadId: null,
      };
    }

    let entry;
    try {
      entry = getOrCreateEntry({ key, session, workspaceDir, additionalWorkspaceDirs });
    } catch (err) {
      return {
        ok: false,
        cancelled: false,
        timedOut: false,
        error: safeError(err),
        logs: [],
        messages: [],
        finalAnswerMessages: [],
        reasonings: [],
        usage: null,
        threadId: null,
      };
    }

    if (entry.currentTurn) {
      return {
        ok: false,
        cancelled: false,
        timedOut: false,
        error: 'Claude long session already has an active turn',
        logs: [],
        messages: [],
        finalAnswerMessages: [],
        reasonings: [],
        usage: null,
        threadId: entry.sessionId,
      };
    }

    onSpawn?.(entry.child);
    logClaudeLongEvent(log, 'turn-start', {
      key,
      pid: entry.child?.pid ?? null,
      sessionId: entry.sessionId,
    });

    return new Promise((resolve) => {
      const timeoutMs = normalizeTimeoutMs(resolveTimeoutSetting(session).timeoutMs, 0);
      const turn = {
        resolve,
        wasCancelled,
        onEvent,
        onLog,
        logs: [],
        messages: [],
        finalAnswerMessages: [],
        reasonings: [],
        usage: null,
        threadId: entry.sessionId,
        responseText: '',
        timedOut: false,
        timeout: null,
      };
      entry.currentTurn = turn;

      if (timeoutMs > 0) {
        turn.timeout = setTimeout(() => {
          turn.timedOut = true;
          closeEntry(entry, 'Claude long runner timed out');
        }, timeoutMs);
      }

      const payload = JSON.stringify({
        type: 'user',
        session_id: entry.sessionId || '',
        message: {
          role: 'user',
          content: composePromptWithSystemFallback(prompt, systemPrompt),
        },
        parent_tool_use_id: null,
      }) + '\n';

      try {
        entry.child.stdin.write(payload, (err) => {
          if (!err) return;
          closeEntry(entry, `Claude long runner stdin write failed: ${safeError(err)}`);
        });
      } catch (err) {
        closeEntry(entry, `Claude long runner stdin write failed: ${safeError(err)}`);
      }
    });
  }

  function closeSession(sessionKey, reason = 'closed') {
    const key = String(sessionKey || '').trim();
    const entry = entries.get(key);
    return closeEntry(entry, reason);
  }

  function closeAll(reason = 'closed') {
    let closed = 0;
    for (const entry of [...entries.values()]) {
      if (closeEntry(entry, reason)) closed += 1;
    }
    return closed;
  }

  function getSnapshot() {
    return [...entries.values()].map((entry) => ({
      key: entry.key,
      pid: entry.child?.pid ?? null,
      sessionId: entry.sessionId,
      active: Boolean(entry.currentTurn),
      idleMs: Math.max(0, Date.now() - entry.lastUsedAt),
    }));
  }

  return {
    runTask,
    closeSession,
    closeAll,
    getSnapshot,
  };
}
