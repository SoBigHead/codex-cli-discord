import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export function createRunnerExecutor({
  debugEvents = false,
  spawnEnv,
  defaultTimeoutMs = 0,
  defaultModel = null,
  ensureDir,
  ensureGitRepo,
  normalizeProvider,
  getSessionProvider,
  getProviderBin,
  getSessionId,
  resolveTimeoutSetting,
  resolveCompactStrategySetting,
  resolveCompactEnabledSetting,
  resolveNativeCompactTokenLimitSetting,
  normalizeTimeoutMs,
  safeError,
  stopChildProcess,
  startSessionProgressBridge,
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
} = {}) {
  async function runCodex({ session, workspaceDir, prompt, onSpawn, wasCancelled, onEvent, onLog }) {
    ensureDir(workspaceDir);
    ensureGitRepo(workspaceDir);

    const provider = getSessionProvider(session);
    const notes = [];
    const args = buildSessionRunnerArgs({ provider, session, workspaceDir, prompt });
    const timeoutMs = resolveTimeoutSetting(session).timeoutMs;
    const bin = getProviderBin(provider);

    if (debugEvents) {
      console.log(`Running ${provider}:`, [bin, ...args].join(' '));
    }

    const result = await spawnRunner({ provider, args, cwd: workspaceDir, workspaceDir }, {
      onSpawn,
      wasCancelled,
      onEvent,
      onLog,
      timeoutMs,
    });

    return {
      ...result,
      notes,
    };
  }

  function buildSessionRunnerArgs({ provider, session, workspaceDir, prompt }) {
    return normalizeProvider(provider) === 'claude'
      ? buildClaudeArgs({ session, workspaceDir, prompt })
      : buildCodexArgs({ session, workspaceDir, prompt });
  }

  function buildCodexArgs({ session, workspaceDir, prompt }) {
    const modeFlag = session.mode === 'dangerous'
      ? '--dangerously-bypass-approvals-and-sandbox'
      : '--full-auto';

    const model = session.model || defaultModel;
    const effort = session.effort;
    const extraConfigs = session.configOverrides || [];
    const compactSetting = resolveCompactStrategySetting(session);
    const compactEnabled = resolveCompactEnabledSetting(session);
    const nativeLimit = resolveNativeCompactTokenLimitSetting(session);

    const common = [];
    if (model) common.push('-m', model);
    if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
    if (compactSetting.strategy === 'native' && compactEnabled.enabled) {
      common.push('-c', `model_auto_compact_token_limit=${nativeLimit.tokens}`);
    }
    for (const cfg of extraConfigs) common.push('-c', cfg);

    const sessionId = getSessionId(session);
    if (sessionId) {
      return ['exec', 'resume', '--json', modeFlag, ...common, sessionId, prompt];
    }

    return ['exec', '--json', '--skip-git-repo-check', modeFlag, '-C', workspaceDir, ...common, prompt];
  }

  function buildClaudeArgs({ session, workspaceDir, prompt }) {
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--add-dir', workspaceDir,
    ];
    const model = session.model || defaultModel;
    const effort = session.effort;
    const sessionId = getSessionId(session);

    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    if (session.mode === 'dangerous') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }

    if (sessionId) args.push('--resume', sessionId);
    else args.push('--session-id', randomUUID());

    args.push('--allowedTools', 'default', '--', prompt);
    return args;
  }

  function spawnRunner({ provider, args, cwd, workspaceDir }, options = {}) {
    return new Promise((resolve) => {
      const bin = getProviderBin(provider);
      const child = spawn(bin, args, {
        cwd,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      options.onSpawn?.(child);

      let stdoutBuf = '';
      let stderrBuf = '';

      const messages = [];
      const finalAnswerMessages = [];
      const reasonings = [];
      const logs = [];
      let usage = null;
      let threadId = null;
      let resolved = false;
      let timedOut = false;
      let progressBridgeThreadId = null;
      let stopProgressBridge = null;
      const timeoutMs = normalizeTimeoutMs(options.timeoutMs, defaultTimeoutMs);
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true;
          logs.push(`Timeout after ${timeoutMs}ms`);
          stopChildProcess(child);
        }, timeoutMs)
        : null;

      const stopBridges = () => {
        if (typeof stopProgressBridge === 'function') {
          try {
            stopProgressBridge();
          } catch {
            // ignore bridge teardown failures
          }
        }
        stopProgressBridge = null;
        progressBridgeThreadId = null;
      };

      const ensureSessionBridge = (nextThreadId) => {
        const id = String(nextThreadId || '').trim();
        if (!id) return;
        if (typeof options.onEvent !== 'function') return;
        if (id === progressBridgeThreadId && typeof stopProgressBridge === 'function') return;

        stopBridges();
        stopProgressBridge = startSessionProgressBridge({
          provider,
          threadId: id,
          workspaceDir,
          onEvent: options.onEvent,
        });
        progressBridgeThreadId = id;
      };

      const consumeLine = (line, source) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const ev = JSON.parse(trimmed);
            if (debugEvents) console.log('[event]', ev.type, ev);
            handleEvent(ev);
            options.onEvent?.(ev);
            return;
          } catch {
            // fallthrough
          }
        }

        if (provider === 'codex' && trimmed.includes('state db missing rollout path for thread')) return;
        if (source === 'stderr' || debugEvents) logs.push(trimmed);
        options.onLog?.(trimmed, source);
      };

      const onData = (chunk, source) => {
        let buf = source === 'stdout' ? stdoutBuf : stderrBuf;
        buf += chunk.toString('utf8');

        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) consumeLine(line, source);

        if (source === 'stdout') stdoutBuf = buf;
        else stderrBuf = buf;
      };

      const flushRemainders = () => {
        if (stdoutBuf.trim()) consumeLine(stdoutBuf, 'stdout');
        if (stderrBuf.trim()) consumeLine(stderrBuf, 'stderr');
      };

      const handleEvent = (ev) => {
        const state = { messages, finalAnswerMessages, reasonings, logs, usage, threadId };
        if (normalizeProvider(provider) === 'claude') {
          handleClaudeRunnerEvent(ev, state, ensureSessionBridge);
        } else {
          handleCodexRunnerEvent(ev, state, ensureSessionBridge);
        }
        usage = state.usage;
        threadId = state.threadId;
      };

      child.stdout.on('data', (chunk) => onData(chunk, 'stdout'));
      child.stderr.on('data', (chunk) => onData(chunk, 'stderr'));

      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        stopBridges();
        if (err?.code === 'ENOENT') {
          logs.push(`Command not found: ${bin}`);
        }
        resolve({
          ok: false,
          exitCode: null,
          signal: null,
          messages,
          finalAnswerMessages,
          reasonings,
          usage,
          threadId,
          logs,
          error: safeError(err),
          timedOut,
          cancelled: Boolean(options.wasCancelled?.()),
        });
      });

      child.on('close', (exitCode, signal) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        stopBridges();
        flushRemainders();

        const ok = exitCode === 0;
        const cancelled = !ok && Boolean(options.wasCancelled?.());
        const error = ok
          ? null
          : timedOut
            ? `timeout after ${timeoutMs}ms`
            : cancelled
              ? `cancelled (${signal || `exit=${exitCode}`})`
              : `exit=${exitCode}${signal ? ` signal=${signal}` : ''}`;

        resolve({
          ok,
          exitCode,
          signal,
          messages,
          finalAnswerMessages,
          reasonings,
          usage,
          threadId,
          logs,
          error,
          timedOut,
          cancelled,
        });
      });
    });
  }

  function normalizeRunnerEventType(value) {
    return String(value || '').trim().toLowerCase().replace(/[./-]/g, '_');
  }

  function firstNonEmptyString(...values) {
    for (const value of values) {
      const text = String(value || '').trim();
      if (text) return text;
    }
    return '';
  }

  function extractRunnerSessionId(ev) {
    return firstNonEmptyString(
      ev?.thread_id,
      ev?.threadId,
      ev?.session_id,
      ev?.sessionId,
      ev?.payload?.thread_id,
      ev?.payload?.threadId,
      ev?.payload?.session_id,
      ev?.payload?.sessionId,
      ev?.message?.thread_id,
      ev?.message?.threadId,
      ev?.message?.session_id,
      ev?.message?.sessionId,
      ev?.result?.thread_id,
      ev?.result?.threadId,
      ev?.result?.session_id,
      ev?.result?.sessionId,
    ) || null;
  }

  function pushMessageParts(state, item) {
    const text = extractAgentMessageText(item);
    if (!text) return;
    state.messages.push(text);
    if (isFinalAnswerLikeAgentMessage(item)) {
      state.finalAnswerMessages.push(text);
    }
  }

  function handleCodexRunnerEvent(ev, state, ensureSessionBridge) {
    switch (ev.type) {
      case 'thread.started':
        state.threadId = ev.thread_id || state.threadId;
        ensureSessionBridge(state.threadId);
        break;
      case 'item.completed': {
        const item = ev.item || {};
        if (item.type === 'agent_message') {
          pushMessageParts(state, item);
        }
        if (item.type === 'reasoning' && item.text) state.reasonings.push(item.text.trim());
        break;
      }
      case 'turn.completed':
        state.usage = ev.usage || state.usage;
        break;
      case 'error':
        state.logs.push(typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error));
        break;
      default:
        break;
    }
  }

  function handleClaudeRunnerEvent(ev, state, ensureSessionBridge) {
    const type = normalizeRunnerEventType(ev?.type || '');
    const sessionId = extractRunnerSessionId(ev);
    if (sessionId) {
      state.threadId = sessionId;
      ensureSessionBridge(sessionId);
    }

    if (type === 'system_init' || type === 'init') return;

    if (type === 'assistant' || type === 'assistant_message') {
      const item = ev?.message && typeof ev.message === 'object' ? ev.message : ev;
      pushMessageParts(state, item);
      state.usage = item?.usage || ev?.usage || state.usage;
      return;
    }

    if (type === 'result') {
      state.usage = ev?.usage || ev?.result?.usage || state.usage;
      const resultText = firstNonEmptyString(
        typeof ev?.result === 'string' ? ev.result : '',
        typeof ev?.response === 'string' ? ev.response : '',
        typeof ev?.content === 'string' ? ev.content : '',
      );
      if (resultText && !state.finalAnswerMessages.length) {
        pushMessageParts(state, { type: 'agent_message', phase: 'final_answer', text: resultText });
      }
      if (ev?.subtype === 'error' || ev?.is_error) {
        state.logs.push(firstNonEmptyString(ev?.error, ev?.message, JSON.stringify(ev?.result || 'error')) || 'Claude result error');
      }
      return;
    }

    if (type.includes('reasoning')) {
      const text = extractAgentMessageText(ev?.message && typeof ev.message === 'object' ? ev.message : ev);
      if (text) state.reasonings.push(text);
      return;
    }

    if (type === 'error') {
      state.logs.push(typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error));
    }
  }

  return {
    runCodex,
  };
}
