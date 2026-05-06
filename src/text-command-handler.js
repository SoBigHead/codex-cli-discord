import fs from 'node:fs';
import {
  getProviderCommandAlias,
  normalizeCommandName,
} from './command-spec.js';
import {
  createProviderForkThread,
  formatProviderForkResult,
  normalizeForkSessionId,
  parseForkTextInput,
  providerSupportsNativeFork,
} from './codex-fork-flow.js';
import {
  CODEX_GOAL_CONTINUATION_PROMPT,
  executeCodexGoalAction,
  formatCodexGoalResult,
  parseCodexGoalTextInput,
  shouldStartCodexGoalContinuation,
} from './codex-goal-flow.js';
import {
  formatProjectUpgradeReport,
  parseProjectUpgradeTextInput,
} from './project-upgrade.js';
import { buildPromptFromMessage, formatAttachmentsForPrompt } from './discord-message-input.js';

function isExistingDirectory(dir) {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function formatModelCommandHelp(provider = 'codex') {
  if (provider === 'claude') {
    return '用法：`!model <name|default>`\n例：`!model sonnet` / `!model opus` / `!model default`';
  }
  return '用法：`!model <name|default>`\n例：`!model o3` / `!model gpt-5.3-codex` / `!model default`';
}

function buildGoalTextInput(arg = '', attachments = null) {
  const text = String(arg || '').trim();
  const attachmentBlock = formatAttachmentsForPrompt(attachments);
  if (!attachmentBlock) return text || 'status';

  const [verbRaw, ...rest] = text.split(/\s+/);
  const verb = String(verbRaw || '').trim().toLowerCase();
  const controlVerbs = new Set([
    'status', 'show', 'state', '查看', '状态',
    'clear', 'delete', 'remove', 'unset', '清除',
    'pause', 'paused', '暂停',
    'resume', 'active', 'start', 'continue', '恢复', '继续',
    'done', 'complete', 'completed', 'finish', '完成',
    'budget', 'token_budget', 'tokens',
  ]);

  if (controlVerbs.has(verb)) return text;
  if (verb === 'set') {
    const objective = buildPromptFromMessage(rest.join(' '), attachments);
    return `set ${objective}`;
  }
  return buildPromptFromMessage(text, attachments);
}

export function createTextCommandHandler({
  botProvider = null,
  enableConfigCmd = false,
  getSession,
  saveDb,
  getSessionId = (session) => session?.runnerSessionId || session?.codexThreadId || null,
  getSessionProvider,
  getSessionLanguage,
  getProviderDisplayName,
  commandActions = {},
  isOnboardingEnabled,
  safeReply,
  formatHelpReport,
  formatStatusReport,
  formatQueueReport,
  formatDoctorReport,
  formatWorkspaceReport,
  formatWorkspaceSetHelp,
  formatWorkspaceUpdateReport,
  formatDefaultWorkspaceSetHelp,
  formatDefaultWorkspaceUpdateReport,
  formatOnboardingConfigHelp,
  formatOnboardingConfigReport,
  formatOnboardingDisabledMessage,
  formatOnboardingReport,
  formatLanguageConfigHelp,
  formatLanguageConfigReport,
  formatFastModeConfigHelp = () => '',
  formatFastModeConfigReport = () => '',
  formatRuntimeModeConfigHelp = () => '',
  formatRuntimeModeConfigReport = () => '',
  formatProfileConfigHelp,
  formatProfileConfigReport,
  formatTimeoutConfigHelp,
  formatTimeoutConfigReport,
  formatProgressReport,
  formatCancelReport,
  formatCompactStrategyConfigHelp,
  formatCompactConfigReport,
  formatExtraInfoConfigHelp,
  formatExtraInfoConfigReport,
  formatCompactConfigUnsupported = (provider) => `Compact config unsupported for ${provider}`,
  formatProviderRawConfigSurface = (provider) => `raw config surface unavailable for ${provider}`,
  formatProviderSessionLabel = (provider) => `${provider} session`,
  formatReasoningEffortHelp,
  formatReasoningEffortUnsupported,
  parseProviderInput,
  parseWorkspaceCommandAction,
  parseOnboardingConfigAction,
  parseUiLanguageInput,
  parseFastModeAction = () => ({ type: 'status' }),
  parseRuntimeModeAction = () => ({ type: 'status' }),
  parseSecurityProfileInput,
  parseTimeoutConfigAction,
  parseCompactConfigFromText,
  parseExtraInfoConfigFromText,
  getProjectUpgradeStatus = async () => ({ ok: false, error: 'project upgrade unavailable' }),
  setProjectUpgradeMode = null,
  applyProjectUpgrade = null,
  requestProjectUpgradeRestart = null,
  canManageProjectUpgrade = () => true,
  parseConfigKey,
  parseReasoningEffortInput,
  getEffectiveSecurityProfile,
  resolveFastModeSetting = () => ({ enabled: false, supported: false, source: 'provider unsupported' }),
  resolveRuntimeModeSetting = () => ({ mode: 'normal', supported: false, source: 'provider unsupported' }),
  resolveTimeoutSetting,
  describeConfigPolicy,
  isConfigKeyAllowed,
  providerSupportsCompactConfigAction = () => true,
  providerSupportsRawConfigOverrides = () => false,
  isReasoningEffortSupported,
  getRuntimeSnapshot = () => ({ running: false, queued: 0 }),
  cancelChannelWork,
  closeRuntimeSession = () => false,
  forkCodexThread,
  resolveForkWorkspace,
  getCodexThreadGoal,
  setCodexThreadGoal,
  clearCodexThreadGoal,
  enqueuePrompt,
  resolveSecurityContext,
  openWorkspaceBrowser,
  resolvePath,
  safeError,
} = {}) {
  async function maybeEnqueueCodexGoalContinuation({ action, result, message, key, session }) {
    if (!shouldStartCodexGoalContinuation(action, result)) return result;
    if (typeof enqueuePrompt !== 'function') {
      return { ...result, continuation: { state: 'failed', reason: 'enqueue unavailable' } };
    }
    try {
      const security = typeof resolveSecurityContext === 'function'
        ? resolveSecurityContext(message.channel, session)
        : null;
      const queued = await enqueuePrompt(message, key, CODEX_GOAL_CONTINUATION_PROMPT, security);
      if (queued?.enqueued) {
        return {
          ...result,
          continuation: {
            state: 'enqueued',
            queuedAhead: queued.queuedAhead || 0,
          },
        };
      }
      return {
        ...result,
        continuation: {
          state: 'failed',
          reason: queued?.reason || 'enqueue failed',
        },
      };
    } catch (err) {
      return {
        ...result,
        continuation: {
          state: 'failed',
          reason: safeError(err),
        },
      };
    }
  }

  const closeRuntimeForKey = (key, reason = 'runtime config changed') => {
    try {
      closeRuntimeSession(key, reason);
    } catch {
    }
  };

  return async function handleCommand(message, key, content) {
    const [cmd, ...rest] = content.split(/\s+/);
    const arg = rest.join(' ').trim();
    const session = getSession(key, { channel: message.channel || null });
    const commandName = normalizeCommandName(cmd, { allowBangPrefix: true });

    switch (commandName) {
      case 'help': {
        await safeReply(message, formatHelpReport(session));
        break;
      }

      case 'status': {
        await safeReply(message, await formatStatusReport(key, session, message.channel));
        break;
      }

      case 'queue': {
        await safeReply(message, formatQueueReport(key, session, message.channel));
        break;
      }

      case 'upgrade': {
        const language = getSessionLanguage(session);
        const action = parseProjectUpgradeTextInput(arg);
        if (action.type === 'set_mode') {
          if (!canManageProjectUpgrade(message.author?.id)) {
            await safeReply(message, '❌ 只有项目升级管理员可以修改升级模式。');
            break;
          }
          if (typeof setProjectUpgradeMode !== 'function') {
            await safeReply(message, '❌ 当前环境未启用项目升级设置。');
            break;
          }
          await safeReply(message, formatProjectUpgradeReport(null, language, { changedMode: setProjectUpgradeMode(action.mode) }));
          break;
        }
        if (action.type === 'apply') {
          if (!canManageProjectUpgrade(message.author?.id)) {
            await safeReply(message, '❌ 只有项目升级管理员可以执行升级。');
            break;
          }
          if (typeof applyProjectUpgrade !== 'function') {
            await safeReply(message, '❌ 当前环境未启用项目升级。');
            break;
          }
          const result = await applyProjectUpgrade();
          await safeReply(message, formatProjectUpgradeReport(null, language, { applyResult: result }));
          if (result?.ok && result.changed && typeof requestProjectUpgradeRestart === 'function') {
            setTimeout(() => requestProjectUpgradeRestart(), 750);
          }
          break;
        }
        if (action.type === 'help') {
          await safeReply(message, '用法：`!upgrade <status|apply|off|notify|auto>`');
          break;
        }
        await safeReply(message, formatProjectUpgradeReport(await getProjectUpgradeStatus({ fetch: true }), language));
        break;
      }

      case 'doctor': {
        await safeReply(message, formatDoctorReport(key, session, message.channel));
        break;
      }

      case 'provider': {
        if (botProvider) {
          await safeReply(message, `🔒 当前 bot 已锁定 provider = \`${botProvider}\` (${getProviderDisplayName(botProvider)})，不能切换。`);
          break;
        }
        if (!arg || ['status', 'state', 'show', '查看', '状态'].includes(arg.toLowerCase())) {
          const provider = getSessionProvider(session);
          await safeReply(message, `ℹ️ 当前 provider = \`${provider}\` (${getProviderDisplayName(provider)})`);
          break;
        }
        const requested = parseProviderInput(arg);
        if (!requested) {
          await safeReply(message, '用法：`!provider <codex|claude|gemini|status>`');
          break;
        }
        const { previous } = commandActions.setProvider(session, requested);
        closeRuntimeForKey(key);
        await safeReply(message, `✅ provider = \`${requested}\` (${getProviderDisplayName(requested)})${previous === requested ? '' : '，已清空旧 session 绑定'}`);
        break;
      }

      case 'onboarding': {
        const language = getSessionLanguage(session);
        const onboardingOp = parseOnboardingConfigAction(arg);
        if (onboardingOp) {
          if (onboardingOp.type === 'invalid') {
            await safeReply(message, formatOnboardingConfigHelp(language));
            break;
          }
          if (onboardingOp.type === 'status') {
            await safeReply(message, formatOnboardingConfigReport(language, isOnboardingEnabled(session), false));
            break;
          }
          if (onboardingOp.type === 'set') {
            const { enabled } = commandActions.setOnboardingEnabled(session, onboardingOp.enabled);
            await safeReply(message, formatOnboardingConfigReport(language, enabled, true));
            break;
          }
        }
        if (!isOnboardingEnabled(session)) {
          await safeReply(message, formatOnboardingDisabledMessage(language));
          break;
        }
        await safeReply(message, formatOnboardingReport(key, session, message.channel, language));
        break;
      }

      case 'language': {
        const requested = parseUiLanguageInput(arg);
        if (!requested) {
          await safeReply(message, formatLanguageConfigHelp(getSessionLanguage(session)));
          break;
        }
        const { language } = commandActions.setLanguage(session, requested);
        await safeReply(message, formatLanguageConfigReport(language, true));
        break;
      }

      case 'profile': {
        const language = getSessionLanguage(session);
        if (!arg || ['status', 'state', 'show', '查看', '状态'].includes(arg.toLowerCase())) {
          await safeReply(message, formatProfileConfigReport(language, getEffectiveSecurityProfile(session).profile, false));
          break;
        }
        const profile = parseSecurityProfileInput(arg);
        if (!profile) {
          await safeReply(message, formatProfileConfigHelp(language));
          break;
        }
        const { profile: nextProfile } = commandActions.setSecurityProfile(session, profile);
        await safeReply(message, formatProfileConfigReport(language, nextProfile, true));
        break;
      }

      case 'timeout': {
        const language = getSessionLanguage(session);
        const parsedTimeout = parseTimeoutConfigAction(arg || 'status');
        if (!parsedTimeout || parsedTimeout.type === 'invalid') {
          await safeReply(message, formatTimeoutConfigHelp(language));
          break;
        }
        if (parsedTimeout.type === 'status') {
          await safeReply(message, formatTimeoutConfigReport(language, resolveTimeoutSetting(session), false));
          break;
        }
        const { timeoutSetting } = commandActions.setTimeoutMs(session, parsedTimeout.timeoutMs);
        await safeReply(message, formatTimeoutConfigReport(language, timeoutSetting, true));
        break;
      }

      case 'progress': {
        await safeReply(message, formatProgressReport(key, session, message.channel));
        break;
      }

      case 'cancel': {
        const outcome = cancelChannelWork(key, `text_command:${String(cmd || '').trim().toLowerCase()}`);
        await safeReply(message, formatCancelReport(outcome));
        break;
      }

      case 'new': {
        const outcome = cancelChannelWork(key, `text_command:${String(cmd || '').trim().toLowerCase()}`);
        commandActions.startNewSession(session);
        closeRuntimeForKey(key, 'new session');
        const lines = ['🆕 已切换到新会话。'];
        if (outcome.cancelledRunning) lines.push('当前运行中的任务已尝试取消。');
        if (outcome.clearedQueued > 0) lines.push(`已清空 ${outcome.clearedQueued} 个排队任务。`);
        lines.push('下一条普通消息会开启新的上下文。');
        await safeReply(message, lines.join('\n'));
        break;
      }

      case 'setdir': {
        if (!arg) {
          await safeReply(message, formatWorkspaceSetHelp(getSessionLanguage(session)));
          return;
        }
        const action = parseWorkspaceCommandAction(arg);
        if (!action || action.type === 'invalid') {
          await safeReply(message, formatWorkspaceSetHelp(getSessionLanguage(session)));
          return;
        }
        if (action.type === 'status') {
          await safeReply(message, formatWorkspaceReport(key, session));
          return;
        }
        if (action.type === 'clear') {
          const result = commandActions.clearWorkspaceDir(session, key);
          closeRuntimeForKey(key);
          await safeReply(message, formatWorkspaceUpdateReport(key, session, result));
          return;
        }
        if (action.type === 'browse') {
          if (typeof openWorkspaceBrowser !== 'function') {
            await safeReply(message, formatWorkspaceSetHelp(getSessionLanguage(session)));
            return;
          }
          await safeReply(message, openWorkspaceBrowser({
            key,
            session,
            userId: message.author?.id,
            mode: 'thread',
          }));
          return;
        }
        const resolved = resolvePath(action.value);
        if (!isExistingDirectory(resolved)) {
          await safeReply(message, `❌ 目录不存在或不是目录：\`${resolved}\``);
          return;
        }
        const result = commandActions.setWorkspaceDir(session, key, resolved);
        closeRuntimeForKey(key);
        await safeReply(message, formatWorkspaceUpdateReport(key, session, result));
        break;
      }

      case 'setdefaultdir': {
        if (!arg) {
          await safeReply(message, formatDefaultWorkspaceSetHelp(getSessionLanguage(session)));
          return;
        }
        const action = parseWorkspaceCommandAction(arg);
        if (!action || action.type === 'invalid') {
          await safeReply(message, formatDefaultWorkspaceSetHelp(getSessionLanguage(session)));
          return;
        }
        if (action.type === 'status') {
          await safeReply(message, formatWorkspaceReport(key, session));
          return;
        }
        if (action.type === 'clear') {
          const result = commandActions.setDefaultWorkspaceDir(session, null);
          closeRuntimeForKey(key);
          await safeReply(message, formatDefaultWorkspaceUpdateReport(key, session, result));
          return;
        }
        if (action.type === 'browse') {
          if (typeof openWorkspaceBrowser !== 'function') {
            await safeReply(message, formatDefaultWorkspaceSetHelp(getSessionLanguage(session)));
            return;
          }
          await safeReply(message, openWorkspaceBrowser({
            key,
            session,
            userId: message.author?.id,
            mode: 'default',
          }));
          return;
        }
        const resolved = resolvePath(action.value);
        if (!isExistingDirectory(resolved)) {
          await safeReply(message, `❌ 目录不存在或不是目录：\`${resolved}\``);
          return;
        }
        const result = commandActions.setDefaultWorkspaceDir(session, resolved);
        closeRuntimeForKey(key);
        await safeReply(message, formatDefaultWorkspaceUpdateReport(key, session, result));
        break;
      }

      case 'resume': {
        const provider = getSessionProvider(session);
        const resumeAlias = getProviderCommandAlias(provider, 'resume');
        const sessionsAlias = getProviderCommandAlias(provider, 'sessions');
        if (!arg) {
          await safeReply(
            message,
            [
              '用法：`!resume <session-id>`',
              resumeAlias ? `当前 provider 别名：\`!${resumeAlias} <session-id>\`` : null,
              `用 \`!sessions\`${sessionsAlias ? ` / \`!${sessionsAlias}\`` : ''} 查看当前 provider 可用的 ${formatProviderSessionLabel(provider, 'zh', { plural: true })}。`,
            ].filter(Boolean).join('\n'),
          );
          return;
        }
        const binding = commandActions.bindSession(session, key, arg);
        if (!binding.sessionId && binding.missingWorkspaceDir) {
          await safeReply(
            message,
            `❌ 这个 ${formatProviderSessionLabel(binding.provider, 'zh')} 对应的 workspace 不存在：\`${binding.missingWorkspaceDir}\``,
          );
          return;
        }
        const notes = [];
        if (binding.adoptedWorkspaceDir) {
          notes.push(`已切到 session 对应 workspace：\`${binding.adoptedWorkspaceDir}\``);
        }
        if (binding.displacedKeys?.length) {
          notes.push('已清掉其他线程里重复绑定的同一 session。');
        }
        await safeReply(
          message,
          [
            `✅ 已绑定 ${formatProviderSessionLabel(binding.provider, 'zh')}: \`${binding.sessionId}\``,
            '下条消息会 resume 这个上下文。',
            ...notes,
          ].join('\n'),
        );
        closeRuntimeForKey(key, 'resume session');
        break;
      }

      case 'sessions': {
        try {
          const report = commandActions.formatRecentSessionsReport({
            key,
            session,
            resumeRef: '!resume <id>',
          });
          await safeReply(message, report);
        } catch (err) {
          await safeReply(message, `❌ 读取 sessions 失败：${safeError(err)}`);
        }
        break;
      }

      case 'fork': {
        const language = getSessionLanguage(session);
        const provider = getSessionProvider(session);
        if (!providerSupportsNativeFork(provider)) {
          await safeReply(
            message,
            language === 'en'
              ? `❌ Native fork is not available for ${getProviderDisplayName(provider)}.`
              : `❌ ${getProviderDisplayName(provider)} 不支持原生 fork。`,
          );
          return;
        }
        const parsed = parseForkTextInput(arg);
        const parentSessionId = normalizeForkSessionId(getSessionId(session));
        try {
          const result = await createProviderForkThread({
            key,
            session,
            source: message,
            parentSessionId,
            threadName: parsed.threadName,
            provider,
            getRuntimeSnapshot,
            getSession,
            commandActions,
            forkCodexThread,
            resolveForkWorkspace,
            enqueuePrompt,
            resolveSecurityContext,
          });
          await safeReply(message, formatProviderForkResult(result, language));
        } catch (err) {
          await safeReply(message, `❌ ${getProviderDisplayName(provider)} fork 失败：${safeError(err)}`);
        }
        break;
      }

      case 'goal': {
        const language = getSessionLanguage(session);
        const provider = getSessionProvider(session);
        const action = parseCodexGoalTextInput(buildGoalTextInput(arg, message.attachments));
        try {
          const result = await executeCodexGoalAction({
            action,
            session,
            provider,
            getSessionId,
            getCodexThreadGoal,
            setCodexThreadGoal,
            clearCodexThreadGoal,
          });
          const withContinuation = await maybeEnqueueCodexGoalContinuation({
            action,
            result,
            message,
            key,
            session,
          });
          await safeReply(message, formatCodexGoalResult(withContinuation, language));
        } catch (err) {
          await safeReply(message, `❌ Codex goal 失败：${safeError(err)}`);
        }
        break;
      }

      case 'model': {
        if (!arg) {
          await safeReply(message, formatModelCommandHelp(getSessionProvider(session)));
          return;
        }
        const { model } = commandActions.setModel(session, arg);
        closeRuntimeForKey(key);
        await safeReply(message, `✅ model = ${model || '(provider default)'}`);
        break;
      }

      case 'fast': {
        const provider = getSessionProvider(session);
        const language = getSessionLanguage(session);
        if (provider !== 'codex') {
          await safeReply(message, formatFastModeConfigReport(language, provider, { enabled: false, supported: false, source: 'provider unsupported' }, false));
          break;
        }
        const action = parseFastModeAction(arg || 'status');
        if (!action || action.type === 'invalid') {
          await safeReply(message, formatFastModeConfigHelp(language, provider));
          break;
        }
        if (action.type === 'status') {
          await safeReply(message, formatFastModeConfigReport(language, provider, resolveFastModeSetting(session), false));
          break;
        }
        const { fastModeSetting } = commandActions.setFastMode(session, action.enabled);
        await safeReply(message, formatFastModeConfigReport(language, provider, fastModeSetting, true));
        break;
      }

      case 'runtime': {
        const provider = getSessionProvider(session);
        const language = getSessionLanguage(session);
        if (provider !== 'claude') {
          await safeReply(message, formatRuntimeModeConfigReport(language, provider, { mode: 'normal', supported: false, source: 'provider unsupported' }, false));
          break;
        }
        const action = parseRuntimeModeAction(arg || 'status');
        if (!action || action.type === 'invalid') {
          await safeReply(message, formatRuntimeModeConfigHelp(language, provider));
          break;
        }
        if (action.type === 'status') {
          await safeReply(message, formatRuntimeModeConfigReport(language, provider, resolveRuntimeModeSetting(session), false));
          break;
        }
        commandActions.setRuntimeMode(session, action.mode);
        closeRuntimeForKey(key);
        await safeReply(message, formatRuntimeModeConfigReport(language, provider, resolveRuntimeModeSetting(session), true));
        break;
      }

      case 'effort': {
        const language = getSessionLanguage(session);
        const provider = getSessionProvider(session);
        const parsed = parseReasoningEffortInput(arg, { allowDefault: true });
        if (!parsed) {
          await safeReply(message, formatReasoningEffortHelp(language, provider));
          return;
        }
        if (parsed !== 'default' && !isReasoningEffortSupported(provider, parsed)) {
          await safeReply(message, formatReasoningEffortUnsupported(provider, language));
          return;
        }
        const { effort } = commandActions.setReasoningEffort(session, parsed);
        closeRuntimeForKey(key);
        await safeReply(message, `✅ reasoning effort = ${effort || '(provider default)'}`);
        break;
      }

      case 'compact': {
        const provider = getSessionProvider(session);
        const language = getSessionLanguage(session);
        const parsed = parseCompactConfigFromText(arg || 'status');
        if (!parsed || parsed.type === 'invalid') {
          await safeReply(message, formatCompactStrategyConfigHelp(language, provider));
          break;
        }
        if (!providerSupportsCompactConfigAction(provider, parsed)) {
          await safeReply(message, formatCompactConfigUnsupported(provider, parsed, language));
          break;
        }
        if (parsed.type === 'status') {
          await safeReply(message, formatCompactConfigReport(language, session, false));
          break;
        }
        commandActions.applyCompactConfig(session, parsed);
        await safeReply(message, formatCompactConfigReport(language, session, true));
        break;
      }

      case 'extra_info': {
        const language = getSessionLanguage(session);
        const parsed = parseExtraInfoConfigFromText(arg || 'status');
        if (!parsed || parsed.type === 'invalid') {
          await safeReply(message, formatExtraInfoConfigHelp(language));
          break;
        }
        if (parsed.type === 'status') {
          await safeReply(message, formatExtraInfoConfigReport(language, session, key, message.channel, false));
          break;
        }
        if (parsed.type === 'set_enabled') {
          commandActions.setExtraInfoEnabled(session, parsed.enabled);
        } else if (parsed.type === 'set_text') {
          commandActions.setExtraInfoText(session, parsed.text);
        } else if (parsed.type === 'reset') {
          commandActions.resetExtraInfo(session);
        }
        await safeReply(message, formatExtraInfoConfigReport(language, session, key, message.channel, true));
        break;
      }

      case 'config': {
        const provider = getSessionProvider(session);
        const language = getSessionLanguage(session);
        if (!providerSupportsRawConfigOverrides(provider)) {
          await safeReply(
            message,
            language === 'en'
              ? [
                `⚠️ Current provider = \`${provider}\` (${getProviderDisplayName(provider)}). \`!config\` is only available when the CLI exposes a stable raw config passthrough.`,
                `• runtime surface: ${formatProviderRawConfigSurface(provider, language)}`,
              ].join('\n')
              : [
                `⚠️ 当前 provider = \`${provider}\` (${getProviderDisplayName(provider)})，\`!config\` 仅对暴露稳定 raw config passthrough 的 CLI 开放。`,
                `• runtime 能力面：${formatProviderRawConfigSurface(provider, language)}`,
              ].join('\n'),
          );
          return;
        }
        if (!enableConfigCmd) {
          await safeReply(message, '⛔ `!config` 当前已禁用。可在 `.env` 设置 `ENABLE_CONFIG_CMD=true` 后重启。');
          return;
        }
        if (!arg) {
          await safeReply(message, [
            '用法：`!config <key=value>`',
            '例：`!config personality="concise"`',
            `允许的 key：${describeConfigPolicy()}`,
          ].join('\n'));
          return;
        }
        const keyName = parseConfigKey(arg);
        if (!keyName) {
          await safeReply(message, '❌ 参数格式错误：必须是 `key=value`。');
          return;
        }
        if (!isConfigKeyAllowed(keyName)) {
          await safeReply(message, `⛔ 不允许的配置 key：\`${keyName}\`\n允许的 key：${describeConfigPolicy()}`);
          return;
        }
        session.configOverrides = session.configOverrides || [];
        session.configOverrides.push(arg);
        saveDb();
        await safeReply(message, `✅ 已添加配置：\`${arg}\`\n当前额外配置：${session.configOverrides.map((config) => `\`${config}\``).join(', ')}`);
        break;
      }

      case 'mode': {
        if (!arg || !['safe', 'dangerous'].includes(arg.toLowerCase())) {
          await safeReply(message, '用法：`!mode <safe|dangerous>`');
          return;
        }
        const { mode } = commandActions.setMode(session, arg.toLowerCase());
        closeRuntimeForKey(key);
        await safeReply(message, `✅ mode = ${mode}`);
        break;
      }

      case 'reset': {
        commandActions.resetSession(session);
        closeRuntimeForKey(key, 'reset session');
        await safeReply(message, '♻️ 已清空会话 + 额外配置。下条消息新开上下文。');
        break;
      }

      default:
        await safeReply(message, '未知命令。发 `!help` 看命令列表。');
    }
  };
}
