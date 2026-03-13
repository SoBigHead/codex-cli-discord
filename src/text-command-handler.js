import fs from 'node:fs';

function isExistingDirectory(dir) {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function createTextCommandHandler({
  botProvider = null,
  enableConfigCmd = false,
  getSession,
  saveDb,
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
  formatProfileConfigHelp,
  formatProfileConfigReport,
  formatTimeoutConfigHelp,
  formatTimeoutConfigReport,
  formatProgressReport,
  formatCancelReport,
  formatCompactStrategyConfigHelp,
  formatCompactConfigReport,
  formatReasoningEffortHelp,
  formatReasoningEffortUnsupported,
  parseProviderInput,
  parseWorkspaceCommandAction,
  parseOnboardingConfigAction,
  parseUiLanguageInput,
  parseSecurityProfileInput,
  parseTimeoutConfigAction,
  parseCompactConfigFromText,
  parseConfigKey,
  parseReasoningEffortInput,
  getEffectiveSecurityProfile,
  resolveTimeoutSetting,
  describeConfigPolicy,
  isConfigKeyAllowed,
  isReasoningEffortSupported,
  cancelChannelWork,
  openWorkspaceBrowser,
  resolvePath,
  safeError,
} = {}) {
  return async function handleCommand(message, key, content) {
    const [cmd, ...rest] = content.split(/\s+/);
    const arg = rest.join(' ').trim();
    const session = getSession(key);

    switch (cmd.toLowerCase()) {
      case '!help': {
        await safeReply(message, formatHelpReport(session));
        break;
      }

      case '!status': {
        await safeReply(message, formatStatusReport(key, session, message.channel));
        break;
      }

      case '!queue': {
        await safeReply(message, formatQueueReport(key, session, message.channel));
        break;
      }

      case '!doctor': {
        await safeReply(message, formatDoctorReport(key, session, message.channel));
        break;
      }

      case '!provider': {
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
          await safeReply(message, '用法：`!provider <codex|claude|status>`');
          break;
        }
        const { previous } = commandActions.setProvider(session, requested);
        await safeReply(message, `✅ provider = \`${requested}\` (${getProviderDisplayName(requested)})${previous === requested ? '' : '，已清空旧 session 绑定'}`);
        break;
      }

      case '!onboarding':
      case '!onboard':
      case '!guide': {
        const language = getSessionLanguage(session);
        const onboardingOp = parseOnboardingConfigAction(arg);
        if (cmd.toLowerCase() === '!onboarding' && onboardingOp) {
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

      case '!lang':
      case '!language': {
        const requested = parseUiLanguageInput(arg);
        if (!requested) {
          await safeReply(message, formatLanguageConfigHelp(getSessionLanguage(session)));
          break;
        }
        const { language } = commandActions.setLanguage(session, requested);
        await safeReply(message, formatLanguageConfigReport(language, true));
        break;
      }

      case '!profile': {
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

      case '!timeout': {
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

      case '!progress': {
        await safeReply(message, formatProgressReport(key, session, message.channel));
        break;
      }

      case '!abort':
      case '!cancel':
      case '!stop': {
        const outcome = cancelChannelWork(key, `text_command:${cmd.toLowerCase()}`);
        await safeReply(message, formatCancelReport(outcome));
        break;
      }

      case '!new':
      case '!fresh':
      case '!next':
      case '!start': {
        const outcome = cancelChannelWork(key, `text_command:${cmd.toLowerCase()}`);
        commandActions.startNewSession(session);
        const lines = ['🆕 已切换到新会话。'];
        if (outcome.cancelledRunning) lines.push('当前运行中的任务已尝试取消。');
        if (outcome.clearedQueued > 0) lines.push(`已清空 ${outcome.clearedQueued} 个排队任务。`);
        lines.push('下一条普通消息会开启新的上下文。');
        await safeReply(message, lines.join('\n'));
        break;
      }

      case '!cd':
      case '!setdir': {
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
        await safeReply(message, formatWorkspaceUpdateReport(key, session, result));
        break;
      }

      case '!setdefaultdir':
      case '!defaultdir': {
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
        await safeReply(message, formatDefaultWorkspaceUpdateReport(key, session, result));
        break;
      }

      case '!resume': {
        if (!arg) {
          await safeReply(message, '用法：`!resume <session-id>`\n用 `!sessions` 查看当前 provider 可用的 session。');
          return;
        }
        const binding = commandActions.bindSession(session, arg);
        await safeReply(message, `✅ 已绑定 ${binding.providerLabel} session: \`${binding.sessionId}\`\n下条消息会 resume 这个上下文。`);
        break;
      }

      case '!sessions': {
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

      case '!model': {
        if (!arg) {
          await safeReply(message, '用法：`!model <name|default>`\n例：`!model o3` / `!model gpt-5.3-codex` / `!model default`');
          return;
        }
        const { model } = commandActions.setModel(session, arg);
        await safeReply(message, `✅ model = ${model || '(default from config.toml)'}`);
        break;
      }

      case '!effort': {
        const language = getSessionLanguage(session);
        const parsed = parseReasoningEffortInput(arg, { allowDefault: true });
        if (!parsed) {
          await safeReply(message, formatReasoningEffortHelp(language));
          return;
        }
        const provider = getSessionProvider(session);
        if (parsed !== 'default' && !isReasoningEffortSupported(provider, parsed)) {
          await safeReply(message, formatReasoningEffortUnsupported(provider, language));
          return;
        }
        const { effort } = commandActions.setReasoningEffort(session, parsed);
        await safeReply(message, `✅ reasoning effort = ${effort || '(default from config.toml)'}`);
        break;
      }

      case '!compact': {
        const language = getSessionLanguage(session);
        const parsed = parseCompactConfigFromText(arg || 'status');
        if (!parsed || parsed.type === 'invalid') {
          await safeReply(message, formatCompactStrategyConfigHelp(language));
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

      case '!config': {
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

      case '!mode': {
        if (!arg || !['safe', 'dangerous'].includes(arg.toLowerCase())) {
          await safeReply(message, '用法：`!mode <safe|dangerous>`');
          return;
        }
        const { mode } = commandActions.setMode(session, arg.toLowerCase());
        await safeReply(message, `✅ mode = ${mode}`);
        break;
      }

      case '!reset': {
        commandActions.resetSession(session);
        await safeReply(message, '♻️ 已清空会话 + 额外配置。下条消息新开上下文。');
        break;
      }

      default:
        await safeReply(message, '未知命令。发 `!help` 看命令列表。');
    }
  };
}
