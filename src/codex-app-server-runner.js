import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { applyCodexOpenAICuratedMarketplaceConfig } from './codex-marketplaces.js';

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeProviderItemType(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[./-]/g, '_').toLowerCase();
}

function writeJsonLine(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function formatError(err) {
  return String(err?.message || err || 'unknown error');
}

function formatLogValue(value) {
  const text = String(value ?? '').trim();
  return text || 'none';
}

function logCodexLongEvent(log, event, fields = {}) {
  if (typeof log !== 'function') return;
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(' ');
  log(`[codex-app-long] ${event}${detail ? ` ${detail}` : ''}`);
}

function buildUserInput(prompt, inputImages = []) {
  const input = [];
  const text = String(prompt || '');
  if (text.trim()) input.push({ type: 'text', text, text_elements: [] });
  for (const imagePath of inputImages || []) {
    const path = normalizeText(imagePath);
    if (path) input.push({ type: 'localImage', path });
  }
  return input;
}

function setConfigPath(target, path, value) {
  const parts = String(path || '').split('.').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return;
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) {
      node[part] = {};
    }
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

export function buildCodexLongConfig({
  session,
  resolveFastModeSetting,
  resolveCompactStrategySetting,
  resolveCompactEnabledSetting,
  resolveNativeCompactTokenLimitSetting,
}) {
  if (Array.isArray(session?.configOverrides) && session.configOverrides.length) {
    throw new Error('Codex long runtime does not support raw config overrides yet');
  }

  const config = {};
  const fastMode = resolveFastModeSetting(session);
  if (fastMode.source === 'session override' || fastMode.source === 'parent channel' || fastMode.enabled === false) {
    setConfigPath(config, 'features.fast_mode', Boolean(fastMode.enabled));
  }

  const compactSetting = resolveCompactStrategySetting(session);
  const compactEnabled = resolveCompactEnabledSetting(session);
  const nativeLimit = resolveNativeCompactTokenLimitSetting(session);
  if (compactSetting.strategy === 'native' && compactEnabled.enabled) {
    setConfigPath(config, 'model_auto_compact_token_limit', nativeLimit.tokens);
  }

  applyCodexOpenAICuratedMarketplaceConfig(config);

  return Object.keys(config).length ? config : null;
}

export function buildPermissionParams(session) {
  if (session?.mode === 'dangerous') {
    return {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
    };
  }
  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  };
}

function normalizeThreadItem(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    ...item,
    type: normalizeProviderItemType(item.type),
  };
}

function extractItemText(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string') return item.text.trim();
  if (typeof item.message === 'string') return item.message.trim();
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        return part.text || part.output_text || part.input_text || '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function appendUnique(list, text) {
  const value = String(text || '').trim();
  if (!value) return;
  if (String(list[list.length - 1] || '').trim() === value) return;
  list.push(value);
}

function isFinalAgentItem(item) {
  const phase = normalizeProviderItemType(item?.phase || '');
  return phase !== 'commentary';
}

function buildRuntimeSignature({
  session,
  workspaceDir,
  systemPrompt,
  resolveModelSetting,
  resolveCodexProfileSetting,
  resolveReasoningEffortSetting,
  resolveFastModeSetting,
  resolveCompactStrategySetting,
  resolveCompactEnabledSetting,
  resolveNativeCompactTokenLimitSetting,
}) {
  const codexProfile = resolveCodexProfileSetting(session);
  return JSON.stringify({
    workspaceDir,
    mode: session?.mode || 'safe',
    model: resolveModelSetting(session).value || null,
    codexProfile: codexProfile?.isExplicit ? codexProfile.value : null,
    effort: resolveReasoningEffortSetting(session).value || null,
    fastMode: resolveFastModeSetting(session),
    compact: resolveCompactStrategySetting(session),
    compactEnabled: resolveCompactEnabledSetting(session),
    nativeLimit: resolveNativeCompactTokenLimitSetting(session),
    configOverrides: session?.configOverrides || [],
    systemPrompt: String(systemPrompt || '').trim(),
  });
}

export function createCodexAppServerRunner({
  spawnEnv = process.env,
  getProviderBin = () => 'codex',
  getSessionId = () => null,
  resolveModelSetting = () => ({ value: null }),
  resolveCodexProfileSetting = () => ({ value: null, isExplicit: false, valid: true }),
  resolveReasoningEffortSetting = () => ({ value: null }),
  resolveFastModeSetting = () => ({ enabled: false, source: 'provider unsupported' }),
  resolveCompactStrategySetting = () => ({ strategy: 'hard' }),
  resolveCompactEnabledSetting = () => ({ enabled: false }),
  resolveNativeCompactTokenLimitSetting = () => ({ tokens: 0 }),
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
    logCodexLongEvent(log, 'close', {
      key: entry.key,
      pid: entry.child?.pid ?? null,
      threadId: entry.threadId,
      reason,
      active: Boolean(entry.currentTurn),
    });
    entry.closed = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    for (const slot of entry.pending.values()) {
      slot.reject(new Error(reason));
    }
    entry.pending.clear();
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
        threadId: turn.threadId || entry.threadId,
        meta: turn.meta,
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
    logCodexLongEvent(log, 'idle-scheduled', {
      key: entry.key,
      pid: entry.child?.pid ?? null,
      threadId: entry.threadId,
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
      throw new Error('all Codex app-server long sessions are busy');
    }
    closeEntry(oldest, 'evicted');
  }

  function sendResponse(entry, id, result) {
    try {
      writeJsonLine(entry.child.stdin, { id, result });
    } catch {
    }
  }

  function sendError(entry, id, message) {
    try {
      writeJsonLine(entry.child.stdin, {
        id,
        error: {
          code: -32000,
          message,
        },
      });
    } catch {
    }
  }

  function handleServerRequest(entry, payload) {
    const method = String(payload?.method || '').trim();
    if (method === 'item/commandExecution/requestApproval') {
      sendResponse(entry, payload.id, { decision: 'cancel' });
      return;
    }
    if (method === 'item/fileChange/requestApproval') {
      sendResponse(entry, payload.id, { decision: 'cancel' });
      return;
    }
    sendError(entry, payload.id, `unsupported Codex app-server request: ${method || 'unknown'}`);
  }

  function handleNotification(entry, payload) {
    const method = String(payload?.method || '').trim();
    const params = payload?.params || {};
    const turn = entry.currentTurn;
    const eventThreadId = normalizeText(params.threadId);
    const isSideThreadEvent = Boolean(eventThreadId && entry.sideThreadIds?.has(eventThreadId));

    if (eventThreadId && !isSideThreadEvent && !turn?.sideTargetThreadId) {
      entry.threadId = eventThreadId;
    }
    if (eventThreadId && turn) turn.threadId = eventThreadId;

    if (method === 'thread/tokenUsage/updated' && turn) {
      turn.usage = params.tokenUsage || params.usage || turn.usage;
      return;
    }

    if (method === 'turn/started') {
      const turnId = params.turn?.id || params.turnId || null;
      if (turnId) {
        entry.activeTurnId = turnId;
        if (turn) turn.turnId = turnId;
      }
      turn?.onEvent?.({ type: 'thread.started', thread_id: params.threadId || entry.threadId });
      return;
    }

    if (method === 'item/agentMessage/delta') {
      if (!turn) return;
      const itemId = String(params.itemId || '').trim();
      const delta = String(params.delta || '');
      if (itemId) {
        turn.deltaByItemId.set(itemId, `${turn.deltaByItemId.get(itemId) || ''}${delta}`);
      }
      turn.onEvent?.({ type: 'assistant.message.delta', text: delta });
      return;
    }

    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      if (!turn) return;
      const text = String(params.delta || params.text || '');
      if (text.trim()) turn.reasonings.push(text.trim());
      return;
    }

    if (method === 'item/completed') {
      if (!turn) return;
      const item = normalizeThreadItem(params.item);
      if (!item) return;
      const text = extractItemText(item);
      if (item.type === 'agent_message' || item.type === 'message') {
        if (isFinalAgentItem(item)) appendUnique(turn.finalAnswerMessages, text);
        else appendUnique(turn.messages, text);
      } else if (item.type === 'reasoning') {
        appendUnique(turn.reasonings, text);
      }
      turn.onEvent?.({ type: 'item.completed', item });
      return;
    }

    if (method === 'turn/completed') {
      if (!turn) return;
      const completed = params.turn || {};
      if (completed.id) {
        entry.activeTurnId = null;
        turn.turnId = completed.id;
      }
      const status = String(completed.status || '').trim();
      const ok = status === 'completed';
      const buffered = [...turn.deltaByItemId.values()].join('').trim();
      if (!turn.finalAnswerMessages.length && buffered) {
        turn.finalAnswerMessages.push(buffered);
      }
      if (turn.timeout) clearTimeout(turn.timeout);
      entry.currentTurn = null;
      entry.lastUsedAt = Date.now();
      if (!turn.keepAlive) scheduleIdleClose(entry);
      turn.onEvent?.({ type: 'turn.completed', usage: turn.usage, status });
      turn.resolve({
        ok,
        cancelled: Boolean(turn.wasCancelled?.()) || status === 'interrupted',
        timedOut: false,
        error: ok ? '' : (completed.error?.message || status || 'Codex app-server turn failed'),
        logs: turn.logs,
        messages: turn.messages,
        finalAnswerMessages: turn.finalAnswerMessages,
        reasonings: turn.reasonings,
        usage: turn.usage,
        threadId: turn.threadId || entry.threadId,
        meta: turn.meta,
      });
    }
  }

  function attachLineHandlers(entry) {
    const rl = readline.createInterface({ input: entry.child.stdout });
    entry.readline = rl;

    const handleLine = (line, source = 'stdout') => {
      const raw = String(line || '').trim();
      if (!raw) return;
      if (source === 'stderr') {
        if (entry.currentTurn) {
          entry.currentTurn.logs.push(raw);
          entry.currentTurn.onLog?.(raw, 'stderr');
        }
        return;
      }

      let payload = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        if (entry.currentTurn) {
          entry.currentTurn.logs.push(raw);
          entry.currentTurn.onLog?.(raw, 'stdout');
        }
        return;
      }

      if (Object.prototype.hasOwnProperty.call(payload, 'id') && payload.method) {
        handleServerRequest(entry, payload);
        return;
      }

      if (Object.prototype.hasOwnProperty.call(payload, 'id')) {
        const slot = entry.pending.get(payload.id);
        if (!slot) return;
        entry.pending.delete(payload.id);
        if (payload.error) {
          const message = payload.error.message || JSON.stringify(payload.error);
          slot.reject(new Error(`Codex app-server ${slot.method} failed: ${message}`));
          return;
        }
        slot.resolve(payload.result);
        return;
      }

      if (payload.method) {
        handleNotification(entry, payload);
      }
    };

    rl.on('line', (line) => handleLine(line, 'stdout'));
    entry.child.stderr?.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) handleLine(line, 'stderr');
    });
    entry.child.on('close', (code, signal) => {
      if (entry.closed) return;
      const turn = entry.currentTurn;
      logCodexLongEvent(log, 'process-close', {
        key: entry.key,
        pid: entry.child?.pid ?? null,
        threadId: entry.threadId,
        code,
        signal,
        active: Boolean(turn),
      });
      entry.closed = true;
      entries.delete(entry.key);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      for (const slot of entry.pending.values()) {
        slot.reject(new Error(`Codex app-server exited with code ${code ?? 'null'}`));
      }
      entry.pending.clear();
      if (!turn) return;
      entry.currentTurn = null;
      if (turn.timeout) clearTimeout(turn.timeout);
      turn.resolve({
        ok: false,
        cancelled: Boolean(turn.wasCancelled?.()),
        timedOut: Boolean(turn.timedOut),
        error: turn.timedOut
          ? 'Codex app-server long runner timed out'
          : `Codex app-server exited${signal ? ` via signal ${signal}` : ` with code ${code}`}`,
        logs: turn.logs,
        messages: turn.messages,
        finalAnswerMessages: turn.finalAnswerMessages,
        reasonings: turn.reasonings,
        usage: turn.usage,
        threadId: turn.threadId || entry.threadId,
        meta: turn.meta,
      });
    });
    entry.child.on('error', (err) => {
      const turn = entry.currentTurn;
      if (!turn) return;
      turn.logs.push(safeError(err));
    });
  }

  function send(entry, method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = entry.nextId;
      entry.nextId += 1;
      entry.pending.set(id, { resolve, reject, method });
      try {
        writeJsonLine(entry.child.stdin, { id, method, params });
      } catch (err) {
        entry.pending.delete(id);
        reject(err);
      }
    });
  }

  function notify(entry, method, params = {}) {
    writeJsonLine(entry.child.stdin, { method, params });
  }

  async function initializeEntry(entry) {
    await send(entry, 'initialize', {
      clientInfo: { name: 'agents-in-discord', version: '0' },
      capabilities: { experimentalApi: true },
    });
    notify(entry, 'initialized', {});
  }

  function buildThreadParams({ session, workspaceDir, systemPrompt }) {
    const codexProfile = resolveCodexProfileSetting(session);
    if (codexProfile?.isExplicit) {
      if (!codexProfile.valid) {
        throw new Error(`invalid Codex profile: ${codexProfile.value} (${codexProfile.error || 'unknown error'})`);
      }
      throw new Error('Codex long runtime does not support explicit Codex profiles yet');
    }

    const model = resolveModelSetting(session).value || null;
    const config = buildCodexLongConfig({
      session,
      resolveFastModeSetting,
      resolveCompactStrategySetting,
      resolveCompactEnabledSetting,
      resolveNativeCompactTokenLimitSetting,
    });
    const permissions = buildPermissionParams(session);
    return {
      cwd: workspaceDir,
      model,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandbox,
      config,
      developerInstructions: String(systemPrompt || '').trim() || null,
      persistExtendedHistory: true,
    };
  }

  async function ensureThread(entry, { session, workspaceDir, systemPrompt }) {
    await entry.readyPromise;
    if (entry.threadId) return entry.threadId;

    const requestedThreadId = entry.requestedThreadId || normalizeText(getSessionId(session));
    const baseParams = buildThreadParams({ session, workspaceDir, systemPrompt });
    const result = requestedThreadId
      ? await send(entry, 'thread/resume', {
        threadId: requestedThreadId,
        ...baseParams,
        excludeTurns: true,
      })
      : await send(entry, 'thread/start', {
        ...baseParams,
        experimentalRawEvents: false,
      });
    const threadId = normalizeText(result?.thread?.id || result?.threadId || requestedThreadId);
    if (!threadId) throw new Error('Codex app-server did not return a thread id');
    entry.threadId = threadId;
    logCodexLongEvent(log, requestedThreadId ? 'resume' : 'thread-start', {
      key: entry.key,
      pid: entry.child?.pid ?? null,
      threadId,
    });
    return threadId;
  }

  async function forkSideThread({
    session,
    sessionKey = null,
    workspaceDir,
    systemPrompt = '',
    sideDeveloperInstructions = '',
    boundaryItems = [],
  } = {}) {
    const key = normalizeText(sessionKey) || normalizeText(getSessionId(session)) || 'default';
    const entry = getOrCreateEntry({ key, session, workspaceDir, systemPrompt });
    const parentThreadId = await ensureThread(entry, { session, workspaceDir, systemPrompt });
    const baseParams = buildThreadParams({
      session,
      workspaceDir,
      systemPrompt: [systemPrompt, sideDeveloperInstructions].filter(Boolean).join('\n\n'),
    });
    const forkResult = await send(entry, 'thread/fork', {
      threadId: parentThreadId,
      ...baseParams,
      ephemeral: true,
    });
    const sideThreadId = normalizeText(forkResult?.thread?.id || forkResult?.threadId);
    if (!sideThreadId) {
      throw new Error('Codex app-server did not return a side thread id');
    }
    entry.sideThreadIds.add(sideThreadId);
    if (Array.isArray(boundaryItems) && boundaryItems.length > 0) {
      try {
        await send(entry, 'thread/inject_items', {
          threadId: sideThreadId,
          items: boundaryItems,
        });
      } catch (err) {
        let cleanupError = '';
        try {
          await send(entry, 'thread/unsubscribe', { threadId: sideThreadId });
        } catch (cleanupErr) {
          cleanupError = safeError(cleanupErr);
        }
        entry.sideThreadIds.delete(sideThreadId);
        const suffix = cleanupError ? `; cleanup failed: ${cleanupError}` : '; side thread unsubscribed';
        throw new Error(`${safeError(err)}${suffix}`);
      }
    }
    return {
      ok: true,
      parentThreadId,
      sideThreadId,
      raw: forkResult,
    };
  }

  function getOrCreateEntry({ key, session, workspaceDir, systemPrompt }) {
    const requestedSessionId = normalizeText(getSessionId(session));
    const signature = buildRuntimeSignature({
      session,
      workspaceDir,
      systemPrompt,
      resolveModelSetting,
      resolveCodexProfileSetting,
      resolveReasoningEffortSetting,
      resolveFastModeSetting,
      resolveCompactStrategySetting,
      resolveCompactEnabledSetting,
      resolveNativeCompactTokenLimitSetting,
    });
    const existing = entries.get(key);
    if (existing) {
      const existingThreadId = existing.threadId || null;
      if (existing.signature === signature && (!requestedSessionId || requestedSessionId === existingThreadId)) {
        existing.lastUsedAt = Date.now();
        if (existing.idleTimer) {
          clearTimeout(existing.idleTimer);
          existing.idleTimer = null;
        }
        logCodexLongEvent(log, 'reuse', {
          key,
          pid: existing.child?.pid ?? null,
          threadId: existing.threadId,
        });
        return existing;
      }
      closeEntry(existing, 'runtime config changed');
    }

    evictIfNeeded();

    const child = spawnFn(getProviderBin('codex'), ['app-server', '--listen', 'stdio://', '--enable', 'goals'], {
      cwd: workspaceDir,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const entry = {
      key,
      child,
      signature,
      requestedThreadId: requestedSessionId || null,
      threadId: null,
      activeTurnId: null,
      currentTurn: null,
      pending: new Map(),
      nextId: 1,
      idleTimer: null,
      lastUsedAt: Date.now(),
      closed: false,
      readyPromise: null,
      sideThreadIds: new Set(),
    };
    entry.readyPromise = initializeEntry(entry);
    entries.set(key, entry);
    attachLineHandlers(entry);
    logCodexLongEvent(log, 'spawn', {
      key,
      pid: child.pid ?? null,
      threadId: entry.threadId,
      cwd: workspaceDir,
    });
    return entry;
  }

  async function runTask({
    session,
    sessionKey,
    workspaceDir,
    prompt,
    systemPrompt = '',
    inputImages = [],
    targetThreadId = null,
    onSpawn,
    wasCancelled,
    onEvent,
    onLog,
  }) {
    const key = normalizeText(sessionKey || workspaceDir);
    if (!key) {
      return {
        ok: false,
        cancelled: false,
        timedOut: false,
        error: 'missing Codex app-server long session key',
        logs: [],
        messages: [],
        finalAnswerMessages: [],
        reasonings: [],
        usage: null,
        threadId: null,
        meta: {},
      };
    }

    let entry;
    const sideTargetThreadId = normalizeText(targetThreadId);
    try {
      if (sideTargetThreadId) {
        entry = entries.get(key);
        if (!entry || entry.closed) {
          throw new Error('Codex side parent app-server session is not running');
        }
        await entry.readyPromise;
        if (!entry.threadId) {
          throw new Error('Codex side parent app-server thread is unavailable');
        }
      } else {
        entry = getOrCreateEntry({ key, session, workspaceDir, systemPrompt });
        await ensureThread(entry, { session, workspaceDir, systemPrompt });
      }
    } catch (err) {
      if (entry && !sideTargetThreadId) closeEntry(entry, 'startup failed');
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
        threadId: sideTargetThreadId || entry?.threadId || null,
        meta: {},
      };
    }

    if (entry.currentTurn) {
      return {
        ok: false,
        cancelled: false,
        timedOut: false,
        error: 'Codex app-server long session already has an active turn',
        logs: [],
        messages: [],
        finalAnswerMessages: [],
        reasonings: [],
        usage: null,
        threadId: sideTargetThreadId || entry.threadId,
        meta: {},
      };
    }

    onSpawn?.(entry.child);
    logCodexLongEvent(log, 'turn-start', {
      key,
      pid: entry.child?.pid ?? null,
      threadId: entry.threadId,
      targetThreadId: sideTargetThreadId,
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
        threadId: sideTargetThreadId || entry.threadId,
        sideTargetThreadId,
        keepAlive: Boolean(sideTargetThreadId),
        turnId: null,
        meta: {},
        deltaByItemId: new Map(),
        timedOut: false,
        timeout: null,
      };
      entry.currentTurn = turn;

      if (timeoutMs > 0) {
        turn.timeout = setTimeout(() => {
          turn.timedOut = true;
          closeEntry(entry, 'Codex app-server long runner timed out');
        }, timeoutMs);
      }

      const effort = resolveReasoningEffortSetting(session).value || null;
      const model = resolveModelSetting(session).value || null;
      send(entry, 'turn/start', {
        threadId: sideTargetThreadId || entry.threadId,
        input: buildUserInput(prompt, inputImages),
        model,
        effort,
      }).then((result) => {
        const turnId = result?.turn?.id || result?.turnId || null;
        if (turnId) {
          entry.activeTurnId = turnId;
          turn.turnId = turnId;
        }
      }).catch((err) => {
        if (turn.timeout) clearTimeout(turn.timeout);
        entry.currentTurn = null;
        resolve({
          ok: false,
          cancelled: false,
          timedOut: false,
          error: safeError(err),
          logs: turn.logs,
          messages: turn.messages,
          finalAnswerMessages: turn.finalAnswerMessages,
          reasonings: turn.reasonings,
          usage: turn.usage,
          threadId: turn.threadId || entry.threadId,
          meta: turn.meta,
        });
      });
    });
  }

  async function steerTask({
    sessionKey,
    prompt,
    inputImages = [],
  }) {
    const key = normalizeText(sessionKey);
    if (!key) {
      return {
        ok: false,
        steered: false,
        reason: 'missing_session_key',
        error: 'missing Codex app-server long session key',
        threadId: null,
        turnId: null,
      };
    }

    const entry = entries.get(key);
    if (!entry || entry.closed || !entry.currentTurn) {
      return {
        ok: false,
        steered: false,
        reason: 'no_active_turn',
        error: 'no active Codex app-server turn to steer',
        threadId: entry?.threadId || null,
        turnId: null,
      };
    }

    const turn = entry.currentTurn;
    const threadId = normalizeText(turn.threadId || entry.threadId);
    const turnId = normalizeText(entry.activeTurnId || turn.turnId);
    if (!threadId || !turnId) {
      return {
        ok: false,
        steered: false,
        reason: 'active_turn_unavailable',
        error: 'Codex app-server active turn id is unavailable',
        threadId,
        turnId,
      };
    }

    const input = buildUserInput(prompt, inputImages);
    if (!input.length) {
      return {
        ok: false,
        steered: false,
        reason: 'empty_input',
        error: 'Codex app-server steer input is empty',
        threadId,
        turnId,
      };
    }

    try {
      const result = await send(entry, 'turn/steer', {
        threadId,
        input,
        expectedTurnId: turnId,
      });
      const acceptedTurnId = normalizeText(result?.turnId) || turnId;
      entry.activeTurnId = acceptedTurnId;
      turn.turnId = acceptedTurnId;
      turn.meta.steerCount = Number(turn.meta.steerCount || 0) + 1;
      turn.onEvent?.({
        type: 'turn.steer',
        thread_id: threadId,
        turn_id: acceptedTurnId,
      });
      logCodexLongEvent(log, 'turn-steer', {
        key,
        pid: entry.child?.pid ?? null,
        threadId,
        turnId: acceptedTurnId,
      });
      return {
        ok: true,
        steered: true,
        threadId,
        turnId: acceptedTurnId,
      };
    } catch (err) {
      const error = safeError(err);
      turn.logs.push(error);
      turn.onLog?.(error, 'stderr');
      return {
        ok: false,
        steered: false,
        reason: 'steer_failed',
        error,
        threadId,
        turnId,
      };
    }
  }

  async function closeSideThread({
    session,
    sessionKey = null,
    threadId = null,
    reason = 'side conversation closed',
  } = {}) {
    const key = normalizeText(sessionKey) || normalizeText(getSessionId(session));
    const normalizedThreadId = normalizeText(threadId) || normalizeText(getSessionId(session));
    if (!normalizedThreadId) {
      return { ok: false, reason: 'missing_side_thread', error: 'missing Codex side thread id' };
    }

    const entry = key ? entries.get(key) : null;
    const cleanup = {
      interrupted: false,
      unsubscribed: false,
      errors: [],
    };
    if (!entry || entry.closed) {
      return {
        ok: true,
        reason: 'no_live_runner',
        threadId: normalizedThreadId,
        ...cleanup,
      };
    }

    const activeTurnTargetsSide = normalizeText(entry.currentTurn?.threadId) === normalizedThreadId;
    if (entry.activeTurnId && activeTurnTargetsSide) {
      try {
        await send(entry, 'turn/interrupt', {
          threadId: normalizedThreadId,
          turnId: entry.activeTurnId,
        });
        cleanup.interrupted = true;
      } catch (err) {
        cleanup.errors.push(`interrupt failed: ${safeError(err)}`);
      }
    }
    try {
      await send(entry, 'thread/unsubscribe', { threadId: normalizedThreadId });
      cleanup.unsubscribed = true;
      entry.sideThreadIds?.delete(normalizedThreadId);
    } catch (err) {
      cleanup.errors.push(`unsubscribe failed: ${safeError(err)}`);
    }
    if (activeTurnTargetsSide && entry.currentTurn) {
      const turn = entry.currentTurn;
      entry.currentTurn = null;
      entry.activeTurnId = null;
      if (turn.timeout) clearTimeout(turn.timeout);
      turn.resolve({
        ok: false,
        cancelled: true,
        timedOut: Boolean(turn.timedOut),
        error: reason,
        logs: turn.logs,
        messages: turn.messages,
        finalAnswerMessages: turn.finalAnswerMessages,
        reasonings: turn.reasonings,
        usage: turn.usage,
        threadId: turn.threadId || normalizedThreadId,
        meta: turn.meta,
      });
    }
    if (normalizeText(entry.threadId) === normalizedThreadId) {
      closeEntry(entry, reason);
    } else {
      entry.lastUsedAt = Date.now();
      scheduleIdleClose(entry);
    }
    return {
      ok: cleanup.errors.length === 0,
      threadId: normalizedThreadId,
      ...cleanup,
      error: cleanup.errors.join('; '),
    };
  }

  function closeSession(sessionKey, reason = 'closed') {
    const key = normalizeText(sessionKey);
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
      threadId: entry.threadId,
      activeTurnId: entry.activeTurnId,
      active: Boolean(entry.currentTurn),
      idleMs: Math.max(0, Date.now() - entry.lastUsedAt),
    }));
  }

  return {
    runTask,
    forkSideThread,
    steerTask,
    closeSideThread,
    closeSession,
    closeAll,
    getSnapshot,
  };
}
