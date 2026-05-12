import { createPromptResultRenderer } from './prompt-result-renderer.js';
import { buildNativeImagePromptNote, stageNativeImageAttachments } from './native-image-inputs.js';
import { withRetryAction } from './retry-action-button.js';
import { buildClaudeSessionRescueSummary as defaultBuildClaudeSessionRescueSummary } from './provider-sessions.js';
import {
  buildExtraInfoPromptLine,
  DEFAULT_EXTRA_INFO_TEMPLATE,
  extraInfoTemplateUsesPerMessageData,
  renderExtraInfoTemplate,
} from './extra-info.js';

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildDiscordBridgePromptLine({ message = null, key = '' } = {}) {
  return renderExtraInfoTemplate(DEFAULT_EXTRA_INFO_TEMPLATE, {
    thread: String(message?.channel?.id || key || '').trim(),
    parent: String(message?.channel?.parentId || '').trim(),
    msg: String(message?.id || '').trim(),
  });
}

export function createPromptOrchestrator({
  showReasoning = false,
  resultChunkChars = 1900,
  safeReply,
  safeChannelSend = async (message, payload) => message.channel.send(payload),
  withDiscordNetworkRetry,
  splitForDiscord,
  getSession,
  ensureWorkspace,
  saveDb,
  clearSessionId,
  getSessionId,
  setSessionId,
  getSessionProvider,
  getSessionLanguage,
  normalizeUiLanguage,
  getProviderDisplayName,
  getProviderShortName,
  formatProviderSessionTerm = () => 'session',
  getProviderDefaultBin,
  getProviderBinEnvName,
  resolveTimeoutSetting,
  resolveTaskRetrySetting = () => ({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000, source: 'default' }),
  resolveCompactStrategySetting,
  resolveCompactEnabledSetting,
  resolveCompactThresholdSetting,
  resolveReplyDeliverySetting = () => ({ mode: 'card_mention', source: 'env default' }),
  resolveExtraInfoSetting = () => ({ enabled: true, text: DEFAULT_EXTRA_INFO_TEMPLATE }),
  formatWorkspaceBusyReport,
  buildWorkspaceBusyPayload = ({ session, workspaceDir, owner }) => ({
    content: formatWorkspaceBusyReport(session, workspaceDir, owner),
  }),
  formatTimeoutLabel,
  setActiveRun,
  acquireWorkspace,
  stopChildProcess,
  runTask,
  createProgressReporter = () => ({
    async start() {},
    sync() {},
    setLatestStep() {},
    onEvent() {},
    onLog() {},
    async finish() {},
  }),
  isCliNotFound,
  slashRef,
  safeError,
  truncate,
  toOptionalInt,
  extractInputTokensFromUsage,
  composeFinalAnswerText,
  buildClaudeSessionRescueSummary = defaultBuildClaudeSessionRescueSummary,
  sleep = defaultSleep,
  prepareNativeInputs = async ({ message, session }) => {
    const provider = String(getSessionProvider(session) || '').trim().toLowerCase();
    if (provider !== 'codex') {
      return {
        inputImages: [],
        promptNote: '',
        notes: [],
        cleanup: async () => {},
      };
    }
    const staged = await stageNativeImageAttachments(message, { safeError });
    return {
      ...staged,
      promptNote: buildNativeImagePromptNote(staged.inputImages),
    };
  },
} = {}) {
  const { composeResultText } = createPromptResultRenderer({
    showReasoning,
    truncate,
    composeFinalAnswerText,
    getProviderShortName,
    formatProviderSessionTerm,
    getSessionProvider,
    getSessionId,
  });

  function shouldCompactSession(session) {
    const compactSetting = resolveCompactStrategySetting(session);
    const enabledSetting = resolveCompactEnabledSetting(session);
    const thresholdSetting = resolveCompactThresholdSetting(session);
    if (!enabledSetting.enabled) return false;
    if (compactSetting.strategy !== 'hard') return false;
    if (!getSessionId(session)) return false;
    const last = toOptionalInt(session.lastInputTokens);
    if (!Number.isFinite(last)) return false;
    return last >= thresholdSetting.tokens;
  }

  function shouldAutoContinueNativeCompact(session) {
    const provider = String(getSessionProvider(session) || '').trim().toLowerCase();
    if (provider !== 'codex') return false;
    const compactSetting = resolveCompactStrategySetting(session);
    const enabledSetting = resolveCompactEnabledSetting(session);
    const thresholdSetting = resolveCompactThresholdSetting(session);
    if (!enabledSetting.enabled) return false;
    if (compactSetting.strategy !== 'native') return false;
    if (!getSessionId(session)) return false;
    const last = toOptionalInt(session.lastInputTokens);
    if (!Number.isFinite(last)) return false;
    return last >= thresholdSetting.tokens;
  }

  async function compactSessionContext({ session, workspaceDir, onSpawn, wasCancelled, onEvent, onLog }) {
    if (!getSessionId(session)) {
      return { ok: false, summary: '', error: 'missing session id' };
    }

    const compactPrompt = [
      '请压缩总结当前会话上下文，供新会话继续工作使用。',
      '输出要求：',
      '1) 用中文，结构化分段，控制在 1200 字以内。',
      '2) 包含：目标、已完成工作、关键代码/文件、未完成事项、风险与约束、下一步建议。',
      '3) 只输出摘要正文，不要寒暄。',
    ].join('\n');

    const result = await runTask({
      session,
      workspaceDir,
      prompt: compactPrompt,
      onSpawn,
      wasCancelled,
      onEvent,
      onLog,
    });
    if (!result.ok) {
      const error = result.error || truncate(result.logs.join('\n'), 400);
      const provider = String(getSessionProvider(session) || '').trim().toLowerCase();
      if (provider === 'claude' && isClaudeContextWindowError(error)) {
        const rescued = buildClaudeSessionRescueSummary({
          sessionId: getSessionId(session),
          workspaceDir,
        });
        if (rescued?.ok && rescued.summary) {
          onLog?.(`Claude session exceeded context window; using local session-file rescue summary from ${rescued.sourceFile || 'session file'}.`, 'compact');
          return { ok: true, summary: rescued.summary, usage: result.usage, rescued: true };
        }
      }
      return {
        ok: false,
        summary: '',
        error,
      };
    }

    const summaryParts = Array.isArray(result.finalAnswerMessages) && result.finalAnswerMessages.length > 0
      ? result.finalAnswerMessages
      : result.messages;
    const summary = (Array.isArray(summaryParts) ? summaryParts : []).join('\n\n').trim();
    if (!summary) {
      return { ok: false, summary: '', error: 'empty compact summary' };
    }

    return { ok: true, summary, usage: result.usage };
  }

  function buildPromptFromCompactedContext(summary, userPrompt) {
    return [
      '下面是上一轮会话的压缩摘要，请先把它作为上下文再回答新的用户请求。',
      '',
      '【压缩摘要开始】',
      summary,
      '【压缩摘要结束】',
      '',
      '请在不丢失关键上下文的前提下继续处理以下新请求：',
      userPrompt,
    ].join('\n');
  }

  function isClaudeContextWindowError(error) {
    const text = String(error || '').toLowerCase();
    return text.includes('context window limit') || text.includes('max_output_tokens');
  }

  function normalizeTaskRetryPolicy(policy) {
    const maxAttemptsRaw = Number(policy?.maxAttempts);
    const baseDelayRaw = Number(policy?.baseDelayMs);
    const maxDelayRaw = Number(policy?.maxDelayMs);
    const maxAttempts = Math.max(1, Number.isFinite(maxAttemptsRaw) ? Math.floor(maxAttemptsRaw) : 3);
    const baseDelayMs = Math.max(0, Number.isFinite(baseDelayRaw) ? Math.floor(baseDelayRaw) : 0);
    const maxDelayMs = Math.max(
      baseDelayMs,
      Number.isFinite(maxDelayRaw) ? Math.floor(maxDelayRaw) : Math.max(baseDelayMs, 8000),
    );
    return {
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      source: policy?.source || 'default',
    };
  }

  function shouldAutoRetryResult(result) {
    return Boolean(result) && !result.ok && !result.cancelled && !result.timedOut;
  }

  function computeRetryDelayMs(nextAttempt, policy) {
    if (nextAttempt <= 1 || policy.baseDelayMs <= 0) return 0;
    const exponent = Math.max(0, nextAttempt - 2);
    return Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** exponent));
  }

  function formatRetryDelay(delayMs, language) {
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      return language === 'en' ? 'immediately' : '立即';
    }
    if (delayMs < 1000) return `${delayMs}ms`;
    const seconds = delayMs / 1000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }

  function buildRetryProgressText({
    language,
    failedAttempt,
    nextAttempt,
    maxAttempts,
    delayMs,
  }) {
    const delayLabel = formatRetryDelay(delayMs, language);
    if (language === 'en') {
      return [
        `Attempt ${failedAttempt}/${maxAttempts} failed.`,
        `Retry ${nextAttempt}/${maxAttempts} starts ${delayMs > 0 ? `in ${delayLabel}` : delayLabel}.`,
      ].filter(Boolean).join(' ');
    }

    return [
      `第 ${failedAttempt}/${maxAttempts} 次尝试失败。`,
      `将在 ${delayLabel} 后开始第 ${nextAttempt}/${maxAttempts} 次重试。`,
    ].filter(Boolean).join('');
  }

  function buildRetrySummaryLine({ attemptsUsed, maxAttempts, retryEvents }) {
    if (attemptsUsed <= 1) return null;
    const retryCount = Math.max(0, attemptsUsed - 1);
    const delayLabels = retryEvents
      .map((item) => formatRetryDelay(item.delayMs, 'zh'))
      .filter(Boolean);
    return [
      `• retry: 已自动重试 ${retryCount} 次`,
      `（总计 ${attemptsUsed}/${maxAttempts} 次尝试`,
      delayLabels.length ? `；退避 ${delayLabels.join(' -> ')}` : '',
      '）',
    ].join('');
  }

  function appendNotes(result, notes) {
    if (!Array.isArray(notes) || notes.length === 0) return;
    result.notes ||= [];
    result.notes.unshift(...notes);
  }

  function shouldMentionOnTerminalReply(mode) {
    return mode === 'card_mention' || mode === 'stream_mention';
  }

  function shouldStreamProcessMessages(mode) {
    return mode === 'stream_mention' || mode === 'stream_only';
  }

  function getCurrentReplyDeliveryMode(session) {
    return resolveReplyDeliverySetting(session).mode;
  }

  function normalizeProcessActivityKey(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  async function sendStreamProcessMessageIfEnabled(message, session, channelState, text) {
    if (!shouldStreamProcessMessages(getCurrentReplyDeliveryMode(session))) return;
    const key = normalizeProcessActivityKey(text);
    const activeRun = channelState?.activeRun;
    if (activeRun && key) {
      if (!Array.isArray(activeRun.streamedProcessActivityKeys)) {
        activeRun.streamedProcessActivityKeys = [];
      }
      const sent = new Set(activeRun.streamedProcessActivityKeys.map(normalizeProcessActivityKey));
      if (sent.has(key)) return;
      activeRun.streamedProcessActivityKeys.push(text);
    }
    await safeChannelSend(message, text);
  }

  function applyCurrentTerminalMention(message, session, payload) {
    return applyTerminalMention(message, payload, getCurrentReplyDeliveryMode(session));
  }

  function applyTerminalMention(message, payload, mode) {
    if (!shouldMentionOnTerminalReply(mode)) return payload;
    const userId = String(message?.author?.id || '').trim();
    if (!userId) return payload;
    const prefix = `<@${userId}> `;
    if (typeof payload === 'string') return `${prefix}${payload}`;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return {
        ...payload,
        content: `${prefix}${String(payload.content || '')}`,
      };
    }
    return payload;
  }

  async function compactCurrentSession(message, key, channelState = {}) {
    const session = getSession(key, { channel: message.channel || null });
    const sessionId = getSessionId(session);
    const workspaceDir = ensureWorkspace(session, key);
    const language = normalizeUiLanguage(getSessionLanguage(session));
    const progress = createProgressReporter({
      message,
      channelState,
      session,
      language,
      initialLatestStep: language === 'en'
        ? `Manual compact requested: ${workspaceDir}`
        : `已请求手动压缩：${workspaceDir}`,
      onStreamProcessMessage: async (text) => sendStreamProcessMessageIfEnabled(message, session, channelState, text),
    });
    let workspaceLock = null;
    let progressOutcome = { ok: false, cancelled: false, timedOut: false, error: '' };

    const releaseWorkspaceLock = () => {
      if (!workspaceLock?.acquired || typeof workspaceLock.release !== 'function') return;
      try {
        workspaceLock.release();
      } catch (err) {
        console.warn(`Failed to release workspace lock: ${safeError(err)}`);
      }
      workspaceLock = null;
    };

    if (!sessionId) {
      await safeReply(
        message,
        applyCurrentTerminalMention(message, session, language === 'en'
          ? 'No existing session to compact.'
          : '当前没有可压缩的会话。'),
      );
      return { ok: false, error: 'missing session id' };
    }

    await progress.start();
    try {
      workspaceLock = await acquireWorkspace(
        workspaceDir,
        {
          key,
          provider: getSessionProvider(session),
          messageId: message.id,
          sessionId,
          sessionName: session.name || null,
        },
        {
          isAborted: () => Boolean(channelState.cancelRequested || channelState.activeRun?.cancelRequested),
        },
      );

      if (workspaceLock?.aborted || channelState.cancelRequested) {
        progressOutcome = { ok: false, cancelled: true, timedOut: false, error: 'cancelled by user' };
        return { ok: false, cancelled: true };
      }

      const compactResult = await compactSessionContext({
        session,
        workspaceDir,
        onSpawn: (child) => {
          setActiveRun(channelState, message, 'manual compact', child, 'compact');
          progress.sync({ forceEmit: true });
          if (channelState.cancelRequested) stopChildProcess(child);
        },
        wasCancelled: () => Boolean(channelState.cancelRequested || channelState.activeRun?.cancelRequested),
        onEvent: progress.onEvent,
        onLog: progress.onLog,
      });

      releaseWorkspaceLock();

      if (!compactResult.ok) {
        const error = compactResult.error || 'manual compact failed';
        progressOutcome = { ok: false, cancelled: false, timedOut: false, error };
        await safeReply(
          message,
          applyCurrentTerminalMention(message, session, language === 'en'
            ? `❌ Manual compact failed: ${error}`
            : `❌ 手动压缩失败：${error}`),
        );
        return { ok: false, error };
      }

      session.pendingCompactSummary = compactResult.summary;
      session.pendingCompactSourceSessionId = sessionId;
      clearSessionId(session);
      session.lastInputTokens = null;
      saveDb();
      progressOutcome = { ok: true, cancelled: false, timedOut: false, error: '' };
      await safeReply(
        message,
        applyCurrentTerminalMention(message, session, language === 'en'
          ? `✅ Compacted ${formatProviderSessionTerm(getSessionProvider(session), language)} ${sessionId}. The next message will continue in a fresh session.`
          : `✅ 已压缩 ${formatProviderSessionTerm(getSessionProvider(session), language)}：${sessionId}。下条消息会用新会话继续。`),
      );
      return { ok: true, summary: compactResult.summary };
    } finally {
      releaseWorkspaceLock();
      await progress.finish(progressOutcome);
    }
  }

  async function handlePrompt(message, key, prompt, channelState) {
    if (channelState.cancelRequested) {
      return { ok: false, cancelled: true };
    }

    const session = getSession(key, { channel: message.channel || null });
    const startingSessionId = getSessionId(session);
    const startingLastInputTokens = session.lastInputTokens;
    const startingPendingForkFromSessionId = String(session?.pendingForkFromSessionId || '').trim() || null;
    const workspaceDir = ensureWorkspace(session, key);
    const language = normalizeUiLanguage(getSessionLanguage(session));
    const taskRetryPolicy = normalizeTaskRetryPolicy(resolveTaskRetrySetting(session));
    const waitingForWorkspaceText = language === 'en'
      ? `Waiting for workspace lock: ${workspaceDir}`
      : `等待 workspace 锁：${workspaceDir}`;
    let workspaceLock = null;

    setActiveRun(channelState, message, prompt, null, 'workspace');
    const progress = createProgressReporter({
      message,
      channelState,
      session,
      language,
      initialLatestStep: waitingForWorkspaceText,
      onStreamProcessMessage: async (text) => sendStreamProcessMessageIfEnabled(message, session, channelState, text),
    });

    void message.channel.sendTyping().catch(() => {});
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);
    await progress.start();
    let progressOutcome = { ok: false, cancelled: false, timedOut: false, error: '' };
    let nativeInputs = {
      inputImages: [],
      promptNote: '',
      notes: [],
      cleanup: async () => {},
    };

    const releaseWorkspaceLock = () => {
      if (!workspaceLock?.acquired || typeof workspaceLock.release !== 'function') return;
      try {
        workspaceLock.release();
      } catch (err) {
        console.warn(`Failed to release workspace lock: ${safeError(err)}`);
      }
      workspaceLock = null;
    };

    try {
      workspaceLock = await acquireWorkspace(
        workspaceDir,
        {
          key,
          provider: getSessionProvider(session),
          messageId: message.id,
          sessionId: getSessionId(session),
          sessionName: session.name || null,
        },
        {
          isAborted: () => Boolean(channelState.cancelRequested || channelState.activeRun?.cancelRequested),
          onWait: ({ owner }) => {
            progress.setLatestStep(
              language === 'en'
                ? `Workspace busy: ${workspaceDir}`
                : `workspace 正忙：${workspaceDir}`,
            );
            return safeReply(message, buildWorkspaceBusyPayload({
              key,
              session,
              userId: message?.author?.id || null,
              workspaceDir,
              owner,
            })).catch(() => {});
          },
        },
      );

      if (workspaceLock?.aborted || channelState.cancelRequested) {
        progressOutcome = { ok: false, cancelled: true, timedOut: false, error: 'cancelled by user' };
        return { ok: false, cancelled: true };
      }

      progress.setLatestStep(
        language === 'en'
          ? `Workspace lock acquired: ${workspaceDir}`
          : `已获取 workspace 锁：${workspaceDir}`,
      );

      const extraInfoSetting = resolveExtraInfoSetting(session);
      const extraInfoPromptLine = buildExtraInfoPromptLine({
        setting: extraInfoSetting,
        message,
        key,
      });
      const extraInfoUsesPerMessageData = extraInfoTemplateUsesPerMessageData(
        extraInfoSetting?.text || extraInfoSetting?.template,
      );
      const extraInfoSystemPrompt = extraInfoUsesPerMessageData ? '' : extraInfoPromptLine;
      const extraInfoPromptSuffix = extraInfoUsesPerMessageData && extraInfoPromptLine
        ? `\n\n${extraInfoPromptLine}`
        : '';
      let promptToRun = prompt;
      const nativeCompactAutoContinueActive = shouldAutoContinueNativeCompact(session);

      if (channelState.cancelRequested) {
        progressOutcome = { ok: false, cancelled: true, timedOut: false, error: 'cancelled by user' };
        return { ok: false, cancelled: true };
      }

      nativeInputs = await prepareNativeInputs({
        message,
        session,
        workspaceDir,
        prompt,
      });
      if (nativeInputs.promptNote) {
        promptToRun = `${promptToRun}\n\n${nativeInputs.promptNote}`;
      }
      if (extraInfoPromptSuffix) {
        promptToRun = `${promptToRun}${extraInfoPromptSuffix}`;
      }

      const runPromptAttempt = async ({ promptText, phase }) => runTask({
        session,
        sessionKey: key,
        workspaceDir,
        prompt: promptText,
        systemPrompt: extraInfoSystemPrompt,
        inputImages: nativeInputs.inputImages,
        onSpawn: (child) => {
          setActiveRun(channelState, message, promptText, child, phase);
          progress.sync({ forceEmit: true });
          if (channelState.cancelRequested) stopChildProcess(child);
        },
        wasCancelled: () => Boolean(channelState.cancelRequested || channelState.activeRun?.cancelRequested),
        onEvent: progress.onEvent,
        onLog: progress.onLog,
      });

      const retryEvents = [];
      const runtimeNotes = Array.isArray(nativeInputs.notes) ? [...nativeInputs.notes] : [];
      let nativeCompactSwitchedDuringRetry = false;
      let attemptNumber = 1;
      let skipRetries = false;
      let result = null;
      const pendingCompactSummary = String(session.pendingCompactSummary || '').trim();
      const pendingCompactSourceSessionId = String(session.pendingCompactSourceSessionId || '').trim();
      let consumedPendingCompactSummary = false;

      if (pendingCompactSummary) {
        promptToRun = buildPromptFromCompactedContext(pendingCompactSummary, promptToRun);
        consumedPendingCompactSummary = true;
        runtimeNotes.push(
          pendingCompactSourceSessionId
            ? `已加载上一段${formatProviderSessionTerm(getSessionProvider(session), language)}：${pendingCompactSourceSessionId} 的手动压缩摘要，本轮在新会话里继续。`
            : `已加载上一段${formatProviderSessionTerm(getSessionProvider(session), language)}的手动压缩摘要，本轮在新会话里继续。`,
        );
      }

      if (shouldCompactSession(session)) {
        const compactSessionId = getSessionId(session);
        progress.setLatestStep(
          language === 'en'
            ? 'Context is over the auto-compact threshold; compacting before the next run.'
            : '上下文已超过自动压缩阈值，正在先压缩再继续。',
        );
        const compactResult = await compactSessionContext({
          session,
          workspaceDir,
          onSpawn: (child) => {
            setActiveRun(channelState, message, prompt, child, 'compact');
            progress.sync({ forceEmit: true });
            if (channelState.cancelRequested) stopChildProcess(child);
          },
          wasCancelled: () => Boolean(channelState.cancelRequested || channelState.activeRun?.cancelRequested),
          onEvent: progress.onEvent,
          onLog: progress.onLog,
        });

        if (compactResult.ok) {
          clearSessionId(session);
          session.lastInputTokens = null;
          saveDb();
          promptToRun = buildPromptFromCompactedContext(compactResult.summary, promptToRun);
          runtimeNotes.push(
            language === 'en'
              ? `Auto-compacted the previous ${formatProviderSessionTerm(getSessionProvider(session), language)}${compactSessionId ? ` ${compactSessionId}` : ''}; continuing in a fresh session.`
              : `已自动压缩上一段${formatProviderSessionTerm(getSessionProvider(session), language)}${compactSessionId ? `：${compactSessionId}` : ''}，本轮会在新会话里继续。`,
          );
        } else {
          skipRetries = true;
          result = {
            ok: false,
            cancelled: Boolean(channelState.cancelRequested || channelState.activeRun?.cancelRequested),
            timedOut: false,
            error: compactResult.error ? `自动压缩失败: ${compactResult.error}` : '自动压缩失败',
            logs: [],
            notes: [],
            reasonings: [],
            messages: [],
            finalAnswerMessages: [],
            threadId: compactSessionId,
            usage: compactResult.usage || null,
          };
        }
      }

      if (!result) {
        result = await runPromptAttempt({
          promptText: promptToRun,
          phase: 'exec',
        });
      }

      while (!skipRetries && shouldAutoRetryResult(result) && attemptNumber < taskRetryPolicy.maxAttempts) {
        if (nativeCompactAutoContinueActive) {
          const currentSessionId = getSessionId(session);
          const retrySessionId = String(result.threadId || '').trim() || null;
          if (currentSessionId && retrySessionId && retrySessionId !== currentSessionId) {
            setSessionId(session, retrySessionId);
            saveDb();
            nativeCompactSwitchedDuringRetry = true;
            runtimeNotes.push(
              `第 ${attemptNumber}/${taskRetryPolicy.maxAttempts} 次尝试期间 native 压缩已将 ${formatProviderSessionTerm(getSessionProvider(session), language)} 从 ${currentSessionId} 切换到 ${retrySessionId}；后续重试继续沿用新 session。`,
            );
          }
        }
        const nextAttempt = attemptNumber + 1;
        const delayMs = computeRetryDelayMs(nextAttempt, taskRetryPolicy);
        retryEvents.push({
          failedAttempt: attemptNumber,
          nextAttempt,
          delayMs,
        });

        setActiveRun(channelState, message, prompt, null, 'retry');
        progress.setLatestStep(buildRetryProgressText({
          language,
          failedAttempt: attemptNumber,
          nextAttempt,
          maxAttempts: taskRetryPolicy.maxAttempts,
          delayMs,
        }));
        if (delayMs > 0) {
          await sleep(delayMs);
        }
        if (channelState.cancelRequested) {
          progressOutcome = { ok: false, cancelled: true, timedOut: false, error: 'cancelled by user' };
          return { ok: false, cancelled: true };
        }

        result = await runPromptAttempt({
          promptText: promptToRun,
          phase: 'retry',
        });
        attemptNumber = nextAttempt;
      }

      appendNotes(result, runtimeNotes);

      const inputTokens = extractInputTokensFromUsage(result.usage);
      const resultSessionId = String(result.threadId || '').trim() || null;
      const clearPendingForkIfResolved = () => {
        if (!result.ok) return false;
        if (!startingPendingForkFromSessionId || !resultSessionId) return false;
        if (session.pendingForkFromSessionId !== null) {
          session.pendingForkFromSessionId = null;
          return true;
        }
        return false;
      };
      const sessionSwitchedUnexpectedly = Boolean(
        startingSessionId
          && resultSessionId
          && resultSessionId !== startingSessionId
          && !nativeCompactAutoContinueActive
          && !startingPendingForkFromSessionId,
      );
      let sessionDirty = false;
      if (nativeCompactAutoContinueActive) {
        const boundSessionId = getSessionId(session);
        const nextSessionId = resultSessionId || boundSessionId || startingSessionId || null;
        if (nextSessionId && boundSessionId !== nextSessionId) {
          setSessionId(session, nextSessionId);
          sessionDirty = true;
        }
        if (inputTokens !== null) {
          session.lastInputTokens = inputTokens;
          sessionDirty = true;
        }
        if (clearPendingForkIfResolved()) {
          sessionDirty = true;
        }
        if (startingSessionId && resultSessionId && resultSessionId !== startingSessionId && !nativeCompactSwitchedDuringRetry) {
          appendNotes(result, [
            result.ok
              ? `本轮执行期间 native 压缩已将 ${formatProviderSessionTerm(getSessionProvider(session), language)} 从 ${startingSessionId} 切换到 ${resultSessionId}。`
              : `本轮执行失败，但 native 压缩已将 ${formatProviderSessionTerm(getSessionProvider(session), language)} 从 ${startingSessionId} 切换到 ${resultSessionId}。`,
          ]);
        }
      } else if (result.ok && !sessionSwitchedUnexpectedly) {
        if (resultSessionId) {
          setSessionId(session, resultSessionId);
          sessionDirty = true;
        }
        if (inputTokens !== null) {
          session.lastInputTokens = inputTokens;
          sessionDirty = true;
        }
        if (clearPendingForkIfResolved()) {
          sessionDirty = true;
        }
      } else if (result.ok && sessionSwitchedUnexpectedly) {
        result.threadId = null;
        appendNotes(result, [
          `本轮运行意外切到了新的 ${formatProviderSessionTerm(getSessionProvider(session), language)}：${resultSessionId}，当前仍保留原 ${formatProviderSessionTerm(getSessionProvider(session), language)}：${startingSessionId}。如需继续新 session，请显式执行 ${slashRef('resume')} ${resultSessionId}。`,
        ]);
        if (getSessionId(session) !== startingSessionId) {
          setSessionId(session, startingSessionId);
          sessionDirty = true;
        }
        if (session.lastInputTokens !== startingLastInputTokens) {
          session.lastInputTokens = startingLastInputTokens;
          sessionDirty = true;
        }
      } else if (startingSessionId) {
        const currentSessionId = getSessionId(session);
        if (currentSessionId !== startingSessionId) {
          setSessionId(session, startingSessionId);
          sessionDirty = true;
        }
        if (session.lastInputTokens !== startingLastInputTokens) {
          session.lastInputTokens = startingLastInputTokens;
          sessionDirty = true;
        }
        if (resultSessionId && resultSessionId !== startingSessionId) {
          result.threadId = null;
          appendNotes(result, [
            `失败期间新建了新的 ${formatProviderSessionTerm(getSessionProvider(session), language)}：${resultSessionId}，当前仍保留原 ${formatProviderSessionTerm(getSessionProvider(session), language)}：${startingSessionId}。如需继续新 session，请显式执行 ${slashRef('resume')} ${resultSessionId}。`,
          ]);
        }
        if (clearPendingForkIfResolved()) {
          sessionDirty = true;
        }
      } else {
        if (resultSessionId) {
          setSessionId(session, resultSessionId);
          sessionDirty = true;
          appendNotes(result, [
            `本次失败已保留当前 ${formatProviderSessionTerm(getSessionProvider(session), language)}：${resultSessionId}。`,
          ]);
        }
        if (inputTokens !== null) {
          session.lastInputTokens = inputTokens;
          sessionDirty = true;
        }
        if (clearPendingForkIfResolved()) {
          sessionDirty = true;
        }
      }
      if (result.ok && consumedPendingCompactSummary) {
        session.pendingCompactSummary = null;
        session.pendingCompactSourceSessionId = null;
        sessionDirty = true;
      }
      if (sessionDirty) {
        saveDb();
      }

      releaseWorkspaceLock();

      if (!result.ok) {
        if (result.cancelled) {
          progressOutcome = { ok: false, cancelled: true, timedOut: false, error: result.error || 'cancelled' };
          await safeReply(message, applyCurrentTerminalMention(message, session, '🛑 当前任务已中断。'));
          return { ok: false, cancelled: true };
        }

        const provider = getSessionProvider(session);
        const cliMissing = isCliNotFound(result.error);
        const timeoutSetting = resolveTimeoutSetting(session);
        const retrySummaryLine = buildRetrySummaryLine({
          attemptsUsed: attemptNumber,
          maxAttempts: taskRetryPolicy.maxAttempts,
          retryEvents,
        });
        const noteLines = Array.isArray(result.notes)
          ? result.notes.map((note) => String(note || '').trim()).filter(Boolean).map((note) => `• ${note}`)
          : [];
        const activeSessionId = getSessionId(session);
        const failText = [
          result.timedOut ? `❌ ${getProviderShortName(provider)} 执行超时` : `❌ ${getProviderShortName(provider)} 执行失败`,
          retrySummaryLine,
          ...noteLines,
          activeSessionId ? `• ${formatProviderSessionTerm(provider, language)}: \`${activeSessionId}\`` : null,
          result.error ? `• error: ${result.error}` : null,
          result.logs.length ? `• logs: ${truncate(result.logs.join('\n'), 1200)}` : null,
          result.timedOut
            ? `• 处理: 可用 \`${slashRef('timeout')} <ms|off|status>\` 或 \`!timeout <ms|off|status>\` 调整本频道超时。当前: ${formatTimeoutLabel(timeoutSetting.timeoutMs)} (${timeoutSetting.source})`
            : null,
          cliMissing ? `• 诊断: 当前环境找不到 ${getProviderDisplayName(provider)} CLI 可执行文件。` : null,
          cliMissing ? `• 处理: 在该设备安装 ${getProviderDefaultBin(provider)}，或在 .env 配置 \`${getProviderBinEnvName(provider)}=/绝对路径/${getProviderDefaultBin(provider)}\`，然后重启 bot。` : null,
          cliMissing ? `• 自检: 用 \`${slashRef('status')}\` 或 \`!status\` 查看 CLI 状态。` : null,
          '',
          `可以先 \`${slashRef('reset')}\` 再重试，或 \`${slashRef('status')}\` 看状态。`,
        ].filter(Boolean).join('\n');
        progressOutcome = {
          ok: false,
          cancelled: false,
          timedOut: Boolean(result.timedOut),
          error: result.error || `${getSessionProvider(session)} run failed`,
        };
        await safeReply(
          message,
          applyCurrentTerminalMention(message, session, withRetryAction(failText, message?.author?.id || null)),
        );
        return { ok: false, cancelled: false };
      }

      const body = composeResultText(result, session);
      const parts = splitForDiscord(body, resultChunkChars);

      if (parts.length === 0) {
        await safeReply(message, applyCurrentTerminalMention(message, session, '✅ 完成（无可展示文本输出）。'));
        progressOutcome = { ok: true, cancelled: false, timedOut: false, error: '' };
        return { ok: true, cancelled: false };
      }

      await safeReply(message, applyCurrentTerminalMention(message, session, parts[0]));
      for (let i = 1; i < parts.length; i += 1) {
        await safeChannelSend(message, parts[i]);
      }

      progressOutcome = { ok: true, cancelled: false, timedOut: false, error: '' };
      return { ok: true, cancelled: false };
    } catch (err) {
      progressOutcome = { ok: false, cancelled: false, timedOut: false, error: safeError(err) };
      throw err;
    } finally {
      releaseWorkspaceLock();
      clearInterval(typingInterval);
      try {
        await progress.finish(progressOutcome);
      } finally {
        await nativeInputs.cleanup().catch(() => {});
      }
    }
  }

  return {
    createProgressReporter,
    shouldCompactSession,
    compactSessionContext,
    compactCurrentSession,
    buildPromptFromCompactedContext,
    composeResultText,
    handlePrompt,
  };
}
