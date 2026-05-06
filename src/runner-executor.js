import { spawn, spawnSync } from 'node:child_process';
import { createRunnerArgsBuilder, uniqueDirs } from './runner-args.js';
import { createClaudeLongRunner } from './claude-long-runner.js';
import { CODEX_GOAL_CONTINUATION_PROMPT } from './codex-goal-flow.js';
import {
  createRunnerEventParser,
} from './runner-event-handlers.js';
import {
  buildClaudeRecoveryPrompt,
  hasVisibleAssistantText,
  normalizeClaudeResultForDisplay,
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
  resolveModelSetting,
  resolveReasoningEffortSetting,
  resolveTimeoutSetting,
  resolveFastModeSetting,
  resolveCompactStrategySetting,
  resolveCompactEnabledSetting,
  resolveNativeCompactTokenLimitSetting,
  resolveRuntimeModeSetting = () => ({ mode: 'normal', supported: false, source: 'provider unsupported' }),
  normalizeTimeoutMs,
  safeError,
  stopChildProcess,
  startSessionProgressBridge,
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
  readGeminiSessionState = () => null,
  getCodexThreadGoal = null,
  codexGoalMonitorIntervalMs = 2000,
  spawnFn = spawn,
  claudeLongIdleMs = 15 * 60_000,
  claudeLongMaxSessions = 8,
  createClaudeLongRunnerFn = createClaudeLongRunner,
} = {}) {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel,
    normalizeProvider,
    getSessionId,
    resolveModelSetting,
    resolveReasoningEffortSetting,
    resolveFastModeSetting,
    resolveCompactStrategySetting,
    resolveCompactEnabledSetting,
    resolveNativeCompactTokenLimitSetting,
  });
  const handleRunnerEvent = createRunnerEventParser({
    normalizeProvider,
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });
  const claudeLongRunner = createClaudeLongRunnerFn({
    spawnEnv,
    getProviderBin,
    getSessionId,
    resolveModelSetting,
    resolveReasoningEffortSetting,
    resolveTimeoutSetting,
    normalizeTimeoutMs,
    safeError,
    stopChildProcess,
    idleMs: claudeLongIdleMs,
    maxSessions: claudeLongMaxSessions,
  });

  async function runProviderTask({
    session,
    sessionKey = null,
    workspaceDir,
    prompt,
    systemPrompt = '',
    inputImages = [],
    onSpawn,
    wasCancelled,
    onEvent,
    onLog,
  }) {
    ensureDir(workspaceDir);

    const provider = getSessionProvider(session);
    const notes = [];
    const providerDefault = getProviderDefaultWorkspace(provider) || {};
    const additionalWorkspaceDirs = normalizeProvider(provider) === 'claude'
      ? uniqueDirs([providerDefault.workspaceDir].filter((dir) => dir && dir !== workspaceDir))
      : [];

    if (normalizeProvider(provider) === 'claude' && resolveRuntimeModeSetting(session).mode === 'long') {
      return claudeLongRunner.runTask({
        session,
        sessionKey,
        workspaceDir,
        prompt,
        systemPrompt,
        additionalWorkspaceDirs,
        onSpawn,
        wasCancelled,
        onEvent,
        onLog,
      });
    }

    const args = buildSessionRunnerArgs({
      provider,
      session,
      workspaceDir,
      prompt,
      systemPrompt,
      additionalWorkspaceDirs,
      inputImages,
    });
    const timeoutMs = resolveTimeoutSetting(session).timeoutMs;
    const bin = getProviderBin(provider);

    if (debugEvents) {
      console.log(`Running ${provider}:`, [bin, ...args].join(' '));
    }

    const result = await spawnRunner({
      provider,
      args,
      cwd: workspaceDir,
      workspaceDir,
      sessionId: getSessionId(session),
    }, {
      onSpawn,
      wasCancelled,
      onEvent,
      onLog,
      timeoutMs,
      goalMonitor: createCodexGoalMonitor({ provider, session, prompt }),
    });
    const normalizedResult = normalizeProvider(provider) === 'claude'
      ? normalizeClaudeResultForDisplay(result)
      : result;

    if (normalizeProvider(provider) === 'claude' && shouldAutoRecoverClaudeResult(normalizedResult)) {
      const recoverySessionId = normalizedResult.threadId || getSessionId(session);
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
          systemPrompt,
          additionalWorkspaceDirs,
        });
        const recovered = await spawnRunner({
          provider,
          args: recoveryArgs,
          cwd: workspaceDir,
          workspaceDir,
          sessionId: recoverySessionId,
        }, {
          onSpawn,
          wasCancelled,
          onEvent,
          onLog,
          timeoutMs,
        });
        const normalizedRecovered = normalizeClaudeResultForDisplay(recovered);

        if (normalizedRecovered.ok && hasVisibleAssistantText(normalizedRecovered) && !shouldAutoRecoverClaudeResult(normalizedRecovered)) {
          return {
            ...normalizedRecovered,
            notes: [...notes, '检测到 Claude 子代理提前返回，已自动续跑一次。'],
          };
        }

        return {
          ...normalizedResult,
          notes: [...notes, '检测到 Claude 子代理提前返回，已尝试自动续跑一次，但没有拿到更完整结果。'],
        };
      }
    }

    return {
      ...normalizedResult,
      notes,
    };
  }

  function spawnRunner({ provider, args, cwd, workspaceDir, sessionId = null }, options = {}) {
    return new Promise((resolve) => {
      const bin = getProviderBin(provider);
      const child = spawnFn(bin, args, {
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
        kiroStdoutLines: [],
      };
      let usage = null;
      let threadId = null;
      let resolved = false;
      let timedOut = false;
      let goalCompleted = null;
      let stoppedAfterGoalComplete = false;
      let goalPollInFlight = false;
      let goalMonitorTimer = null;
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

      const stopGoalMonitor = () => {
        if (!goalMonitorTimer) return;
        clearInterval(goalMonitorTimer);
        goalMonitorTimer = null;
      };

      const pollGoalCompletion = async () => {
        if (!options.goalMonitor?.enabled || goalPollInFlight || resolved) return;
        const monitoredThreadId = String(threadId || options.goalMonitor.threadId || '').trim();
        if (!monitoredThreadId) return;
        goalPollInFlight = true;
        try {
          const report = await options.goalMonitor.getCodexThreadGoal({ threadId: monitoredThreadId });
          const goal = report?.goal || null;
          if (String(goal?.status || '').trim() !== 'complete') return;
          goalCompleted = goal;
          stoppedAfterGoalComplete = true;
          logs.push('Codex goal reached complete; stopping goal continuation runner.');
          stopChildProcess(child);
        } catch (err) {
          logs.push(`Codex goal monitor failed: ${safeError(err)}`);
        } finally {
          goalPollInFlight = false;
        }
      };

      const startGoalMonitor = () => {
        if (!options.goalMonitor?.enabled || goalMonitorTimer) return;
        goalMonitorTimer = setInterval(() => {
          void pollGoalCompletion();
        }, Math.max(100, Number(options.goalMonitor.intervalMs) || 2000));
        void pollGoalCompletion();
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

        if (normalizeProvider(provider) === 'kiro' && source === 'stdout') {
          const cleaned = sanitizeKiroStdoutLine(line);
          if (cleaned) {
            meta.kiroStdoutLines.push(cleaned);
            options.onLog?.(cleaned, source);
          }
          return;
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
        startGoalMonitor();
      };

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        stopGoalMonitor();
        stopBridges();
        resolve(result);
      };

      startGoalMonitor();

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
        if (normalizeProvider(provider) === 'kiro') {
          const plainText = String((meta.kiroStdoutLines || []).join('\n')).trim();
          if (plainText && finalAnswerMessages.length === 0) {
            finalAnswerMessages.push(plainText);
          }
          if (!threadId) {
            threadId = resolveLatestKiroSessionId({
              kiroBin: bin,
              workspaceDir,
              spawnEnv,
              fallbackSessionId: sessionId,
            });
          }
        }
        const cancelled = Boolean(timedOut || options.wasCancelled?.());
        if (goalCompleted && finalAnswerMessages.length === 0) {
          if (messages.length) {
            finalAnswerMessages.push(...messages);
          } else {
            finalAnswerMessages.push(formatCodexGoalCompletedMessage(goalCompleted));
          }
        }
        const ok = stoppedAfterGoalComplete || (!cancelled && code === 0);
        finish({
          ok,
          cancelled: stoppedAfterGoalComplete ? false : cancelled,
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

  function createCodexGoalMonitor({ provider, session, prompt } = {}) {
    if (normalizeProvider(provider) !== 'codex') return null;
    if (typeof getCodexThreadGoal !== 'function') return null;
    if (!isCodexGoalContinuationPrompt(prompt)) return null;
    const threadId = String(getSessionId(session) || '').trim();
    return {
      enabled: true,
      threadId,
      intervalMs: codexGoalMonitorIntervalMs,
      getCodexThreadGoal,
    };
  }

  return {
    runProviderTask,
    runCodex: runProviderTask,
    buildSessionRunnerArgs,
    closeRuntimeSession: (sessionKey, reason = 'closed') => claudeLongRunner.closeSession(sessionKey, reason),
    closeAllRuntimeSessions: (reason = 'closed') => claudeLongRunner.closeAll(reason),
    getClaudeLongSessions: () => claudeLongRunner.getSnapshot(),
  };
}

function resolveLatestKiroSessionId({
  kiroBin,
  workspaceDir = '',
  spawnEnv = process.env,
  fallbackSessionId = null,
} = {}) {
  const fallback = String(fallbackSessionId || '').trim();
  try {
    const check = spawnSync(kiroBin, ['chat', '--list-sessions', '--format', 'json'], {
      cwd: workspaceDir || undefined,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 4000,
    });
    if (check.error || check.status !== 0) {
      return fallback;
    }
    const parsed = extractKiroSessionIdFromOutput(check.stdout || check.stderr || '');
    return parsed || fallback;
  } catch {
    return fallback;
  }
}

function extractKiroSessionIdFromOutput(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  const cleaned = stripAnsiControl(text);
  const fromJson = extractKiroSessionIdFromJsonText(cleaned);
  if (fromJson) return fromJson;

  const labeled = cleaned.match(/(?:session[_ -]?id|id)\s*[:=]\s*([A-Za-z0-9._-]{8,})/i)?.[1];
  if (labeled) return labeled;

  const uuid = cleaned.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0];
  if (uuid) return uuid;

  return '';
}

function extractKiroSessionIdFromJsonText(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  return extractKiroSessionIdFromJsonValue(parsed);
}

function extractKiroSessionIdFromJsonValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = extractKiroSessionIdFromJsonValue(item);
      if (id) return id;
    }
    return '';
  }
  if (typeof value !== 'object') return '';

  const direct = String(value.sessionId || value.session_id || value.id || '').trim();
  if (direct) return direct;

  if (Array.isArray(value.sessions)) {
    for (const session of value.sessions) {
      const id = extractKiroSessionIdFromJsonValue(session);
      if (id) return id;
    }
  }

  return '';
}

function sanitizeKiroStdoutLine(line) {
  const raw = String(line || '');
  const stripped = stripAnsiControl(raw).trim();
  if (!stripped) return '';
  if (/^warning!\s*q cli is now kiro cli/i.test(stripped)) return '';
  if (/^▸\s*credits:/i.test(stripped)) return '';
  if (/^to delete a session,/i.test(stripped)) return '';
  return stripped.replace(/^>\s*/, '').trim();
}

function stripAnsiControl(value) {
  return String(value || '')
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '');
}

function isCodexGoalContinuationPrompt(prompt) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  return normalize(prompt) === normalize(CODEX_GOAL_CONTINUATION_PROMPT);
}

function formatCodexGoalCompletedMessage(goal) {
  const objective = String(goal?.objective || '').trim();
  const budget = Number.isFinite(goal?.tokenBudget) && Number.isFinite(goal?.tokensUsed)
    ? `\n预算：${goal.tokensUsed}/${goal.tokenBudget}`
    : '';
  return [
    '✅ Codex goal 已完成，自动续跑已停止。',
    objective ? `目标：${objective}` : null,
    budget || null,
  ].filter(Boolean).join('\n');
}

function buildRunnerError({ provider, code, signal, logs }) {
  if (signal) return `${provider} exited via signal ${signal}`;
  if (typeof code === 'number') return `${provider} exited with code ${code}`;
  if (logs.length) return logs[logs.length - 1];
  return `${provider} run failed`;
}
