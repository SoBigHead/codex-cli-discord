import { getSupportedReasoningEffortLevels } from './provider-metadata.js';

function defaultNormalizeUiLanguage(value) {
  return String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh';
}

function defaultTruncate(value, max) {
  const text = String(value || '');
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  if (limit <= 3) return text.slice(0, limit);
  return `${text.slice(0, limit - 3)}...`;
}

function joinLinesWithinLimit(lines, maxChars, truncate = defaultTruncate) {
  const normalized = Array.isArray(lines)
    ? lines
      .map((line) => String(line || '').trimEnd())
      .filter(Boolean)
    : [];
  if (!normalized.length) return '';

  const limit = Math.max(1, Number(maxChars) || 0);
  const output = [];
  let used = 0;
  let overflowed = false;

  for (const line of normalized) {
    const nextLength = line.length + (output.length ? 1 : 0);
    if (used + nextLength > limit) {
      overflowed = true;
      break;
    }
    output.push(line);
    used += nextLength;
  }

  if (!output.length) {
    return truncate(normalized[0], limit);
  }

  if (overflowed) {
    const overflowLine = '...';
    if (used + overflowLine.length + 1 <= limit) {
      output.push(overflowLine);
    }
  }

  return output.join('\n');
}

function createNoopProgressReporter({
  channelState,
  initialLatestStep = '',
  now = () => Date.now(),
}) {
  let latestStep = String(initialLatestStep || '').trim();

  const sync = () => {
    if (!channelState?.activeRun) return;
    channelState.activeRun.lastProgressText = latestStep;
    channelState.activeRun.lastProgressAt = now();
  };

  return {
    async start() {
      sync();
    },
    sync,
    setLatestStep(value) {
      const next = String(value || '').trim();
      if (!next) return;
      latestStep = next;
      sync();
    },
    onEvent() {},
    onLog() {},
    async finish() {},
  };
}

function getDefaultLatestStep(language) {
  return language === 'en'
    ? 'Task started, waiting for the first event...'
    : '任务已开始，等待首个事件...';
}

function normalizeActivityKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeProgressEventType(value) {
  return String(value || '').trim().toLowerCase().replace(/[./-]/g, '_');
}

function normalizeProgressText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeDiscordDisplayText(value) {
  return String(value || '').replace(/\|\|/g, '｜｜');
}

function isLowSignalLatestStep(value) {
  const normalized = normalizeActivityKey(value);
  if (!normalized) return true;
  if (normalized === 'received event') return true;
  if (normalized === 'system') return true;
  if (normalized === 'turn started') return true;
  if (normalized === 'agent message started') return true;
  if (normalized === 'agent message delta') return true;
  if (normalized === 'message start') return true;
  if (normalized === 'message stop') return true;
  if (normalized === 'content block start') return true;
  if (normalized === 'content block stop') return true;
  if (normalized === 'task started, waiting for the first event') return true;
  if (normalized === '任务已开始，等待首个事件') return true;
  if (normalized.startsWith('waiting for workspace lock')) return true;
  if (normalized.startsWith('等待 workspace 锁')) return true;
  return false;
}

function shouldPromoteLatestStep(nextStep, currentStep) {
  const next = String(nextStep || '').trim();
  if (!next || isLowSignalLatestStep(next)) return false;
  if (!next.startsWith('agent message')) return true;

  const normalized = normalizeActivityKey(next);
  if (normalized.includes('api error')) return true;
  if (normalized.includes('rate limit')) return true;
  if (normalized.includes('429')) return true;
  return !currentStep || isLowSignalLatestStep(currentStep);
}

function parseProgressJsonMaybe(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!(text.startsWith('{') || text.startsWith('['))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatClaudePathLabel(rawPath, truncateText, previewChars) {
  const filePath = normalizeProgressText(rawPath);
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  const leaf = normalized.split('/').filter(Boolean).pop() || normalized;
  return truncateText(leaf, previewChars);
}

function summarizeClaudeShellIntent(command, truncateText, previewChars) {
  const text = normalizeProgressText(command);
  if (!text) return '';

  if (/\b(which|command\s+-v|type\s+-p)\b/.test(text)) return 'Check available tools';
  if (/\b(ls|find)\b/.test(text)) return 'Inspect project files';
  if (/\b(rg|ripgrep|grep)\b/.test(text)) return 'Search project files';
  if (/\b(cat|sed|head|tail|awk)\b/.test(text)) return 'Read file content';
  if (/\bgit\s+(status|diff|log|show)\b/.test(text)) return 'Check repository state';
  if (/\b(npm|pnpm|yarn)\s+(test|lint|build|typecheck)\b/.test(text)) return 'Run project checks';
  if (/\b(python|python3|node)\b/.test(text) && (/\s-c\b/.test(text) || /<<\s*['"]?[A-Z_]+['"]?/.test(text))) {
    return 'Run an analysis script';
  }

  return `Run shell command: ${truncateText(text, previewChars)}`;
}

function summarizeClaudeToolInput(input, truncateText, previewChars, toolName = '') {
  if (!input || typeof input !== 'object') return '';
  const normalizedTool = normalizeProgressEventType(toolName);

  const description = normalizeProgressText(input.description || input.reason || input.explanation || '');
  if (description) return truncateText(description, previewChars);

  if (normalizedTool === 'todowrite') {
    const todoCount = Array.isArray(input.todos)
      ? input.todos.length
      : Array.isArray(input.newTodos)
        ? input.newTodos.length
        : 0;
    return todoCount > 0 ? `Update plan (${todoCount} steps)` : 'Update plan';
  }

  const filePath = formatClaudePathLabel(input.file_path || input.path || '', truncateText, previewChars);
  if (normalizedTool === 'read') return filePath ? `Read ${filePath}` : 'Read file';
  if (normalizedTool === 'write') return filePath ? `Write ${filePath}` : 'Write file';
  if (normalizedTool === 'edit' || normalizedTool === 'multiedit') return filePath ? `Edit ${filePath}` : 'Edit file';
  if (normalizedTool === 'ls') return filePath ? `Inspect ${filePath}` : 'Inspect directory';
  if (normalizedTool === 'glob') {
    const pattern = normalizeProgressText(input.pattern || '');
    return pattern ? `Scan files: ${truncateText(pattern, previewChars)}` : 'Scan files';
  }
  if (normalizedTool === 'grep') {
    const pattern = normalizeProgressText(input.pattern || input.query || input.q || '');
    return pattern ? `Search files: ${truncateText(pattern, previewChars)}` : 'Search files';
  }
  if (normalizedTool === 'websearch') {
    const query = normalizeProgressText(input.query || input.q || '');
    return query ? `Search web: ${truncateText(query, previewChars)}` : 'Search web';
  }
  if (normalizedTool === 'webfetch') {
    const url = normalizeProgressText(input.url || '');
    return url ? `Open page: ${truncateText(url, previewChars)}` : 'Open page';
  }

  const command = normalizeProgressText(input.command || input.cmd || '');
  if (command) return summarizeClaudeShellIntent(command, truncateText, previewChars);

  const query = normalizeProgressText(input.query || input.q || '');
  if (query) return `Search: ${truncateText(query, previewChars)}`;

  if (filePath) return `File: ${filePath}`;

  const url = normalizeProgressText(input.url || '');
  if (url) return `URL: ${truncateText(url, previewChars)}`;

  const pattern = normalizeProgressText(input.pattern || '');
  if (pattern) return `Find: ${truncateText(pattern, previewChars)}`;

  return '';
}

function formatClaudeToolUseLabel(block, truncateText, previewChars) {
  const toolName = normalizeProgressText(block?.name || 'tool') || 'tool';
  const normalizedTool = normalizeProgressEventType(toolName);
  const detail = summarizeClaudeToolInput(block?.input, truncateText, previewChars, toolName);

  if (normalizedTool === 'todowrite') return detail || 'Update plan';
  if (['bash', 'read', 'write', 'edit', 'multiedit', 'ls', 'glob', 'grep', 'websearch', 'webfetch'].includes(normalizedTool)) {
    return detail || toolName;
  }

  return detail ? `${toolName}: ${detail}` : `tool ${toolName}`;
}

function shouldSurfaceClaudeToolActivity(block) {
  return normalizeProgressEventType(block?.name || '') !== 'todowrite';
}

function createClaudeProgressTracker({ truncateText, previewChars }) {
  const activeBlocks = new Map();
  const finalizedBlocks = [];
  const toolUseLabelsById = new Map();

  function resetMessage() {
    activeBlocks.clear();
    finalizedBlocks.length = 0;
  }

  function finalizeBlock(index) {
    if (!activeBlocks.has(index)) return;
    const block = activeBlocks.get(index);
    activeBlocks.delete(index);
    if (!block) return;

    if (block.kind === 'text') {
      const text = normalizeProgressText(block.text);
      if (text) finalizedBlocks.push({ kind: 'text', text });
      return;
    }

    if (block.kind === 'tool_use') {
      let mergedInput = block.input && typeof block.input === 'object' ? { ...block.input } : {};
      const parsed = parseProgressJsonMaybe(block.partialInput);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        mergedInput = { ...mergedInput, ...parsed };
      }
      const next = {
        kind: 'tool_use',
        id: normalizeProgressText(block.id),
        name: normalizeProgressText(block.name || 'tool') || 'tool',
        input: mergedInput,
      };
      finalizedBlocks.push(next);
      if (next.id) {
        toolUseLabelsById.set(next.id, formatClaudeToolUseLabel(next, truncateText, previewChars));
      }
    }
  }

  function consumeMessageBoundary(stopReason) {
    const normalizedStopReason = normalizeProgressEventType(stopReason);
    const summaryCandidates = [];
    const rawActivities = [];

    for (const block of finalizedBlocks.splice(0)) {
      if (block.kind === 'tool_use') {
        const label = formatClaudeToolUseLabel(block, truncateText, previewChars);
        summaryCandidates.push(label);
        if (shouldSurfaceClaudeToolActivity(block)) rawActivities.push(label);
        continue;
      }

      if (block.kind === 'text' && normalizedStopReason !== 'end_turn') {
        const text = truncateText(block.text, previewChars);
        if (text) {
          summaryCandidates.push(`agent message: ${text}`);
          rawActivities.push(text);
        }
      }
    }

    return {
      summaryStep: summaryCandidates[summaryCandidates.length - 1] || '',
      rawActivities,
      completedSteps: [],
    };
  }

  function consumeToolResult(event) {
    if (!event || typeof event !== 'object') return null;
    const parts = Array.isArray(event?.message?.content) ? event.message.content : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (normalizeProgressEventType(part.type || '') !== 'tool_result') continue;
      const toolUseId = normalizeProgressText(part.tool_use_id || '');
      if (!toolUseId) continue;
      const label = toolUseLabelsById.get(toolUseId);
      if (!label) continue;
      if (label === 'Update plan' || /^Update plan \(\d+ steps\)$/.test(label)) return null;
      return {
        summaryStep: `${label} completed`,
        rawActivities: [],
        completedSteps: [label],
      };
    }
    return null;
  }

  function capture(event) {
    const type = normalizeProgressEventType(event?.type || '');
    if (!type) return null;

    if (type === 'stream_event' && event.event && typeof event.event === 'object') {
      const nestedType = normalizeProgressEventType(event.event.type || '');
      if (nestedType === 'message_start') {
        resetMessage();
        return null;
      }

      if (nestedType === 'content_block_start') {
        const index = Number(event.event.index);
        if (!Number.isFinite(index)) return null;
        const block = event.event.content_block && typeof event.event.content_block === 'object'
          ? event.event.content_block
          : {};
        const blockType = normalizeProgressEventType(block.type || '');
        if (blockType === 'text') {
          activeBlocks.set(index, {
            kind: 'text',
            text: String(block.text || ''),
          });
        } else if (blockType === 'tool_use') {
          activeBlocks.set(index, {
            kind: 'tool_use',
            id: block.id,
            name: block.name || block.tool_name || 'tool',
            input: block.input && typeof block.input === 'object' ? block.input : {},
            partialInput: '',
          });
        }
        return null;
      }

      if (nestedType === 'content_block_delta') {
        const index = Number(event.event.index);
        if (!Number.isFinite(index) || !activeBlocks.has(index)) return null;
        const block = activeBlocks.get(index);
        const delta = event.event.delta && typeof event.event.delta === 'object' ? event.event.delta : {};
        const deltaType = normalizeProgressEventType(delta.type || '');
        if (block.kind === 'text' && deltaType === 'text_delta' && typeof delta.text === 'string') {
          block.text = `${block.text || ''}${delta.text}`;
        } else if (block.kind === 'tool_use' && deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
          block.partialInput = `${block.partialInput || ''}${delta.partial_json}`;
        }
        return null;
      }

      if (nestedType === 'content_block_stop') {
        finalizeBlock(Number(event.event.index));
        return null;
      }

      if (nestedType === 'message_delta') {
        return consumeMessageBoundary(
          event.event.delta?.stop_reason
          || event.event.delta?.stopReason
          || '',
        );
      }

      if (nestedType === 'message_stop') {
        resetMessage();
      }

      return null;
    }

    if (type === 'user') {
      return consumeToolResult(event);
    }

    return null;
  }

  return {
    capture,
  };
}

function getFinalLatestStep({
  ok = false,
  cancelled = false,
  timedOut = false,
  latestStep = '',
  language = 'en',
} = {}) {
  if (cancelled) {
    return language === 'en' ? 'Task cancelled' : '任务已中断';
  }
  if (timedOut) {
    return language === 'en' ? 'Task timed out' : '任务已超时';
  }
  if (ok) {
    return language === 'en' ? 'Final response sent' : '最终结果已发送';
  }
  return String(latestStep || '').trim() || (language === 'en' ? 'Task failed' : '任务失败');
}

function formatFastModeSource(source, language = 'en') {
  const value = String(source || '').trim().toLowerCase();
  if (language === 'en') {
    if (value === 'session override') return 'this channel';
    if (value === 'parent channel') return 'parent channel';
    if (value === 'config.toml') return 'global config';
    return value || 'unknown';
  }
  if (value === 'session override') return '当前频道';
  if (value === 'parent channel') return '父频道默认';
  if (value === 'config.toml') return '全局配置';
  return value || '未知';
}

function formatFastModeValue(setting, language = 'en') {
  if (!setting?.supported) return null;
  const enabled = setting.enabled
    ? (language === 'en' ? 'on' : '开启')
    : (language === 'en' ? 'off' : '关闭');
  return language === 'en'
    ? `${enabled} (${formatFastModeSource(setting.source, language)})`
    : `${enabled}（${formatFastModeSource(setting.source, language)}）`;
}

function formatEffortValue(setting, provider, language = 'en') {
  if (!getSupportedReasoningEffortLevels(provider).length) return null;

  const value = String(setting?.value || '').trim();
  const source = String(setting?.source || '').trim().toLowerCase();
  if (!value) return null;
  if (source === 'provider') {
    return language === 'en' ? 'provider default' : 'provider 默认';
  }
  return value;
}

function formatSettingSourceLabel(source, language = 'en') {
  if (source === 'session override') {
    return language === 'en' ? 'session override' : '频道覆盖';
  }
  if (source === 'parent channel') {
    return language === 'en' ? 'parent channel' : '父频道默认';
  }
  if (source === 'config.toml') {
    return 'config.toml';
  }
  if (source === 'env default') {
    return language === 'en' ? 'env default' : '环境默认';
  }
  return language === 'en' ? 'provider default' : 'provider 默认';
}

function formatModelValue(modelSetting, language = 'en') {
  const value = String(modelSetting?.value || '').trim();
  const source = String(modelSetting?.source || 'provider').trim();
  if (!value) {
    return language === 'en' ? 'unknown model' : '未知 model';
  }
  if (source === 'config.toml') {
    return `\`${value}\` (config.toml)`;
  }
  if (source === 'provider') {
    return `\`${value}\``;
  }
  return `\`${value}\` (${formatSettingSourceLabel(source, language)})`;
}

export function createPromptProgressReporterFactory({
  defaultUiLanguage = 'zh',
  progressUpdatesEnabled = true,
  progressProcessLines = 2,
  progressUpdateIntervalMs = 15000,
  progressEventFlushMs = 5000,
  progressEventDedupeWindowMs = 2500,
  progressIncludeStdout = true,
  progressIncludeStderr = false,
  progressTextPreviewChars = 140,
  progressProcessPushIntervalMs = 1100,
  progressMessageMaxChars = 1800,
  progressPlanMaxLines = 4,
  progressDoneStepsMax = 4,
  safeReply = async () => null,
  normalizeUiLanguage = defaultNormalizeUiLanguage,
  slashRef = (name) => `/${name}`,
  resolveModelSetting = () => ({ value: null, source: 'provider' }),
  resolveReasoningEffortSetting = () => ({ value: '', source: 'provider' }),
  resolveFastModeSetting = () => ({ enabled: false, supported: false, source: 'provider unsupported' }),
  truncate = defaultTruncate,
  humanElapsed = (ms) => `${ms}ms`,
  createProgressEventDeduper = () => () => false,
  buildProgressEventDedupeKey = () => '',
  presentation = {},
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onStreamProcessMessage = null,
} = {}) {
  const {
    summarizeCodexEvent = () => '',
    extractRawProgressTextFromEvent = () => '',
    cloneProgressPlan = (plan) => plan,
    extractPlanStateFromEvent = () => null,
    extractCompletedStepFromEvent = () => null,
    appendCompletedStep = () => {},
    appendRecentActivity = () => {},
    formatProgressPlanSummary = () => '',
    renderProcessContentLines = () => [],
    localizeProgressLines = (lines) => lines,
    renderProgressPlanLines = () => [],
    renderCompletedStepsLines = () => [],
    formatRuntimePhaseLabel = (phase) => String(phase || ''),
    sanitizeProgressDisplayText = sanitizeDiscordDisplayText,
  } = presentation;

  return function createProgressReporter({
    message,
    channelState,
    session = null,
    language = defaultUiLanguage,
    processLines = progressProcessLines,
    initialLatestStep = '',
    onStreamProcessMessage: onStreamProcessMessageForRun = onStreamProcessMessage,
  } = {}) {
    const lang = normalizeUiLanguage(language);
    const processLineLimit = Math.max(1, Math.min(5, Number(processLines || progressProcessLines)));
    const seededLatestStep = sanitizeProgressDisplayText(
      String(initialLatestStep || '').trim() || getDefaultLatestStep(lang),
    );

    if (!progressUpdatesEnabled) {
      return createNoopProgressReporter({
        channelState,
        initialLatestStep: seededLatestStep,
        now,
      });
    }

    const startedAt = now();
    let progressMessage = null;
    let timer = null;
    let activityTimer = null;
    let stopped = false;
    let lastEmitAt = 0;
    let lastRendered = '';
    let events = 0;
    let latestStep = seededLatestStep;
    let planState = cloneProgressPlan(channelState?.activeRun?.progressPlan);
    const completedSteps = Array.isArray(channelState?.activeRun?.completedSteps)
      ? [...channelState.activeRun.completedSteps]
      : [];
    const recentActivities = Array.isArray(channelState?.activeRun?.recentActivities)
      ? [...channelState.activeRun.recentActivities]
      : [];
    const pendingStreamActivities = [];
    let lastActivityPushAt = 0;
    let isEmitting = false;
    let rerunEmit = false;
    const isDuplicateProgressEvent = createProgressEventDeduper({
      ttlMs: progressEventDedupeWindowMs,
      maxKeys: 700,
    });
    const claudeProgressTracker = createClaudeProgressTracker({
      truncateText: truncate,
      previewChars: progressTextPreviewChars,
    });

    const syncActiveRun = () => {
      if (!channelState?.activeRun) return;
      channelState.activeRun.progressEvents = events;
      channelState.activeRun.lastProgressText = latestStep;
      channelState.activeRun.lastProgressAt = now();
      channelState.activeRun.progressPlan = cloneProgressPlan(planState);
      channelState.activeRun.completedSteps = [...completedSteps];
      channelState.activeRun.recentActivities = [...recentActivities];
      if (progressMessage?.id) {
        channelState.activeRun.progressMessageId = progressMessage.id;
      }
    };

    const render = (status = 'running') => {
      const elapsed = humanElapsed(Math.max(0, now() - startedAt));
      const phase = formatRuntimePhaseLabel(channelState?.activeRun?.phase || 'starting', lang);
      const effort = formatEffortValue(resolveReasoningEffortSetting(session), session?.provider, lang);
      const fastMode = formatFastModeValue(resolveFastModeSetting(session), lang);
      const model = formatModelValue(resolveModelSetting(session), lang);
      const hint = status === 'running'
        ? (lang === 'en'
          ? 'Use `!c` to interrupt.'
          : '可用 `!c` 中断。')
        : (lang === 'en'
          ? 'Send the next message when ready.'
          : '准备好后直接发送下一条消息。');
      const statusLine = status === 'running'
        ? (lang === 'en' ? '⏳ **Task Running**' : '⏳ **任务进行中**')
        : status;
      const lines = [
        statusLine,
        `${lang === 'en' ? '• elapsed' : '• 耗时'}: ${elapsed}`,
        `${lang === 'en' ? '• phase' : '• 阶段'}: ${phase}`,
        `${lang === 'en' ? '• model' : '• model'}: ${model}`,
        effort ? `${lang === 'en' ? '• effort' : '• effort'}: ${effort}` : null,
        fastMode ? `${lang === 'en' ? '• fast mode' : '• fast mode'}: ${fastMode}` : null,
        `${lang === 'en' ? '• event count' : '• 事件数'}: ${events}`,
        `${lang === 'en' ? '• latest activity' : '• 最新活动'}: ${sanitizeProgressDisplayText(latestStep)}`,
        ...renderProcessContentLines(recentActivities, lang, processLineLimit),
        ...localizeProgressLines(renderProgressPlanLines(planState, progressPlanMaxLines), lang),
        ...localizeProgressLines(renderCompletedStepsLines(completedSteps, {
          planState,
          latestStep,
          maxSteps: progressDoneStepsMax,
        }), lang),
        `${lang === 'en' ? '• queued prompts' : '• 排队任务'}: ${channelState?.queue?.length || 0}`,
        `${lang === 'en' ? '• hint' : '• 提示'}: ${hint}`,
      ].filter(Boolean);
      return joinLinesWithinLimit(lines, progressMessageMaxChars, truncate);
    };

    const buildPayload = (body) => {
      return {
        content: body,
        components: [],
      };
    };

    const emit = async (force = false) => {
      if (!progressMessage || stopped) return;
      if (isEmitting) {
        rerunEmit = true;
        return;
      }

      const currentTime = now();
      if (!force && currentTime - lastEmitAt < progressEventFlushMs) return;
      const body = render('running');
      const payload = buildPayload(body);
      if (!force && body === lastRendered) return;

      isEmitting = true;
      try {
        await progressMessage.edit(payload);
        lastEmitAt = now();
        lastRendered = body;
        syncActiveRun();
      } catch {
        // ignore edit failures
      } finally {
        isEmitting = false;
        if (rerunEmit && !stopped) {
          rerunEmit = false;
          void emit(false);
        }
      }
    };

    const appendActivity = (activityText) => {
      const text = String(activityText || '').replace(/\s+/g, ' ').trim();
      if (!text) return false;
      const key = normalizeActivityKey(text);
      if (!key) return false;

      const latestVisible = normalizeActivityKey(recentActivities[recentActivities.length - 1]);
      if (latestVisible && latestVisible === key) return false;
      const latestQueued = normalizeActivityKey(pendingStreamActivities[pendingStreamActivities.length - 1]);
      if (latestQueued && latestQueued === key) return false;

      appendRecentActivity(recentActivities, text);
      pendingStreamActivities.push(text);
      if (pendingStreamActivities.length > 80) {
        pendingStreamActivities.splice(0, pendingStreamActivities.length - 80);
      }
      return true;
    };

    const pushOneStreamActivity = ({ force = false } = {}) => {
      if (!pendingStreamActivities.length) return false;
      const currentTime = now();
      if (!force && currentTime - lastActivityPushAt < progressProcessPushIntervalMs) return false;
      const next = pendingStreamActivities.shift();
      if (!next) return false;
      if (typeof onStreamProcessMessageForRun === 'function') {
        try {
          Promise.resolve(
            onStreamProcessMessageForRun(next, { message, session, channelState, language: lang }),
          ).catch(() => {});
        } catch {
          // ignore stream failures
        }
      }
      lastActivityPushAt = currentTime;
      return true;
    };

    const setLatestStep = (value, { forceEmit = true } = {}) => {
      const next = String(value || '').trim();
      if (!next) return;
      latestStep = next;
      syncActiveRun();
      if (!stopped) {
        void emit(forceEmit);
      }
    };

    const sync = ({ forceEmit = false } = {}) => {
      syncActiveRun();
      if (!stopped) {
        void emit(forceEmit);
      }
    };

    const start = async () => {
      syncActiveRun();
      try {
        const body = render('running');
        progressMessage = await safeReply(message, buildPayload(body));
        lastEmitAt = now();
        lastRendered = body;
        syncActiveRun();
        timer = setIntervalFn(() => {
          void emit(true);
        }, progressUpdateIntervalMs);
        timer?.unref?.();
        activityTimer = setIntervalFn(() => {
          if (stopped) return;
          if (!pushOneStreamActivity()) return;
          syncActiveRun();
          void emit(false);
        }, progressProcessPushIntervalMs);
        activityTimer?.unref?.();
      } catch {
        progressMessage = null;
      }
    };

    const onEvent = (event) => {
      if (stopped) return;
      const providerProgress = session?.provider === 'claude'
        ? (claudeProgressTracker.capture(event) || null)
        : null;
      const summaryStep = providerProgress?.summaryStep || summarizeCodexEvent(event);
      const rawActivities = providerProgress?.rawActivities?.length
        ? providerProgress.rawActivities
        : (() => {
          const raw = extractRawProgressTextFromEvent(event);
          return raw ? [raw] : [];
        })();
      const nextPlan = extractPlanStateFromEvent(event);
      const completedStepsFromEvent = providerProgress?.completedSteps?.length
        ? providerProgress.completedSteps
        : (() => {
          const step = extractCompletedStepFromEvent(event);
          return step ? [step] : [];
        })();
      const safeSummaryStep = sanitizeProgressDisplayText(summaryStep);
      const safeRawActivities = rawActivities
        .map((item) => sanitizeProgressDisplayText(item))
        .filter(Boolean);
      const safeCompletedStepsFromEvent = completedStepsFromEvent
        .map((item) => sanitizeProgressDisplayText(item))
        .filter(Boolean);
      const dedupeKey = buildProgressEventDedupeKey({
        summaryStep: safeSummaryStep,
        rawActivity: safeRawActivities.join(' || '),
        completedStep: safeCompletedStepsFromEvent.join(' || '),
        planSummary: formatProgressPlanSummary(nextPlan),
      });
      if (isDuplicateProgressEvent(dedupeKey)) return;

      events += 1;
      if (shouldPromoteLatestStep(safeSummaryStep, latestStep)) {
        latestStep = safeSummaryStep;
      } else if (!latestStep && safeSummaryStep) {
        latestStep = safeSummaryStep;
      }
      for (const rawActivity of safeRawActivities) {
        if (!rawActivity) continue;
        const appended = appendActivity(rawActivity);
        if (appended) {
          if (lastActivityPushAt === 0) {
            pushOneStreamActivity({ force: true });
          } else {
            pushOneStreamActivity();
          }
        }
      }
      if (nextPlan) {
        planState = nextPlan;
        for (const item of nextPlan.steps) {
          if (item.status === 'completed') {
            appendCompletedStep(completedSteps, item.step);
          }
        }
      }
      for (const completedStep of safeCompletedStepsFromEvent) {
        if (completedStep) appendCompletedStep(completedSteps, completedStep);
      }
      syncActiveRun();
      void emit(false);
    };

    const onLog = (line, source) => {
      if (stopped) return;
      if (source === 'stderr' && !progressIncludeStderr) return;
      if (source === 'stdout' && !progressIncludeStdout) return;

      events += 1;
      const sourceLabel = lang === 'en'
        ? source
        : (source === 'stderr' ? '标准错误' : '标准输出');
      latestStep = sanitizeProgressDisplayText(
        `${sourceLabel}: ${truncate(String(line || '').replace(/\s+/g, ' ').trim(), progressTextPreviewChars)}`,
      );
      syncActiveRun();
      void emit(false);
    };

    const finish = async ({ ok = false, cancelled = false, timedOut = false, error = '' } = {}) => {
      if (stopped) return;
      stopped = true;
      if (timer) clearIntervalFn(timer);
      if (activityTimer) clearIntervalFn(activityTimer);
      pendingStreamActivities.length = 0;
      latestStep = getFinalLatestStep({
        ok,
        cancelled,
        timedOut,
        latestStep,
        language: lang,
      });
      if (channelState?.activeRun) {
        channelState.activeRun.phase = 'done';
      }
      syncActiveRun();
      if (!progressMessage) return;

      const elapsed = humanElapsed(Math.max(0, now() - startedAt));
      const status = cancelled
        ? (lang === 'en' ? '🛑 **Task Cancelled**' : '🛑 **任务已中断**')
        : ok
          ? (lang === 'en' ? '✅ **Task Completed**' : '✅ **任务已完成**')
          : timedOut
            ? (lang === 'en' ? '⏱️ **Task Timed Out**' : '⏱️ **任务超时**')
            : (lang === 'en' ? '❌ **Task Failed**' : '❌ **任务失败**');
      const lines = [
        status,
        `${lang === 'en' ? '• elapsed' : '• 耗时'}: ${elapsed}`,
        `${lang === 'en' ? '• phase' : '• 阶段'}: ${formatRuntimePhaseLabel(channelState?.activeRun?.phase || 'done', lang)}`,
        `${lang === 'en' ? '• model' : '• model'}: ${formatModelValue(resolveModelSetting(session), lang)}`,
        `${lang === 'en' ? '• event count' : '• 事件数'}: ${events}`,
        `${lang === 'en' ? '• latest activity' : '• 最新活动'}: ${latestStep}`,
        ...renderProcessContentLines(recentActivities, lang, processLineLimit),
        ...localizeProgressLines(renderProgressPlanLines(planState, progressPlanMaxLines), lang),
        ...localizeProgressLines(renderCompletedStepsLines(completedSteps, {
          planState,
          latestStep,
          maxSteps: progressDoneStepsMax,
        }), lang),
        !ok && !cancelled && error ? `${lang === 'en' ? '• error' : '• 错误'}: ${truncate(String(error), 260)}` : null,
      ].filter(Boolean);
      const safeBody = joinLinesWithinLimit(lines, progressMessageMaxChars, truncate);

      try {
        await progressMessage.edit(buildPayload(safeBody));
      } catch {
        // ignore
      }
    };

    return {
      start,
      sync,
      setLatestStep,
      onEvent,
      onLog,
      finish,
    };
  };
}
