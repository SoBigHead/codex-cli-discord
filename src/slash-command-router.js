import fs from 'node:fs';
import {
  getActionButtonCommandNames,
  normalizeCommandName,
} from './command-spec.js';
import {
  createProviderForkThread,
  formatProviderForkResult,
  normalizeForkSessionId,
  providerSupportsNativeFork,
} from './codex-fork-flow.js';
import {
  CODEX_GOAL_CONTINUATION_PROMPT,
  executeCodexGoalAction,
  formatCodexGoalResult,
  parseCodexGoalSlashInput,
  shouldStartCodexGoalContinuation,
} from './codex-goal-flow.js';

const ACTION_BUTTON_PREFIX = 'cmd';
const ACTION_BUTTON_COMMANDS = new Set(getActionButtonCommandNames());

function isExistingDirectory(dir) {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function registerSlashHandlers(map, names, handler) {
  for (const name of names) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) continue;
    map.set(key, handler);
  }
}

function createInteractionPromptMessage(interaction) {
  return {
    id: interaction.id,
    channel: interaction.channel,
    channelId: interaction.channelId || interaction.channel?.id,
    author: interaction.user,
    client: interaction.client || interaction.channel?.client,
    reactions: { cache: new Map() },
    react: async () => {},
    reply: async (payload) => {
      if (typeof interaction.followUp === 'function') {
        return interaction.followUp(payload);
      }
      if (typeof interaction.channel?.send === 'function') {
        return interaction.channel.send(payload);
      }
      throw new Error('Cannot send goal continuation reply');
    },
  };
}

export function buildCommandActionButtonId(command, userId) {
  const normalizedCommand = String(command || '').trim().toLowerCase();
  const normalizedUserId = String(userId || '').trim();
  return `${ACTION_BUTTON_PREFIX}:${normalizedCommand}:${normalizedUserId}`;
}

export function parseCommandActionButtonId(customId) {
  const match = /^cmd:([a-z_]+):([0-9]{5,32})$/i.exec(String(customId || '').trim());
  if (!match) return null;

  const command = normalizeCommandName(match[1]);
  const userId = String(match[2] || '').trim();
  if (!ACTION_BUTTON_COMMANDS.has(command)) return null;
  return { command, userId };
}

export function isCommandActionButtonId(customId) {
  return Boolean(parseCommandActionButtonId(customId));
}

export function createSlashCommandRouter({
  botProvider = null,
  defaultUiLanguage = 'zh',
  slashRef = (name) => `/${name}`,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  getSession,
  getSessionLanguage,
  getSessionProvider,
  getSessionId = (session) => session?.runnerSessionId || session?.codexThreadId || null,
  getProviderDisplayName,
  getEffectiveSecurityProfile,
  getRuntimeSnapshot = () => ({ running: false, queued: 0 }),
  resolveFastModeSetting = () => ({ enabled: false, supported: false, source: 'provider unsupported' }),
  resolveRuntimeModeSetting = () => ({ mode: 'normal', supported: false, source: 'provider unsupported' }),
  resolveTimeoutSetting,
  isReasoningEffortSupported,
  commandActions = {},
  isOnboardingEnabled,
  buildOnboardingActionRows,
  formatOnboardingStepReport,
  formatOnboardingDisabledMessage,
  formatOnboardingConfigReport,
  formatStatusReport,
  formatQueueReport,
  formatDoctorReport,
  formatWorkspaceReport,
  formatWorkspaceSetHelp,
  formatWorkspaceUpdateReport,
  formatDefaultWorkspaceSetHelp,
  formatDefaultWorkspaceUpdateReport,
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
  formatProviderSessionLabel = (provider) => `${provider} session`,
  formatReasoningEffortUnsupported,
  normalizeProvider,
  parseWorkspaceCommandAction,
  parseUiLanguageInput,
  parseFastModeAction = () => ({ type: 'status' }),
  parseRuntimeModeAction = () => ({ type: 'status' }),
  parseSecurityProfileInput,
  parseTimeoutConfigAction,
  parseCompactConfigAction,
  parseExtraInfoConfigAction = () => ({ type: 'status' }),
  providerSupportsCompactConfigAction = () => true,
  cancelChannelWork,
  closeRuntimeSession = () => false,
  retryLastPrompt,
  forkCodexThread,
  getCodexThreadGoal,
  setCodexThreadGoal,
  clearCodexThreadGoal,
  enqueuePrompt,
  resolveSecurityContext,
  openWorkspaceBrowser,
  openSettingsPanel,
  openModelSettingsPanel,
  resolvePath,
  safeError,
} = {}) {
  const handlers = new Map();

  async function maybeEnqueueCodexGoalContinuation({ action, result, interaction, key, session }) {
    if (!shouldStartCodexGoalContinuation(action, result)) return result;
    if (typeof enqueuePrompt !== 'function') {
      return { ...result, continuation: { state: 'failed', reason: 'enqueue unavailable' } };
    }
    try {
      const security = typeof resolveSecurityContext === 'function'
        ? resolveSecurityContext(interaction.channel, session)
        : null;
      const queued = await enqueuePrompt(
        createInteractionPromptMessage(interaction),
        key,
        CODEX_GOAL_CONTINUATION_PROMPT,
        security,
      );
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

  registerSlashHandlers(handlers, ['status'], async ({ interaction, key, session, respond }) => {
    await respond({
      content: await formatStatusReport(key, session, interaction.channel),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['settings'], async ({ interaction, key, session, respond }) => {
    if (typeof openSettingsPanel !== 'function') {
      await respond({
        content: '❌ 当前环境未启用 settings 面板。',
        flags: 64,
      });
      return;
    }

    await respond(openSettingsPanel({
      key,
      session,
      userId: interaction.user.id,
      activeSection: getSessionProvider(session) === 'codex' ? 'defaults' : 'overview',
      flags: 64,
    }));
  });

  registerSlashHandlers(handlers, ['new'], async ({ interaction, key, session, respond }) => {
    const outcome = cancelChannelWork(key, 'slash_new');
    commandActions.startNewSession(session);
    closeRuntimeForKey(key, 'new session');
    const lines = ['🆕 已切换到新会话。'];
    if (outcome.cancelledRunning) lines.push('当前运行中的任务已尝试取消。');
    if (outcome.clearedQueued > 0) lines.push(`已清空 ${outcome.clearedQueued} 个排队任务。`);
    lines.push('下一条普通消息会开启新的上下文。');
    await respond({
      content: lines.join('\n'),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['reset'], async ({ interaction, key, session, respond }) => {
    commandActions.resetSession(session);
    closeRuntimeForKey(key, 'reset session');
    await respond({
      content: '♻️ 会话与额外配置已清空，下条消息新开上下文。',
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['sessions'], async ({ interaction, key, session, respond }) => {
    try {
      await respond({
        content: commandActions.formatRecentSessionsReport({
          key,
          session,
          resumeRef: slashRef('resume'),
        }),
        flags: 64,
      });
    } catch (err) {
      await respond({
        content: `❌ ${safeError(err)}`,
        flags: 64,
      });
    }
  });

  registerSlashHandlers(handlers, ['setdir'], async ({ interaction, key, session, respond }) => {
    const action = parseWorkspaceCommandAction(interaction.options.getString('path'));
    if (!action || action.type === 'invalid') {
      await respond({ content: formatWorkspaceSetHelp(getSessionLanguage(session)), flags: 64 });
      return;
    }
    if (action.type === 'status') {
      await respond({ content: formatWorkspaceReport(key, session), flags: 64 });
      return;
    }
    if (action.type === 'clear') {
      const result = commandActions.clearWorkspaceDir(session, key);
      closeRuntimeForKey(key);
      await respond({ content: formatWorkspaceUpdateReport(key, session, result), flags: 64 });
      return;
    }
    if (action.type === 'browse') {
      if (typeof openWorkspaceBrowser !== 'function') {
        await respond({ content: formatWorkspaceSetHelp(getSessionLanguage(session)), flags: 64 });
        return;
      }
      await respond(openWorkspaceBrowser({
        key,
        session,
        userId: interaction.user.id,
        mode: 'thread',
        flags: 64,
      }));
      return;
    }

    const resolved = resolvePath(action.value);
    if (!isExistingDirectory(resolved)) {
      await respond({ content: `❌ 目录不存在或不是目录：\`${resolved}\``, flags: 64 });
      return;
    }

    const result = commandActions.setWorkspaceDir(session, key, resolved);
    closeRuntimeForKey(key);
    await respond({ content: formatWorkspaceUpdateReport(key, session, result), flags: 64 });
  });

  registerSlashHandlers(handlers, ['setdefaultdir'], async ({ interaction, key, session, respond }) => {
    const action = parseWorkspaceCommandAction(interaction.options.getString('path'));
    if (!action || action.type === 'invalid') {
      await respond({ content: formatDefaultWorkspaceSetHelp(getSessionLanguage(session)), flags: 64 });
      return;
    }
    if (action.type === 'status') {
      await respond({ content: formatWorkspaceReport(key, session), flags: 64 });
      return;
    }
    if (action.type === 'clear') {
      const result = commandActions.setDefaultWorkspaceDir(session, null);
      closeRuntimeForKey(key);
      await respond({ content: formatDefaultWorkspaceUpdateReport(key, session, result), flags: 64 });
      return;
    }
    if (action.type === 'browse') {
      if (typeof openWorkspaceBrowser !== 'function') {
        await respond({ content: formatDefaultWorkspaceSetHelp(getSessionLanguage(session)), flags: 64 });
        return;
      }
      await respond(openWorkspaceBrowser({
        key,
        session,
        userId: interaction.user.id,
        mode: 'default',
        flags: 64,
      }));
      return;
    }

    const resolved = resolvePath(action.value);
    if (!isExistingDirectory(resolved)) {
      await respond({ content: `❌ 目录不存在或不是目录：\`${resolved}\``, flags: 64 });
      return;
    }

    const result = commandActions.setDefaultWorkspaceDir(session, resolved);
    closeRuntimeForKey(key);
    await respond({ content: formatDefaultWorkspaceUpdateReport(key, session, result), flags: 64 });
  });

  registerSlashHandlers(handlers, ['provider'], async ({ interaction, key, session, respond }) => {
    if (botProvider) {
      await respond({
        content: `🔒 当前 bot 已锁定 provider = \`${botProvider}\` (${getProviderDisplayName(botProvider)})，不能在频道内切换。`,
        flags: 64,
      });
      return;
    }

    const rawRequested = interaction.options.getString('name');
    if (rawRequested === 'status') {
      await respond({
        content: `ℹ️ 当前 provider = \`${getSessionProvider(session)}\` (${getProviderDisplayName(getSessionProvider(session))})`,
        flags: 64,
      });
      return;
    }

    const requested = normalizeProvider(rawRequested);
    const { previous } = commandActions.setProvider(session, requested);
    closeRuntimeForKey(key);
    await respond(`✅ provider = \`${requested}\` (${getProviderDisplayName(requested)})${previous === requested ? '' : '，已清空旧 session 绑定'}`);
  });

  registerSlashHandlers(handlers, ['model'], async ({ interaction, key, session, respond }) => {
    const name = interaction.options.getString('name');
    const effort = interaction.options.getString('effort');
    const provider = getSessionProvider(session);
    const language = getSessionLanguage(session);

    if (!name && !effort) {
      if (typeof openModelSettingsPanel === 'function') {
        await respond(openModelSettingsPanel({
          key,
          session,
          userId: interaction.user.id,
          flags: 64,
        }));
        return;
      }
      await respond({
        content: language === 'en' ? '❌ Model settings panel is unavailable.' : '❌ 当前环境没有可用的 model 设置面板。',
        flags: 64,
      });
      return;
    }

    const updates = [];
    if (name) {
      const { model } = commandActions.setModel(session, name);
      updates.push(`model = ${model || '(provider default)'}`);
    }
    if (effort) {
      if (effort !== 'default' && !isReasoningEffortSupported(provider, effort)) {
        await respond({
          content: formatReasoningEffortUnsupported(provider, language),
          flags: 64,
        });
        return;
      }
      const { effort: updatedEffort } = commandActions.setReasoningEffort(session, effort);
      updates.push(`effort = ${updatedEffort || '(provider default)'}`);
    }
    closeRuntimeForKey(key);
    await respond(`✅ ${updates.join('，')}`);
  });

  registerSlashHandlers(handlers, ['fast'], async ({ interaction, session, respond }) => {
    const provider = getSessionProvider(session);
    const language = getSessionLanguage(session);
    const action = parseFastModeAction(interaction.options.getString('action'));
    if (provider !== 'codex') {
      await respond({
        content: formatFastModeConfigReport(language, provider, { enabled: false, supported: false, source: 'provider unsupported' }, false),
        flags: 64,
      });
      return;
    }
    if (!action || action.type === 'invalid') {
      await respond({
        content: formatFastModeConfigHelp(language, provider),
        flags: 64,
      });
      return;
    }
    if (action.type === 'status') {
      await respond({
        content: formatFastModeConfigReport(language, provider, resolveFastModeSetting(session), false),
        flags: 64,
      });
      return;
    }
    const { fastModeSetting } = commandActions.setFastMode(session, action.enabled);
    await respond({
      content: formatFastModeConfigReport(language, provider, fastModeSetting, true),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['runtime'], async ({ interaction, key, session, respond }) => {
    const provider = getSessionProvider(session);
    const language = getSessionLanguage(session);
    const action = parseRuntimeModeAction(interaction.options.getString('mode'));
    if (provider !== 'claude') {
      await respond({
        content: formatRuntimeModeConfigReport(language, provider, { mode: 'normal', supported: false, source: 'provider unsupported' }, false),
        flags: 64,
      });
      return;
    }
    if (!action || action.type === 'invalid') {
      await respond({
        content: formatRuntimeModeConfigHelp(language, provider),
        flags: 64,
      });
      return;
    }
    if (action.type === 'status') {
      await respond({
        content: formatRuntimeModeConfigReport(language, provider, resolveRuntimeModeSetting(session), false),
        flags: 64,
      });
      return;
    }
    commandActions.setRuntimeMode(session, action.mode);
    closeRuntimeForKey(key);
    await respond({
      content: formatRuntimeModeConfigReport(language, provider, resolveRuntimeModeSetting(session), true),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['effort'], async ({ interaction, key, session, respond }) => {
    const level = interaction.options.getString('level');
    const provider = getSessionProvider(session);
    if (level !== 'default' && !isReasoningEffortSupported(provider, level)) {
      await respond({
        content: formatReasoningEffortUnsupported(provider, getSessionLanguage(session)),
        flags: 64,
      });
      return;
    }

    const { effort } = commandActions.setReasoningEffort(session, level);
    closeRuntimeForKey(key);
    await respond(`✅ effort = ${effort || '(provider default)'}`);
  });

  registerSlashHandlers(handlers, ['compact'], async ({ interaction, key, session, respond }) => {
    const provider = getSessionProvider(session);
    const language = getSessionLanguage(session);
    const parsed = parseCompactConfigAction(
      interaction.options.getString('key'),
      interaction.options.getString('value') || '',
    );
    if (!parsed || parsed.type === 'invalid') {
      await respond({
        content: formatCompactStrategyConfigHelp(language, provider),
        flags: 64,
      });
      return;
    }
    if (!providerSupportsCompactConfigAction(provider, parsed)) {
      await respond({
        content: formatCompactConfigUnsupported(provider, parsed, language),
        flags: 64,
      });
      return;
    }
    if (parsed.type === 'status') {
      await respond({
        content: formatCompactConfigReport(language, session, false),
        flags: 64,
      });
      return;
    }
    commandActions.applyCompactConfig(session, parsed);
    await respond({
      content: formatCompactConfigReport(language, session, true),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['extra_info', 'extrainfo'], async ({ interaction, key, session, respond }) => {
    const language = getSessionLanguage(session);
    const parsed = parseExtraInfoConfigAction(
      interaction.options.getString('key'),
      interaction.options.getString('value') || '',
    );
    if (!parsed || parsed.type === 'invalid') {
      await respond({
        content: formatExtraInfoConfigHelp(language),
        flags: 64,
      });
      return;
    }
    if (parsed.type === 'status') {
      await respond({
        content: formatExtraInfoConfigReport(language, session, key, interaction.channel, false),
        flags: 64,
      });
      return;
    }
    if (parsed.type === 'set_enabled') {
      commandActions.setExtraInfoEnabled(session, parsed.enabled);
    } else if (parsed.type === 'set_text') {
      commandActions.setExtraInfoText(session, parsed.text);
    } else if (parsed.type === 'reset') {
      commandActions.resetExtraInfo(session);
    }
    await respond({
      content: formatExtraInfoConfigReport(language, session, key, interaction.channel, true),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['mode'], async ({ interaction, key, session, respond }) => {
    const type = interaction.options.getString('type');
    const { mode } = commandActions.setMode(session, type);
    closeRuntimeForKey(key);
    await respond(`✅ mode = ${mode}`);
  });

  registerSlashHandlers(handlers, ['resume'], async ({ interaction, key, session, respond }) => {
    const sid = interaction.options.getString('session_id');
    const binding = commandActions.bindSession(session, interaction.channelId, sid);
    if (!binding.sessionId && binding.missingWorkspaceDir) {
      await respond(`❌ 这个 ${formatProviderSessionLabel(binding.provider, 'zh')} 对应的 workspace 不存在：\`${binding.missingWorkspaceDir}\``);
      return;
    }
    const notes = [];
    if (binding.adoptedWorkspaceDir) {
      notes.push(`已切到 session 对应 workspace：\`${binding.adoptedWorkspaceDir}\``);
    }
    if (binding.displacedKeys?.length) {
      notes.push('已清掉其他线程里重复绑定的同一 session。');
    }
    await respond([
      `✅ 已绑定 ${formatProviderSessionLabel(binding.provider, 'zh')}: \`${binding.sessionId}\``,
        ...notes,
      ].join('\n'));
    closeRuntimeForKey(key, 'resume session');
  });

  registerSlashHandlers(handlers, ['fork'], async ({ interaction, key, session, respond }) => {
    const language = getSessionLanguage(session);
    const provider = getSessionProvider(session);
    if (!providerSupportsNativeFork(provider)) {
      await respond({
        content: language === 'en'
          ? `❌ Native fork is not available for ${getProviderDisplayName(provider)}.`
          : `❌ ${getProviderDisplayName(provider)} 不支持原生 fork。`,
        flags: 64,
      });
      return;
    }

    const parentSessionId = normalizeForkSessionId(getSessionId(session));
    const threadName = interaction.options.getString('name') || '';
    try {
      const result = await createProviderForkThread({
        key,
        session,
        source: interaction,
        parentSessionId,
        threadName,
        provider,
        getRuntimeSnapshot,
        getSession,
        commandActions,
        forkCodexThread,
        enqueuePrompt,
        resolveSecurityContext,
      });
      await respond({
        content: formatProviderForkResult(result, language),
        flags: 64,
      });
    } catch (err) {
      await respond({
        content: `❌ ${getProviderDisplayName(provider)} fork 失败：${safeError(err)}`,
        flags: 64,
      });
    }
  });

  registerSlashHandlers(handlers, ['goal'], async ({ interaction, key, session, respond }) => {
    const language = getSessionLanguage(session);
    const provider = getSessionProvider(session);
    const action = parseCodexGoalSlashInput({
      action: interaction.options.getString('action') || 'status',
      objective: interaction.options.getString('objective') || '',
      tokenBudget: interaction.options.getString('token_budget') || '',
    });
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
        interaction,
        key,
        session,
      });
      await respond({
        content: formatCodexGoalResult(withContinuation, language),
        flags: 64,
      });
    } catch (err) {
      await respond({
        content: `❌ Codex goal 失败：${safeError(err)}`,
        flags: 64,
      });
    }
  });

  registerSlashHandlers(handlers, ['name'], async ({ interaction, session, respond }) => {
    const label = interaction.options.getString('label').trim();
    const renamed = commandActions.renameSession(session, label);
    await respond(`✅ session 命名为: **${renamed.label}**`);
  });

  registerSlashHandlers(handlers, ['queue'], async ({ interaction, key, session, respond }) => {
    await respond({
      content: formatQueueReport(key, session, interaction.channel),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['doctor'], async ({ interaction, key, session, respond }) => {
    await respond({
      content: formatDoctorReport(key, session, interaction.channel),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['onboarding'], async ({ interaction, key, session, respond }) => {
    const language = getSessionLanguage(session);
    if (!isOnboardingEnabled(session)) {
      await respond({
        content: formatOnboardingDisabledMessage(language),
        flags: 64,
      });
      return;
    }

    const step = 1;
    await respond({
      content: formatOnboardingStepReport(step, key, session, interaction.channel, language),
      components: buildOnboardingActionRows(step, key, interaction.user.id, session, language),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['onboarding_config'], async ({ interaction, session, respond }) => {
    const action = String(interaction.options.getString('action') || '').trim().toLowerCase();
    const language = getSessionLanguage(session);
    if (action === 'on' || action === 'off') {
      const { enabled } = commandActions.setOnboardingEnabled(session, action === 'on');
      await respond({
        content: formatOnboardingConfigReport(language, enabled, true),
        flags: 64,
      });
      return;
    }

    await respond({
      content: formatOnboardingConfigReport(language, isOnboardingEnabled(session), false),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['language'], async ({ interaction, session, respond }) => {
    const requested = interaction.options.getString('name');
    const { language } = commandActions.setLanguage(session, parseUiLanguageInput(requested) || defaultUiLanguage);
    await respond({
      content: formatLanguageConfigReport(language, true),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['profile'], async ({ interaction, session, respond }) => {
    const requested = interaction.options.getString('name');
    if (String(requested || '').toLowerCase() === 'status') {
      await respond({
        content: formatProfileConfigReport(getSessionLanguage(session), getEffectiveSecurityProfile(session).profile, false),
        flags: 64,
      });
      return;
    }

    const profile = parseSecurityProfileInput(requested);
    if (!profile) {
      await respond({
        content: formatProfileConfigHelp(getSessionLanguage(session)),
        flags: 64,
      });
      return;
    }

    const updated = commandActions.setSecurityProfile(session, profile);
    await respond({
      content: formatProfileConfigReport(getSessionLanguage(session), updated.profile, true),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['timeout'], async ({ interaction, session, respond }) => {
    const language = getSessionLanguage(session);
    const parsedTimeout = parseTimeoutConfigAction(interaction.options.getString('value'));
    if (!parsedTimeout || parsedTimeout.type === 'invalid') {
      await respond({
        content: formatTimeoutConfigHelp(language),
        flags: 64,
      });
      return;
    }
    if (parsedTimeout.type === 'status') {
      await respond({
        content: formatTimeoutConfigReport(language, resolveTimeoutSetting(session), false),
        flags: 64,
      });
      return;
    }

    const { timeoutSetting } = commandActions.setTimeoutMs(session, parsedTimeout.timeoutMs);
    await respond({
      content: formatTimeoutConfigReport(language, timeoutSetting, true),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['progress'], async ({ interaction, key, session, respond }) => {
    await respond({
      content: formatProgressReport(key, session, interaction.channel),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['cancel', 'abort'], async ({ interaction, key, commandName, session, respond }) => {
    const outcome = cancelChannelWork(key, `slash_${commandName}`);
    await respond({
      content: formatCancelReport(outcome),
      flags: 64,
    });
  });

  registerSlashHandlers(handlers, ['retry'], async ({ interaction, key, session, respond }) => {
    if (typeof retryLastPrompt !== 'function') {
      await respond({
        content: '❌ 当前环境未启用失败任务重试。',
        flags: 64,
      });
      return;
    }

    const outcome = await retryLastPrompt(key, interaction.user.id);
    if (!outcome?.enqueued) {
      const content = outcome?.reason === 'queue_full' && Number.isFinite(outcome?.maxQueue)
        ? `🚧 当前频道队列已满（上限 ${outcome.maxQueue}），请稍后再试。`
        : '❌ 没有可重试的失败任务。';
      await respond({
        content,
        flags: 64,
      });
      return;
    }

    const content = outcome.queuedAhead > 0
      ? `🔁 已重新加入队列，前面还有 ${outcome.queuedAhead} 条。`
      : '🔁 已重新加入队列。';
    await respond({
      content,
      flags: 64,
    });
  });

  return async function routeSlashCommand({ interaction, commandName, respond } = {}) {
    const key = interaction?.channelId;
    if (!key) {
      await respond({ content: '❌ 无法识别当前频道。', flags: 64 });
      return true;
    }

    const normalizedCommand = normalizeCommandName(commandName);
    const handler = handlers.get(normalizedCommand);
    if (!handler) return false;

    const session = getSession(key, { channel: interaction.channel || null });
    await handler({
      interaction,
      commandName: normalizedCommand,
      key,
      session,
      respond,
    });
    return true;
  };
}
