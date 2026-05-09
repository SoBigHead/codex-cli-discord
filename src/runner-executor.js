import { spawn } from 'node:child_process';
import { createRunnerArgsBuilder, uniqueDirs } from './runner-args.js';
import { createClaudeLongRunner } from './claude-long-runner.js';
import { createCodexAppServerRunner } from './codex-app-server-runner.js';
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
  resolveCodexProfileSetting,
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
  codexGoalCompletionGraceMs = 15_000,
  spawnFn = spawn,
  claudeLongIdleMs = 15 * 60_000,
  claudeLongMaxSessions = 8,
  codexAppServerIdleMs = 15 * 60_000,
  codexAppServerMaxSessions = 8,
  createClaudeLongRunnerFn = createClaudeLongRunner,
  createCodexAppServerRunnerFn = createCodexAppServerRunner,
} = {}) {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel,
    normalizeProvider,
    getSessionId,
    resolveModelSetting,
    resolveCodexProfileSetting,
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
  const codexAppServerRunner = createCodexAppServerRunnerFn({
    spawnEnv,
    getProviderBin,
    getSessionId,
    resolveModelSetting,
    resolveCodexProfileSetting,
    resolveReasoningEffortSetting,
    resolveFastModeSetting,
    resolveCompactStrategySetting,
    resolveCompactEnabledSetting,
    resolveNativeCompactTokenLimitSetting,
    resolveTimeoutSetting,
    normalizeTimeoutMs,
    safeError,
    stopChildProcess,
    idleMs: codexAppServerIdleMs,
    maxSessions: codexAppServerMaxSessions,
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

    if (normalizeProvider(provider) === 'codex' && resolveRuntimeModeSetting(session).mode === 'long') {
      return codexAppServerRunner.runTask({
        session,
        sessionKey,
        workspaceDir,
        prompt,
        systemPrompt,
        inputImages,
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

    const result = await spawnRunner({ provider, args, cwd: workspaceDir, workspaceDir }, {
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
        const recovered = await spawnRunner({ provider, args: recoveryArgs, cwd: workspaceDir, workspaceDir }, {
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

  function spawnRunner({ provider, args, cwd, workspaceDir }, options = {}) {
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
      };
      let usage = null;
      let threadId = null;
      let resolved = false;
      let timedOut = false;
      let goalCompleted = null;
      let stoppedAfterGoalComplete = false;
      let stoppedAfterGoalBlocked = false;
      let goalPollInFlight = false;
      let goalMonitorTimer = null;
      let goalCompletionStopTimer = null;
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

      const clearGoalCompletionStopTimer = () => {
        if (!goalCompletionStopTimer) return;
        clearTimeout(goalCompletionStopTimer);
        goalCompletionStopTimer = null;
      };

      const scheduleGoalCompletionStop = () => {
        if (goalCompletionStopTimer || child.killed) return;
        const graceMs = Math.max(0, Number(options.goalMonitor?.completionGraceMs ?? codexGoalCompletionGraceMs) || 0);
        if (graceMs === 0) {
          logs.push('Codex goal reached complete; stopping goal continuation runner.');
          stopChildProcess(child);
          return;
        }
        logs.push(`Codex goal reached complete; waiting ${graceMs}ms for final output before stopping runner.`);
        goalCompletionStopTimer = setTimeout(() => {
          goalCompletionStopTimer = null;
          if (resolved || child.killed) return;
          logs.push('Codex goal completion grace elapsed; stopping goal continuation runner.');
          stopChildProcess(child);
        }, graceMs);
        goalCompletionStopTimer.unref?.();
      };

      const stopGoalContinuationAfterBlocker = (text) => {
        if (!options.goalMonitor?.enabled || stoppedAfterGoalBlocked || child.killed) return;
        if (!isCodexGoalBlockerMessage(text)) return;
        stoppedAfterGoalBlocked = true;
        logs.push('Codex goal reported a blocker; stopping goal continuation runner.');
        stopChildProcess(child);
      };

      const pollGoalCompletion = async () => {
        if (!options.goalMonitor?.enabled || goalPollInFlight || resolved) return;
        if (!options.goalMonitor.stopOnComplete) return;
        const monitoredThreadId = String(threadId || options.goalMonitor.threadId || '').trim();
        if (!monitoredThreadId) return;
        goalPollInFlight = true;
        try {
          const report = await options.goalMonitor.getCodexThreadGoal({ threadId: monitoredThreadId });
          const goal = report?.goal || null;
          if (String(goal?.status || '').trim() !== 'complete') return;
          if (goalCompleted) return;
          goalCompleted = goal;
          stoppedAfterGoalComplete = true;
          scheduleGoalCompletionStop();
        } catch (err) {
          logs.push(`Codex goal monitor failed: ${safeError(err)}`);
        } finally {
          goalPollInFlight = false;
        }
      };

      const startGoalMonitor = () => {
        if (!options.goalMonitor?.enabled || goalMonitorTimer) return;
        if (!options.goalMonitor.stopOnComplete) return;
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
            const normalizedProvider = normalizeProvider(provider);
            if (normalizedProvider === 'claude' || normalizedProvider === 'codex') {
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
        startGoalMonitor();
        stopGoalContinuationAfterBlocker(finalAnswerMessages[finalAnswerMessages.length - 1]);
      };

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        stopGoalMonitor();
        clearGoalCompletionStopTimer();
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
        const cancelled = Boolean(timedOut || options.wasCancelled?.());
        if (goalCompleted && finalAnswerMessages.length === 0) {
          if (messages.length) {
            finalAnswerMessages.push(...messages);
          } else {
            finalAnswerMessages.push(formatCodexGoalCompletedMessage(goalCompleted));
          }
        }
        const ok = stoppedAfterGoalComplete || stoppedAfterGoalBlocked || (!cancelled && code === 0);
        finish({
          ok,
          cancelled: stoppedAfterGoalComplete || stoppedAfterGoalBlocked ? false : cancelled,
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
    const threadId = String(getSessionId(session) || '').trim();
    if (!threadId) return null;
    return {
      enabled: true,
      threadId,
      stopOnComplete: isCodexGoalContinuationPrompt(prompt),
      intervalMs: codexGoalMonitorIntervalMs,
      completionGraceMs: codexGoalCompletionGraceMs,
      getCodexThreadGoal,
    };
  }

  return {
    runProviderTask,
    runCodex: runProviderTask,
    buildSessionRunnerArgs,
    closeRuntimeSession: (sessionKey, reason = 'closed') => {
      const closedClaude = claudeLongRunner.closeSession(sessionKey, reason);
      const closedCodex = codexAppServerRunner.closeSession(sessionKey, reason);
      return Boolean(closedClaude || closedCodex);
    },
    closeAllRuntimeSessions: (reason = 'closed') => claudeLongRunner.closeAll(reason) + codexAppServerRunner.closeAll(reason),
    getClaudeLongSessions: () => claudeLongRunner.getSnapshot(),
    getCodexAppServerSessions: () => codexAppServerRunner.getSnapshot(),
  };
}

function isCodexGoalContinuationPrompt(prompt) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  return normalize(prompt) === normalize(CODEX_GOAL_CONTINUATION_PROMPT);
}

function isCodexGoalBlockerMessage(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  const blockerPattern = [
    'blocked',
    'blocker',
    'cannot continue',
    'cannot complete',
    'cannot finish',
    'cannot close',
    'cannot deliver',
    "can't continue",
    "can't complete",
    "can't finish",
    "can't close",
    "can't deliver",
    '无法继续',
    '不能继续',
    '无法完成',
    '不能完成',
    '不能交付',
    '不能关闭',
    '不能标记',
    '阻塞',
    '仍缺',
    '还缺',
    '缺少',
    '没有这份',
    '没有验收',
    '等待提供',
  ].some((phrase) => normalized.includes(phrase));
  if (!blockerPattern) return false;
  return /goal|update_goal|目标|验收|evidence|记录|json|外部|实体手机/.test(normalized);
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
