import fs from 'node:fs';

const ACTION_BUTTON_PREFIX = 'cmd';
const ACTION_BUTTON_COMMANDS = new Set(['status', 'sessions', 'queue', 'progress', 'new', 'cancel']);

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

function normalizePayload(payload) {
  return typeof payload === 'string' ? { content: payload } : payload;
}

export function buildCommandActionButtonId(command, userId) {
  const normalizedCommand = String(command || '').trim().toLowerCase();
  const normalizedUserId = String(userId || '').trim();
  return `${ACTION_BUTTON_PREFIX}:${normalizedCommand}:${normalizedUserId}`;
}

export function parseCommandActionButtonId(customId) {
  const match = /^cmd:([a-z_]+):([0-9]{5,32})$/i.exec(String(customId || '').trim());
  if (!match) return null;

  const command = String(match[1] || '').trim().toLowerCase();
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
  getProviderDisplayName,
  getEffectiveSecurityProfile,
  getRuntimeSnapshot = () => ({ running: false, queued: 0 }),
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
  formatProfileConfigHelp,
  formatProfileConfigReport,
  formatTimeoutConfigHelp,
  formatTimeoutConfigReport,
  formatProgressReport,
  formatCancelReport,
  formatCompactStrategyConfigHelp,
  formatCompactConfigReport,
  formatReasoningEffortUnsupported,
  normalizeProvider,
  parseWorkspaceCommandAction,
  parseUiLanguageInput,
  parseSecurityProfileInput,
  parseTimeoutConfigAction,
  parseCompactConfigAction,
  cancelChannelWork,
  openWorkspaceBrowser,
  resolvePath,
  safeError,
} = {}) {
  const handlers = new Map();

  function buildActionButton(command, label, style, userId, { disabled = false } = {}) {
    return new ButtonBuilder()
      .setCustomId(buildCommandActionButtonId(command, userId))
      .setLabel(label)
      .setStyle(style)
      .setDisabled(disabled);
  }

  function buildCommandActionRows({ key, session, userId } = {}) {
    if (!ActionRowBuilder || !ButtonBuilder || !ButtonStyle || !userId) return [];

    const runtime = getRuntimeSnapshot(key);
    const canCancel = Boolean(runtime?.running || Number(runtime?.queued || 0) > 0);

    return [
      new ActionRowBuilder().addComponents(
        buildActionButton('status', 'Status', ButtonStyle.Secondary, userId),
        buildActionButton('sessions', 'Sessions', ButtonStyle.Secondary, userId),
        buildActionButton('queue', 'Queue', ButtonStyle.Secondary, userId),
        buildActionButton('progress', 'Progress', ButtonStyle.Secondary, userId),
      ),
      new ActionRowBuilder().addComponents(
        buildActionButton('new', 'New', ButtonStyle.Primary, userId),
        buildActionButton('cancel', 'Cancel', ButtonStyle.Danger, userId, { disabled: !canCancel }),
      ),
    ];
  }

  function withCommandActions(payload, { key, session, userId } = {}) {
    const body = normalizePayload(payload);
    if (!body) return body;

    const rows = buildCommandActionRows({ key, session, userId });
    if (!rows.length) return body;
    return {
      ...body,
      components: rows,
    };
  }

  registerSlashHandlers(handlers, ['status'], async ({ interaction, key, session, respond }) => {
    await respond(withCommandActions({
      content: formatStatusReport(key, session, interaction.channel),
      flags: 64,
    }, { key, session, userId: interaction.user.id }));
  });

  registerSlashHandlers(handlers, ['new'], async ({ interaction, key, session, respond }) => {
    const outcome = cancelChannelWork(key, 'slash_new');
    commandActions.startNewSession(session);
    const lines = ['🆕 已切换到新会话。'];
    if (outcome.cancelledRunning) lines.push('当前运行中的任务已尝试取消。');
    if (outcome.clearedQueued > 0) lines.push(`已清空 ${outcome.clearedQueued} 个排队任务。`);
    lines.push('下一条普通消息会开启新的上下文。');
    await respond(withCommandActions({
      content: lines.join('\n'),
      flags: 64,
    }, { key, session, userId: interaction.user.id }));
  });

  registerSlashHandlers(handlers, ['reset'], async ({ interaction, key, session, respond }) => {
    commandActions.resetSession(session);
    await respond(withCommandActions({
      content: '♻️ 会话与额外配置已清空，下条消息新开上下文。',
      flags: 64,
    }, { key, session, userId: interaction.user.id }));
  });

  registerSlashHandlers(handlers, ['sessions'], async ({ interaction, key, session, respond }) => {
    try {
      await respond(withCommandActions({
        content: commandActions.formatRecentSessionsReport({
          key,
          session,
          resumeRef: slashRef('resume'),
        }),
        flags: 64,
      }, { key, session, userId: interaction.user.id }));
    } catch (err) {
      await respond(withCommandActions({
        content: `❌ ${safeError(err)}`,
        flags: 64,
      }, { key, session, userId: interaction.user.id }));
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
    await respond({ content: formatDefaultWorkspaceUpdateReport(key, session, result), flags: 64 });
  });

  registerSlashHandlers(handlers, ['provider'], async ({ interaction, session, respond }) => {
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
    await respond(`✅ provider = \`${requested}\` (${getProviderDisplayName(requested)})${previous === requested ? '' : '，已清空旧 session 绑定'}`);
  });

  registerSlashHandlers(handlers, ['model'], async ({ interaction, session, respond }) => {
    const name = interaction.options.getString('name');
    const { model } = commandActions.setModel(session, name);
    await respond(`✅ model = ${model || '(default)'}`);
  });

  registerSlashHandlers(handlers, ['effort'], async ({ interaction, session, respond }) => {
    const level = interaction.options.getString('level');
    const provider = getSessionProvider(session);
    if (!isReasoningEffortSupported(provider, level)) {
      await respond({
        content: formatReasoningEffortUnsupported(provider, getSessionLanguage(session)),
        flags: 64,
      });
      return;
    }

    const { effort } = commandActions.setReasoningEffort(session, level);
    await respond(`✅ effort = ${effort || '(default)'}`);
  });

  registerSlashHandlers(handlers, ['compact'], async ({ interaction, session, respond }) => {
    const language = getSessionLanguage(session);
    const parsed = parseCompactConfigAction(
      interaction.options.getString('key'),
      interaction.options.getString('value') || '',
    );
    if (!parsed || parsed.type === 'invalid') {
      await respond({
        content: formatCompactStrategyConfigHelp(language),
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

  registerSlashHandlers(handlers, ['mode'], async ({ interaction, session, respond }) => {
    const type = interaction.options.getString('type');
    const { mode } = commandActions.setMode(session, type);
    await respond(`✅ mode = ${mode}`);
  });

  registerSlashHandlers(handlers, ['resume'], async ({ interaction, session, respond }) => {
    const sid = interaction.options.getString('session_id');
    const binding = commandActions.bindSession(session, sid);
    await respond(`✅ 已绑定 ${binding.providerLabel} session: \`${binding.sessionId}\``);
  });

  registerSlashHandlers(handlers, ['name'], async ({ interaction, session, respond }) => {
    const label = interaction.options.getString('label').trim();
    const renamed = commandActions.renameSession(session, label);
    await respond(`✅ session 命名为: **${renamed.label}**`);
  });

  registerSlashHandlers(handlers, ['queue'], async ({ interaction, key, session, respond }) => {
    await respond(withCommandActions({
      content: formatQueueReport(key, session, interaction.channel),
      flags: 64,
    }, { key, session, userId: interaction.user.id }));
  });

  registerSlashHandlers(handlers, ['doctor'], async ({ interaction, key, session, respond }) => {
    await respond(withCommandActions({
      content: formatDoctorReport(key, session, interaction.channel),
      flags: 64,
    }, { key, session, userId: interaction.user.id }));
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
      components: buildOnboardingActionRows(step, interaction.user.id, session, language),
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
    await respond(withCommandActions({
      content: formatProgressReport(key, session, interaction.channel),
      flags: 64,
    }, { key, session, userId: interaction.user.id }));
  });

  registerSlashHandlers(handlers, ['cancel', 'abort'], async ({ interaction, key, commandName, session, respond }) => {
    const outcome = cancelChannelWork(key, `slash_${commandName}`);
    await respond(withCommandActions({
      content: formatCancelReport(outcome),
      flags: 64,
    }, { key, session, userId: interaction.user.id }));
  });

  return async function routeSlashCommand({ interaction, commandName, respond } = {}) {
    const key = interaction?.channelId;
    if (!key) {
      await respond({ content: '❌ 无法识别当前频道。', flags: 64 });
      return true;
    }

    const normalizedCommand = String(commandName || '').trim().toLowerCase();
    const handler = handlers.get(normalizedCommand);
    if (!handler) return false;

    const session = getSession(key);
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
