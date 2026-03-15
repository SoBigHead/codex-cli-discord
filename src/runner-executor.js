import { spawn } from 'node:child_process';
import { createRunnerArgsBuilder, uniqueDirs } from './runner-args.js';
import {
  createRunnerEventParser,
} from './runner-event-handlers.js';
import {
  buildClaudeRecoveryPrompt,
  hasVisibleAssistantText,
  shouldAutoRecoverClaudeResult,
} from './runner-claude-recovery.js';

export function createRunnerExecutor({
  debugEvents = false,
  spawnEnv,
  defaultTimeoutMs = 0,
  defaultModel = null,
  ensureDir,
  normalizeProvider,
  getSessionProvider,
  getProviderBin,
  getSessionId,
  getProviderDefaultWorkspace = () => ({ workspaceDir: null }),
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
  readGeminiSessionState = () => null,
} = {}) {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel,
    normalizeProvider,
    getSessionId,
    resolveCompactStrategySetting,
    resolveCompactEnabledSetting,
    resolveNativeCompactTokenLimitSetting,
  });
  const handleRunnerEvent = createRunnerEventParser({
    normalizeProvider,
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  async function runProviderTask({ session, workspaceDir, prompt, onSpawn, wasCancelled, onEvent, onLog }) {
    ensureDir(workspaceDir);

    const provider = getSessionProvider(session);
    const notes = [];
    const providerDefault = getProviderDefaultWorkspace(provider) || {};
    const additionalWorkspaceDirs = normalizeProvider(provider) === 'claude'
      ? uniqueDirs([providerDefault.workspaceDir].filter((dir) => dir && dir !== workspaceDir))
      : [];
    const args = buildSessionRunnerArgs({ provider, session, workspaceDir, prompt, additionalWorkspaceDirs });
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

    if (normalizeProvider(provider) === 'claude' && shouldAutoRecoverClaudeResult(result)) {
      const recoverySessionId = result.threadId || getSessionId(session);
      if (recoverySessionId) {
        const recoverySession = {
          ...session,
          runnerSessionId: recoverySessionId,
          codexThreadId: recoverySessionId,
        };
        const recoveryArgs = buildSessionRunnerArgs({
          provider,
          session: recoverySession,
          workspaceDir,
          prompt: buildClaudeRecoveryPrompt(),
          additionalWorkspaceDirs,
        });
        const recovered = await spawnRunner({ provider, args: recoveryArgs, cwd: workspaceDir, workspaceDir }, {
          onSpawn,
          wasCancelled,
          onEvent,
          onLog,
          timeoutMs,
        });

        if (recovered.ok && hasVisibleAssistantText(recovered) && !shouldAutoRecoverClaudeResult(recovered)) {
          return {
            ...recovered,
            notes: [...notes, '检测到 Claude 子代理提前返回，已自动续跑一次。'],
          };
        }

        return {
          ...result,
          notes: [...notes, '检测到 Claude 子代理提前返回，已尝试自动续跑一次，但没有拿到更完整结果。'],
        };
      }
    }

    return {
      ...result,
      notes,
    };
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
      const meta = {
        claudeSawAgentToolUse: false,
        claudeStopReason: '',
        geminiDeltaBuffer: '',
      };
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
          onEvent: (ev) => {
            if (normalizeProvider(provider) === 'claude') {
              handleEvent(ev);
            }
            options.onEvent?.(ev);
          },
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
        const state = { messages, finalAnswerMessages, reasonings, logs, usage, threadId, meta };
        handleRunnerEvent(provider, ev, state, ensureSessionBridge);
        usage = state.usage;
        threadId = state.threadId;
      };

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        stopBridges();
        resolve(result);
      };

      child.stdout.on('data', (chunk) => onData(chunk, 'stdout'));
      child.stderr.on('data', (chunk) => onData(chunk, 'stderr'));

      child.on('error', (err) => {
        finish({
          ok: false,
          cancelled: false,
          timedOut,
          error: safeError(err),
          logs,
          messages,
          finalAnswerMessages,
          reasonings,
          usage,
          threadId,
          meta,
        });
      });

      child.on('close', (code, signal) => {
        flushRemainders();
        if (normalizeProvider(provider) === 'gemini') {
          const sessionState = readGeminiSessionState({
            sessionId: threadId,
            workspaceDir,
          });
          if (sessionState?.usage) {
            usage = sessionState.usage;
          }
          if (Array.isArray(sessionState?.messages) && messages.length === 0) {
            messages.push(...sessionState.messages);
          }
          const finalAnswer = String(sessionState?.finalAnswer || '').trim();
          if (finalAnswer && finalAnswerMessages.length === 0) {
            finalAnswerMessages.push(finalAnswer);
          } else if (finalAnswerMessages.length === 0) {
            const buffered = String(meta.geminiDeltaBuffer || '').trim();
            if (buffered) finalAnswerMessages.push(buffered);
          }
        }
        const cancelled = Boolean(timedOut || options.wasCancelled?.());
        const ok = !cancelled && code === 0;
        finish({
          ok,
          cancelled,
          timedOut,
          error: ok ? '' : buildRunnerError({ provider, code, signal, logs }),
          logs,
          messages,
          finalAnswerMessages,
          reasonings,
          usage,
          threadId,
          meta,
        });
      });
    });
  }

  return {
    runProviderTask,
    runCodex: runProviderTask,
    buildSessionRunnerArgs,
  };
}

function buildRunnerError({ provider, code, signal, logs }) {
  if (signal) return `${provider} exited via signal ${signal}`;
  if (typeof code === 'number') return `${provider} exited with code ${code}`;
  if (logs.length) return logs[logs.length - 1];
  return `${provider} run failed`;
}
