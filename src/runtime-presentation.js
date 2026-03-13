import {
  appendRecentActivity as appendRecentActivityBase,
  appendCompletedStep as appendCompletedStepBase,
  cloneProgressPlan as cloneProgressPlanBase,
  extractRawProgressTextFromEvent as extractRawProgressTextFromEventBase,
  extractCompletedStepFromEvent as extractCompletedStepFromEventBase,
  extractPlanStateFromEvent as extractPlanStateFromEventBase,
  renderRecentActivitiesLines as renderRecentActivitiesLinesBase,
  formatProgressPlanSummary as formatProgressPlanSummaryBase,
  renderProgressPlanLines as renderProgressPlanLinesBase,
  summarizeCodexEvent as summarizeCodexEventBase,
} from './progress-utils.js';
import {
  formatCompletedMilestonesSummary,
  renderCompletedMilestonesLines,
} from './progress-milestones.js';
import { humanAge as defaultHumanAge } from './runtime-utils.js';

export function createRuntimePresentation({
  showReasoning = false,
  progressTextPreviewChars = 140,
  progressDoneStepsMax = 4,
  progressActivityMaxLines = 4,
  progressProcessLines = 2,
  humanAge = defaultHumanAge,
  getSessionId = () => null,
  getSessionProvider = () => 'codex',
  formatSessionIdLabel = (sessionId) => `\`${sessionId || '(auto — 下条消息新建)'}\``,
} = {}) {
  function formatRuntimePhaseLabel(phase, language = 'en') {
    const value = String(phase || '').trim().toLowerCase();
    if (language === 'en') {
      if (value === 'workspace') return 'waiting for workspace';
      return value || 'unknown';
    }
    switch (value) {
      case 'starting':
        return '启动中';
      case 'workspace':
        return '等待工作目录';
      case 'compact':
        return '上下文压缩';
      case 'exec':
        return '执行中';
      case 'retry':
        return '重试中';
      case 'done':
        return '已结束';
      default:
        return value || '未知';
    }
  }

  function localizeProgressLine(line, language = 'en') {
    if (language === 'en') return line;
    const text = String(line || '');
    return text
      .replace(/^• activity (\d+): /, '• 活动 $1：')
      .replace(/^• plan: received$/, '• 计划：已接收')
      .replace(/^• plan: (\d+)\/(\d+) completed(?:, (\d+) in progress)?$/, (_m, completed, total, inProgress) => (
        `• 计划：${completed}/${total} 已完成${inProgress ? `，${inProgress} 进行中` : ''}`
      ))
      .replace(/^• completed milestones: /, '• 已完成里程碑：')
      .replace(/^• completed steps: /, '• 已完成步骤：')
      .replace(/^  note: /, '  说明：')
      .replace(/^  … \+(\d+) more$/, '  … 还有 $1 项');
  }

  function localizeProgressLines(lines, language = 'en') {
    if (!Array.isArray(lines) || !lines.length) return [];
    return lines.map((line) => localizeProgressLine(line, language));
  }

  function renderProcessContentLines(activities, language = 'en', count = progressProcessLines) {
    const limit = Math.max(1, Math.min(5, Number(count || progressProcessLines)));
    const visible = Array.isArray(activities)
      ? activities
        .slice(-limit)
        .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      : [];
    if (!visible.length) return [];
    const title = language === 'en' ? '• process content:' : '• 过程内容：';
    return [
      title,
      ...visible.map((line) => `  · ${line}`),
    ];
  }

  function formatRuntimeLabel(runtime, language = 'en') {
    if (!runtime.running) return language === 'en' ? 'idle' : '空闲';
    const age = runtime.activeSinceMs === null ? (language === 'en' ? 'just-now' : '刚刚') : humanAge(runtime.activeSinceMs);
    const phaseLabel = runtime.phase ? formatRuntimePhaseLabel(runtime.phase, language) : '';
    const phase = phaseLabel ? `${language === 'en' ? ', phase=' : '，阶段='}${phaseLabel}` : '';
    const pid = runtime.pid ? `${language === 'en' ? ', pid=' : '，pid='}${runtime.pid}` : '';
    return language === 'en' ? `running (${age}${phase}${pid})` : `运行中（${age}${phase}${pid}）`;
  }

  function formatTimeoutLabel(timeoutMs) {
    const n = Number(timeoutMs);
    if (!Number.isFinite(n) || n <= 0) return 'off (no hard timeout)';
    return `${n}ms (~${humanAge(n)})`;
  }

  function formatSessionStatusLabel(session) {
    const sessionId = getSessionId(session);
    return session.name
      ? `**${session.name}** (${formatSessionIdLabel(sessionId || 'auto')})`
      : formatSessionIdLabel(sessionId);
  }

  function formatPermissionsLabel(session, language = 'en') {
    const provider = getSessionProvider(session);
    if (provider === 'gemini') {
      if (session.mode === 'dangerous') {
        return language === 'en'
          ? 'full access (--yolo)'
          : '完全权限（--yolo）';
      }
      return language === 'en'
        ? 'sandboxed (--sandbox --approval-mode default)'
        : '沙盒模式（--sandbox --approval-mode default）';
    }
    if (provider === 'claude') {
      if (session.mode === 'dangerous') {
        return language === 'en'
          ? 'full access (--dangerously-skip-permissions)'
          : '完全权限（--dangerously-skip-permissions）';
      }
      return language === 'en'
        ? 'auto-edit (--permission-mode acceptEdits)'
        : '自动编辑（--permission-mode acceptEdits）';
    }
    if (session.mode === 'dangerous') {
      return language === 'en'
        ? 'full access (--dangerously-bypass-approvals-and-sandbox)'
        : '完全权限（--dangerously-bypass-approvals-and-sandbox）';
    }
    return language === 'en'
      ? 'sandboxed (--full-auto)'
      : '沙盒模式（--full-auto）';
  }

  function summarizeCodexEvent(ev) {
    return summarizeCodexEventBase(ev, {
      showReasoning,
      previewChars: progressTextPreviewChars,
    });
  }

  function extractRawProgressTextFromEvent(ev) {
    return extractRawProgressTextFromEventBase(ev);
  }

  function cloneProgressPlan(planState) {
    return cloneProgressPlanBase(planState, {
      previewChars: progressTextPreviewChars,
    });
  }

  function extractPlanStateFromEvent(ev) {
    return extractPlanStateFromEventBase(ev, {
      previewChars: progressTextPreviewChars,
    });
  }

  function extractCompletedStepFromEvent(ev) {
    return extractCompletedStepFromEventBase(ev, {
      previewChars: progressTextPreviewChars,
    });
  }

  function appendCompletedStep(list, stepText) {
    appendCompletedStepBase(list, stepText, {
      previewChars: progressTextPreviewChars,
      doneStepsMax: progressDoneStepsMax,
    });
  }

  function appendRecentActivity(list, activityText) {
    appendRecentActivityBase(list, activityText, {
      previewChars: progressTextPreviewChars,
      maxSteps: 5,
      truncateText: false,
      preserveWhitespace: true,
    });
  }

  function formatProgressPlanSummary(planState) {
    return formatProgressPlanSummaryBase(planState);
  }

  function renderProgressPlanLines(planState, maxLines) {
    return renderProgressPlanLinesBase(planState, maxLines);
  }

  function renderRecentActivitiesLines(activities, maxLines = progressActivityMaxLines) {
    return renderRecentActivitiesLinesBase(activities, {
      maxSteps: Math.max(1, Number(maxLines || progressActivityMaxLines)),
      previewChars: progressTextPreviewChars,
    });
  }

  function formatCompletedStepsSummary(steps, options = {}) {
    return formatCompletedMilestonesSummary(steps, {
      ...options,
      maxSteps: Math.max(1, Number(options.maxSteps || progressDoneStepsMax)),
    });
  }

  function renderCompletedStepsLines(steps, options = {}) {
    return renderCompletedMilestonesLines(steps, {
      ...options,
      maxSteps: Math.max(1, Number(options.maxSteps || progressDoneStepsMax)),
    });
  }

  return {
    appendCompletedStep,
    appendRecentActivity,
    cloneProgressPlan,
    extractCompletedStepFromEvent,
    extractPlanStateFromEvent,
    extractRawProgressTextFromEvent,
    formatCompletedStepsSummary,
    formatPermissionsLabel,
    formatProgressPlanSummary,
    formatRuntimeLabel,
    formatRuntimePhaseLabel,
    formatSessionStatusLabel,
    formatTimeoutLabel,
    localizeProgressLine,
    localizeProgressLines,
    renderCompletedStepsLines,
    renderProcessContentLines,
    renderProgressPlanLines,
    renderRecentActivitiesLines,
    summarizeCodexEvent,
  };
}
