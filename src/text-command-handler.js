import fs from 'node:fs';

export function createTextCommandHandler({
  botProvider = null,
  enableConfigCmd = false,
  getSession,
  saveDb,
  ensureWorkspace,
  clearSessionId,
  getSessionId,
  setSessionId,
  getSessionProvider,
  getSessionLanguage,
  getProviderDisplayName,
  getProviderShortName,
  commandActions = {},
  isOnboardingEnabled,
  safeReply,
  formatHelpReport,
  formatStatusReport,
  formatQueueReport,
  formatDoctorReport,
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
  formatProcessLinesConfigHelp,
  formatProcessLinesConfigReport,
  formatProgressReport,
  formatCancelReport,
  formatCompactStrategyConfigHelp,
  formatCompactConfigReport,
  formatReasoningEffortHelp,
  formatReasoningEffortUnsupported,
  parseProviderInput,
  parseOnboardingConfigAction,
  parseUiLanguageInput,
  parseSecurityProfileInput,
  parseTimeoutConfigAction,
  parseProcessLinesConfigAction,
  parseCompactConfigFromText,
  parseConfigKey,
  parseReasoningEffortInput,
  getEffectiveSecurityProfile,
  resolveTimeoutSetting,
  resolveProcessLinesSetting,
  describeConfigPolicy,
  isConfigKeyAllowed,
  isReasoningEffortSupported,
  cancelChannelWork,
  resolvePath,
  ensureGitRepo,
  listRecentSessions,
  humanAge,
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

      case '!processlines':
      case '!progresslines':
      case '!plines': {
        const language = getSessionLanguage(session);
        const parsed = parseProcessLinesConfigAction(arg || 'status');
        if (!parsed || parsed.type === 'invalid') {
          await safeReply(message, formatProcessLinesConfigHelp(language));
          break;
        }
        if (parsed.type === 'status') {
          await safeReply(message, formatProcessLinesConfigReport(language, resolveProcessLinesSetting(session), false));
          break;
        }
        const { processLinesSetting } = commandActions.setProcessLines(session, parsed.lines);
        await safeReply(message, formatProcessLinesConfigReport(language, processLinesSetting, true));
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

      case '!cd':
      case '!setdir': {
        if (!arg) {
          await safeReply(message, '用法：`!setdir <path>`\n例：`!setdir ~/GitHub/my-project`');
          return;
        }
        const resolved = resolvePath(arg);
        if (!fs.existsSync(resolved)) {
          await safeReply(message, `❌ 目录不存在：\`${resolved}\`\n要新建的话先 mkdir。`);
          return;
        }
        commandActions.setWorkspaceDir(session, resolved);
        await safeReply(message, `✅ workspace → \`${resolved}\`\n会话已重置（新目录 = 新上下文）。`);
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
