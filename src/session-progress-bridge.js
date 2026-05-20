import fs from 'node:fs';

export function createSessionProgressBridgeFactory({
  normalizeProvider,
  extractRawProgressTextFromEvent,
  findLatestRolloutFileBySessionId,
  findLatestClaudeSessionFileBySessionId,
} = {}) {
  function hasClaudeToolResultPayload(value) {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.some((item) => hasClaudeToolResultPayload(item));
    if (typeof value !== 'object') return false;

    const type = String(value.type || '').trim().toLowerCase();
    if (type === 'tool_result') return true;

    return hasClaudeToolResultPayload(value.message)
      || hasClaudeToolResultPayload(value.content)
      || hasClaudeToolResultPayload(value.result);
  }

  function resolveInitialOffset({ match, bridgeStartedAtMs, baselineMatch }) {
    const currentSize = Math.max(0, Number(match?.sizeBytes) || 0);
    const currentPath = String(match?.file || '');
    const baselinePath = String(baselineMatch?.file || '');

    if (baselinePath && currentPath && baselinePath === currentPath) {
      const baselineSize = Math.max(0, Number(baselineMatch?.sizeBytes) || 0);
      return Math.min(currentSize, baselineSize);
    }

    const currentMtimeMs = Number(match?.mtimeMs) || 0;
    return currentMtimeMs < bridgeStartedAtMs ? currentSize : 0;
  }

  function startSessionProgressBridge({ provider, threadId, workspaceDir, onEvent }) {
    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider === 'claude') {
      return startClaudeSessionProgressBridge({ threadId, workspaceDir, onEvent });
    }
    if (normalizedProvider === 'antigravity') {
      return () => {};
    }
    return startCodexSessionProgressBridge({ threadId, onEvent });
  }

  function startCodexSessionProgressBridge({ threadId, onEvent }) {
    const sessionId = String(threadId || '').trim();
    if (!sessionId || typeof onEvent !== 'function') return () => {};

    const bridgeStartedAtMs = Date.now();
    const minMtimeMs = bridgeStartedAtMs - 2 * 60 * 1000;
    const baselineMatch = findLatestRolloutFileBySessionId(sessionId, 0);
    const dedupeKeys = [];
    const dedupeSet = new Set();

    let stopped = false;
    let rolloutFile = null;
    let offset = 0;
    let remainder = '';
    let pollTimer = null;
    let lastScanAt = 0;

    const rememberKey = (key) => {
      if (!key || dedupeSet.has(key)) return false;
      dedupeSet.add(key);
      dedupeKeys.push(key);
      if (dedupeKeys.length > 500) {
        const stale = dedupeKeys.shift();
        if (stale) dedupeSet.delete(stale);
      }
      return true;
    };

    const handleSessionLine = (line) => {
      const raw = String(line || '').trim();
      if (!raw || !raw.startsWith('{') || !raw.endsWith('}')) return;

      let ev = null;
      try {
        ev = JSON.parse(raw);
      } catch {
        return;
      }
      if (!ev || typeof ev !== 'object') return;

      const text = extractRawProgressTextFromEvent(ev);
      if (!text) return;
      const key = [
        ev.timestamp || '',
        ev.type || '',
        ev.payload?.type || '',
        ev.payload?.phase || '',
        text,
      ].join('|');
      if (!rememberKey(key)) return;
      onEvent(ev);
    };

    const consumeChunk = (chunk) => {
      if (!chunk) return;
      remainder += chunk;
      const lines = remainder.split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) handleSessionLine(line);
    };

    const readNewTail = () => {
      if (!rolloutFile) return;

      let stat = null;
      try {
        stat = fs.statSync(rolloutFile);
      } catch {
        rolloutFile = null;
        offset = 0;
        remainder = '';
        return;
      }
      if (!stat || !stat.isFile()) return;
      if (stat.size < offset) {
        offset = 0;
        remainder = '';
      }
      if (stat.size === offset) return;

      const bytesToRead = stat.size - offset;
      if (bytesToRead <= 0) return;

      const fd = fs.openSync(rolloutFile, 'r');
      try {
        const buf = Buffer.allocUnsafe(bytesToRead);
        const readBytes = fs.readSync(fd, buf, 0, bytesToRead, offset);
        offset += readBytes;
        consumeChunk(buf.toString('utf8', 0, readBytes));
      } finally {
        fs.closeSync(fd);
      }
    };

    const resolveRolloutFile = (force = false) => {
      const now = Date.now();
      if (!force && now - lastScanAt < 2500) return false;
      lastScanAt = now;

      const match = findLatestRolloutFileBySessionId(sessionId, minMtimeMs);
      if (!match) return false;
      const nextPath = String(match.file || '');
      if (!nextPath) return false;
      if (nextPath === rolloutFile) return true;

      rolloutFile = match.file;
      offset = resolveInitialOffset({
        match,
        bridgeStartedAtMs,
        baselineMatch,
      });
      remainder = '';
      readNewTail();
      return true;
    };

    const poll = () => {
      if (stopped) return;
      if (!resolveRolloutFile(!rolloutFile) && !rolloutFile) return;
      readNewTail();
    };

    pollTimer = setInterval(poll, 700);
    pollTimer.unref?.();
    poll();

    return () => {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };
  }

  function startClaudeSessionProgressBridge({ threadId, workspaceDir, onEvent }) {
    const sessionId = String(threadId || '').trim();
    if (!sessionId || typeof onEvent !== 'function') return () => {};

    const bridgeStartedAtMs = Date.now();
    const minMtimeMs = bridgeStartedAtMs - 2 * 60 * 1000;
    const baselineMatch = findLatestClaudeSessionFileBySessionId(sessionId, workspaceDir, 0);
    const dedupeKeys = [];
    const dedupeSet = new Set();

    let stopped = false;
    let sessionFile = null;
    let offset = 0;
    let remainder = '';
    let pollTimer = null;
    let lastScanAt = 0;

    const rememberKey = (key) => {
      if (!key || dedupeSet.has(key)) return false;
      dedupeSet.add(key);
      dedupeKeys.push(key);
      if (dedupeKeys.length > 500) {
        const stale = dedupeKeys.shift();
        if (stale) dedupeSet.delete(stale);
      }
      return true;
    };

    const handleSessionLine = (line) => {
      const raw = String(line || '').trim();
      if (!raw || !raw.startsWith('{') || !raw.endsWith('}')) return;

      let ev = null;
      try {
        ev = JSON.parse(raw);
      } catch {
        return;
      }
      if (!ev || typeof ev !== 'object') return;
      const hasToolResult = hasClaudeToolResultPayload(ev);
      if (String(ev.type || '').toLowerCase() === 'user' && !hasToolResult) return;

      const text = extractRawProgressTextFromEvent(ev);
      if (!text && !hasToolResult) return;
      const key = [ev.timestamp || '', ev.type || '', ev.sessionId || '', hasToolResult ? 'tool_result' : '', text].join('|');
      if (!rememberKey(key)) return;
      onEvent(ev);
    };

    const consumeChunk = (chunk) => {
      if (!chunk) return;
      remainder += chunk;
      const lines = remainder.split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) handleSessionLine(line);
    };

    const readNewTail = () => {
      if (!sessionFile) return;

      let stat = null;
      try {
        stat = fs.statSync(sessionFile);
      } catch {
        sessionFile = null;
        offset = 0;
        remainder = '';
        return;
      }
      if (!stat || !stat.isFile()) return;
      if (stat.size < offset) {
        offset = 0;
        remainder = '';
      }
      if (stat.size === offset) return;

      const bytesToRead = stat.size - offset;
      if (bytesToRead <= 0) return;

      const fd = fs.openSync(sessionFile, 'r');
      try {
        const buf = Buffer.allocUnsafe(bytesToRead);
        const readBytes = fs.readSync(fd, buf, 0, bytesToRead, offset);
        offset += readBytes;
        consumeChunk(buf.toString('utf8', 0, readBytes));
      } finally {
        fs.closeSync(fd);
      }
    };

    const resolveSessionFile = (force = false) => {
      const now = Date.now();
      if (!force && now - lastScanAt < 2500) return false;
      lastScanAt = now;

      const match = findLatestClaudeSessionFileBySessionId(sessionId, workspaceDir, minMtimeMs);
      if (!match) return false;
      const nextPath = String(match.file || '');
      if (!nextPath) return false;
      if (nextPath === sessionFile) return true;

      sessionFile = match.file;
      offset = resolveInitialOffset({
        match,
        bridgeStartedAtMs,
        baselineMatch,
      });
      remainder = '';
      readNewTail();
      return true;
    };

    const poll = () => {
      if (stopped) return;
      if (!resolveSessionFile(!sessionFile) && !sessionFile) return;
      readNewTail();
    };

    pollTimer = setInterval(poll, 700);
    pollTimer.unref?.();
    poll();

    return () => {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };
  }

  return {
    startSessionProgressBridge,
  };
}
