const PROVIDER_CHOICES = Object.freeze(['codex', 'claude', 'antigravity']);

function formatWorkspaceSourceLabel(source, language) {
  const value = String(source || '').trim().toLowerCase();
  if (language === 'en') {
    if (value === 'thread override') return 'this channel override';
    if (value === 'provider default') return 'provider default';
    if (value === 'legacy fallback') return 'legacy fallback';
    if (value === 'unset') return 'unset';
    return value || 'unknown';
  }

  if (value === 'thread override') return '当前频道覆盖';
  if (value === 'provider default') return 'provider 默认';
  if (value === 'legacy fallback') return 'legacy 回退';
  if (value === 'unset') return '未设置';
  return value || '未知';
}

function formatWorkspacePath(dir, language) {
  const value = String(dir || '').trim();
  if (!value) {
    return language === 'en' ? '(unset)' : '（未设置）';
  }
  return `\`${value}\``;
}

export function createOnboardingFlow({
  onboardingEnabledByDefault = true,
  defaultUiLanguage = 'en',
  onboardingTotalSteps = 4,
  botProvider = null,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  getSession,
  saveDb,
  getSessionProvider,
  getSessionLanguage,
  getWorkspaceBinding = () => ({ workspaceDir: null, source: 'unset' }),
  getProviderDisplayName = (provider) => String(provider || ''),
  getCliHealth = () => ({ ok: false, bin: 'cli', version: 'unknown' }),
  resolveSecurityContext = () => ({ mentionOnly: false }),
  normalizeUiLanguage,
  slashRef,
  formatCliHealth,
  formatLanguageLabel,
  parseUiLanguageInput,
  commandActions = {},
  openWorkspaceBrowser,
} = {}) {
  function isOnboardingEnabled(session) {
    if (!session) return onboardingEnabledByDefault;
    return session.onboardingEnabled !== false;
  }

  function parseOnboardingConfigAction(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    if (['status', 'show', 'state', '查看', '状态'].includes(raw)) return { type: 'status' };
    if (['on', 'enable', 'enabled', 'true', '1', 'yes', '开启', '启用', '打开'].includes(raw)) {
      return { type: 'set', enabled: true };
    }
    if (['off', 'disable', 'disabled', 'false', '0', 'no', '关闭', '禁用'].includes(raw)) {
      return { type: 'set', enabled: false };
    }
    return { type: 'invalid' };
  }

  function formatOnboardingDisabledMessage(language) {
    if (language === 'en') {
      return [
        'ℹ️ Guided setup is currently disabled in this channel.',
        `Enable with \`${slashRef('onboarding_config')} on\` or \`!onboarding on\`.`,
      ].join('\n');
    }
    return [
      'ℹ️ 当前频道已关闭 guided setup。',
      `可通过 \`${slashRef('onboarding_config')} on\` 或 \`!onboarding on\` 重新开启。`,
    ].join('\n');
  }

  function formatOnboardingConfigReport(language, enabled, changed) {
    const state = enabled ? 'on' : 'off';
    if (language === 'en') {
      if (changed) {
        return `✅ Guided setup is now ${state}\nUse \`${slashRef('onboarding')}\` or \`!onboarding\` to open it.`;
      }
      return `ℹ️ Guided setup is currently ${state}`;
    }
    if (changed) {
      return `✅ guided setup 已设置为 ${state}\n可使用 \`${slashRef('onboarding')}\` 或 \`!onboarding\` 打开。`;
    }
    return `ℹ️ 当前 guided setup = ${state}`;
  }

  function formatOnboardingConfigHelp(language) {
    if (language === 'en') {
      return [
        'Usage: `!onboarding <on|off|status>`',
        `Current command also supports slash: \`${slashRef('onboarding_config')} <on|off|status>\``,
      ].join('\n');
    }
    return [
      '用法：`!onboarding <on|off|status>`',
      `也可使用 slash：\`${slashRef('onboarding_config')} <on|off|status>\``,
    ].join('\n');
  }

  function getOnboardingSnapshot(key, session = null, channel = null, language = defaultUiLanguage) {
    const lang = normalizeUiLanguage(language);
    const provider = getSessionProvider(session);
    const currentLanguage = getSessionLanguage(session);
    const binding = getWorkspaceBinding(session, key) || {};
    const cliHealth = getCliHealth(provider);
    const security = resolveSecurityContext(channel, session) || {};
    const firstPromptHint = security.mentionOnly
      ? (lang === 'en'
        ? 'Send `@Bot summarize this repo and propose the next task`'
        : '发送 `@Bot 帮我总结这个仓库，并给出下一步建议`')
      : (lang === 'en'
        ? 'Send `summarize this repo and propose the next task`'
        : '发送 `帮我总结这个仓库，并给出下一步建议`');

    return {
      language: lang,
      provider,
      currentLanguage,
      binding,
      cliHealth,
      providerLocked: Boolean(botProvider),
      hasWorkspaceBrowser: typeof openWorkspaceBrowser === 'function',
      firstPromptHint,
    };
  }

  function formatProviderSummary(provider, language) {
    const label = getProviderDisplayName(provider);
    if (language === 'en') {
      return `\`${provider}\` (${label})`;
    }
    return `\`${provider}\`（${label}）`;
  }

  function formatWorkspaceSummary(binding, language) {
    const pathLabel = formatWorkspacePath(binding?.workspaceDir, language);
    const sourceLabel = formatWorkspaceSourceLabel(binding?.source, language);
    if (language === 'en') {
      return `${pathLabel} (${sourceLabel})`;
    }
    return `${pathLabel}（${sourceLabel}）`;
  }

  function formatOnboardingReport(key, session = null, channel = null, language = defaultUiLanguage) {
    const lang = normalizeUiLanguage(language);
    const snapshot = getOnboardingSnapshot(key, session, channel, lang);
    if (lang === 'en') {
      return [
        '🧭 **Quick Start**',
        `• Interactive guide: \`${slashRef('onboarding')}\``,
        `• Language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
        `• Provider: ${formatProviderSummary(snapshot.provider, lang)}`,
        `• Workspace: ${formatWorkspaceSummary(snapshot.binding, lang)}`,
        '',
        '1. Choose your UI language.',
        snapshot.providerLocked
          ? `2. Provider is fixed by this bot: ${formatProviderSummary(snapshot.provider, lang)}`
          : '2. Choose the provider for this channel.',
        '3. Pick the workspace for this channel.',
        `4. Send the first task: ${snapshot.firstPromptHint}`,
        '',
        `Need a quick check? Use \`${slashRef('status')}\` or \`!status\`. If something looks wrong, run \`${slashRef('doctor')}\`.`,
      ].join('\n');
    }
    return [
      '🧭 **首跑引导**',
      `• 交互式引导：\`${slashRef('onboarding')}\``,
      `• 当前语言：${formatLanguageLabel(snapshot.currentLanguage)}`,
      `• 当前 provider：${formatProviderSummary(snapshot.provider, lang)}`,
      `• 当前 workspace：${formatWorkspaceSummary(snapshot.binding, lang)}`,
      '',
      '1. 先选消息语言。',
      snapshot.providerLocked
        ? `2. 当前 bot 已锁定 provider：${formatProviderSummary(snapshot.provider, lang)}`
        : '2. 选择这个频道要用的 provider。',
      '3. 选择这个频道要工作的目录。',
      `4. 发送第一条任务：${snapshot.firstPromptHint}`,
      '',
      `想快速确认当前设置，可用 \`${slashRef('status')}\` 或 \`!status\`。如果感觉环境有问题，再执行 \`${slashRef('doctor')}\`。`,
    ].join('\n');
  }

  function normalizeOnboardingStep(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(onboardingTotalSteps, Math.floor(n)));
  }

  function buildOnboardingButtonId(action, step, userId, value = '') {
    const safeAction = String(action || '').trim().toLowerCase();
    const safeStep = normalizeOnboardingStep(step);
    const safeUserId = String(userId || '').trim();
    const safeValue = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return safeValue
      ? `onb:${safeAction}:${safeStep}:${safeUserId}:${safeValue}`
      : `onb:${safeAction}:${safeStep}:${safeUserId}`;
  }

  function isOnboardingButtonId(customId) {
    return /^onb:/.test(String(customId || ''));
  }

  function parseOnboardingButtonId(customId) {
    const text = String(customId || '').trim();
    const parts = text.split(':');
    if (parts.length < 4 || parts[0] !== 'onb') return null;
    const [, action, rawStep, userId, ...rest] = parts;
    if (!['goto', 'refresh', 'done', 'set_lang', 'set_provider', 'workspace_default', 'workspace_browse'].includes(action)) {
      return null;
    }
    if (!/^[0-9]{5,32}$/.test(String(userId || ''))) return null;
    return {
      action,
      step: normalizeOnboardingStep(rawStep),
      userId,
      value: String(rest.join(':') || '').trim().toLowerCase(),
    };
  }

  function buildOnboardingConfigRow(step, key, userId, session = null, language = defaultUiLanguage) {
    const lang = normalizeUiLanguage(language);
    const current = normalizeOnboardingStep(step);

    if (current === 1) {
      const activeLanguage = getSessionLanguage(session);
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(buildOnboardingButtonId('set_lang', current, userId, 'zh'))
          .setLabel('中文')
          .setStyle(activeLanguage === 'zh' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildOnboardingButtonId('set_lang', current, userId, 'en'))
          .setLabel('English')
          .setStyle(activeLanguage === 'en' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      );
    }

    if (current === 2) {
      if (botProvider) return null;
      const activeProvider = getSessionProvider(session);
      return new ActionRowBuilder().addComponents(
        ...PROVIDER_CHOICES.map((provider) => new ButtonBuilder()
          .setCustomId(buildOnboardingButtonId('set_provider', current, userId, provider))
          .setLabel(provider)
          .setStyle(activeProvider === provider ? ButtonStyle.Primary : ButtonStyle.Secondary)),
      );
    }

    if (current === 3) {
      const binding = getWorkspaceBinding(session, key) || {};
      const hasThreadOverride = binding.source === 'thread override';
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(buildOnboardingButtonId('workspace_default', current, userId))
          .setLabel(lang === 'en' ? 'Use Default' : '使用默认')
          .setStyle(hasThreadOverride ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(!hasThreadOverride),
        new ButtonBuilder()
          .setCustomId(buildOnboardingButtonId('workspace_browse', current, userId))
          .setLabel(lang === 'en' ? 'Browse...' : '浏览...')
          .setStyle(ButtonStyle.Primary),
      );
    }

    return null;
  }

  function buildOnboardingActionRows(step, key, userId, session = null, language = defaultUiLanguage) {
    const lang = normalizeUiLanguage(language);
    const current = normalizeOnboardingStep(step);
    const previous = normalizeOnboardingStep(current - 1);
    const next = normalizeOnboardingStep(current + 1);
    const rows = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(buildOnboardingButtonId('goto', previous, userId))
          .setLabel(lang === 'en' ? 'Previous' : '上一步')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(current <= 1),
        new ButtonBuilder()
          .setCustomId(buildOnboardingButtonId('refresh', current, userId))
          .setLabel(lang === 'en' ? 'Refresh' : '刷新')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildOnboardingButtonId('goto', next, userId))
          .setLabel(lang === 'en' ? 'Next' : '下一步')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(current >= onboardingTotalSteps),
        new ButtonBuilder()
          .setCustomId(buildOnboardingButtonId('done', current, userId))
          .setLabel(lang === 'en' ? 'Done' : '完成')
          .setStyle(ButtonStyle.Success),
      ),
    ];

    const configRow = buildOnboardingConfigRow(current, key, userId, session, lang);
    if (configRow) rows.push(configRow);
    return rows;
  }

  function formatOnboardingStepReport(step, key, session = null, channel = null, language = defaultUiLanguage) {
    const lang = normalizeUiLanguage(language);
    const current = normalizeOnboardingStep(step);
    const snapshot = getOnboardingSnapshot(key, session, channel, lang);
    const workspaceSummary = formatWorkspaceSummary(snapshot.binding, lang);

    if (lang === 'en') {
      switch (current) {
        case 1:
          return [
            '🧭 **Guided Setup 1/4: Language**',
            `• Current language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
            '',
            'Choose the language for bot messages in this channel, then click "Next".',
          ].join('\n');
        case 2:
          return [
            '🧭 **Guided Setup 2/4: Provider**',
            `• Current provider: ${formatProviderSummary(snapshot.provider, lang)}`,
            `• CLI health: ${formatCliHealth(snapshot.cliHealth)}`,
            snapshot.providerLocked
              ? '• This bot is locked to one provider, so switching is disabled here.'
              : '• Pick the provider you want to use in this channel.',
            '',
            snapshot.providerLocked
              ? 'Click "Next" to continue.'
              : 'Choose a provider with buttons, then click "Next".',
          ].join('\n');
        case 3:
          return [
            '🧭 **Guided Setup 3/4: Workspace**',
            `• Current workspace: ${workspaceSummary}`,
            snapshot.binding.source === 'thread override'
              ? '• This channel is using its own workspace override.'
              : '• This channel is following the default workspace for the active provider.',
            snapshot.hasWorkspaceBrowser
              ? '• "Browse..." opens a separate workspace picker for this channel.'
              : `• Use \`${slashRef('setdir')} path:browse\` or \`!setdir browse\` if you want to pick a folder interactively.`,
            '',
            'Use "Use Default" to clear the channel override, or "Browse..." to choose a folder.',
          ].join('\n');
        case 4:
        default:
          return [
            '🧭 **Guided Setup 4/4: Ready**',
            `• Language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
            `• Provider: ${formatProviderSummary(snapshot.provider, lang)}`,
            `• Workspace: ${workspaceSummary}`,
            '',
            `Send the first task: ${snapshot.firstPromptHint}`,
            `Need a quick check? Use \`${slashRef('status')}\` or \`!status\`. If something looks wrong, run \`${slashRef('doctor')}\`.`,
            '',
            'Click "Done" when you are ready.',
          ].join('\n');
      }
    }

    switch (current) {
      case 1:
        return [
          '🧭 **首跑引导 1/4：语言**',
          `• 当前语言：${formatLanguageLabel(snapshot.currentLanguage)}`,
          '',
          '请选择这个频道里 Bot 消息提示的语言，然后点「下一步」。',
        ].join('\n');
      case 2:
        return [
          '🧭 **首跑引导 2/4：Provider**',
          `• 当前 provider：${formatProviderSummary(snapshot.provider, lang)}`,
          `• CLI 健康状态：${formatCliHealth(snapshot.cliHealth)}`,
          snapshot.providerLocked
            ? '• 当前 bot 已锁定单一 provider，这里不能切换。'
            : '• 请选择这个频道接下来要用的 provider。',
          '',
          snapshot.providerLocked
            ? '直接点「下一步」继续。'
            : '请选择 provider，然后点「下一步」。',
        ].join('\n');
      case 3:
        return [
          '🧭 **首跑引导 3/4：Workspace**',
          `• 当前 workspace：${workspaceSummary}`,
          snapshot.binding.source === 'thread override'
            ? '• 当前频道正在使用自己的 workspace 覆盖。'
            : '• 当前频道正在跟随 active provider 的默认 workspace。',
          snapshot.hasWorkspaceBrowser
            ? '• 「浏览...」会打开一个独立的路径选择器。'
            : `• 如果要交互式选目录，可用 \`${slashRef('setdir')} path:browse\` 或 \`!setdir browse\`。`,
          '',
          '可用「使用默认」清除当前频道覆盖，或用「浏览...」选择目录。',
        ].join('\n');
      case 4:
      default:
        return [
          '🧭 **首跑引导 4/4：Ready**',
          `• 语言：${formatLanguageLabel(snapshot.currentLanguage)}`,
          `• Provider：${formatProviderSummary(snapshot.provider, lang)}`,
          `• Workspace：${workspaceSummary}`,
          '',
          `发送第一条任务：${snapshot.firstPromptHint}`,
          `想快速确认当前设置，可用 \`${slashRef('status')}\` 或 \`!status\`。如果感觉环境有问题，再执行 \`${slashRef('doctor')}\`。`,
          '',
          '准备好了就点「完成」。',
        ].join('\n');
    }
  }

  function formatOnboardingDoneReport(key, session = null, channel = null, language = defaultUiLanguage) {
    const lang = normalizeUiLanguage(language);
    const snapshot = getOnboardingSnapshot(key, session, channel, lang);
    const workspaceSummary = formatWorkspaceSummary(snapshot.binding, lang);
    if (lang === 'en') {
      return [
        '✅ **Guided Setup Complete**',
        `• Language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
        `• Provider: ${formatProviderSummary(snapshot.provider, lang)}`,
        `• Workspace: ${workspaceSummary}`,
        '',
        `Next: ${snapshot.firstPromptHint}`,
      ].join('\n');
    }
    return [
      '✅ **首跑引导已完成**',
      `• 语言：${formatLanguageLabel(snapshot.currentLanguage)}`,
      `• Provider：${formatProviderSummary(snapshot.provider, lang)}`,
      `• Workspace：${workspaceSummary}`,
      '',
      `下一步：${snapshot.firstPromptHint}`,
    ].join('\n');
  }

  async function handleOnboardingButtonInteraction(interaction) {
    const parsed = parseOnboardingButtonId(interaction.customId);
    if (!parsed) return;

    const key = interaction.channelId;
    const session = key ? getSession(key, { channel: interaction.channel || null }) : null;
    const language = getSessionLanguage(session);

    if (parsed.userId !== interaction.user.id) {
      await interaction.reply({
        content: language === 'en'
          ? `This guided setup panel is only controllable by its creator. Run \`${slashRef('onboarding')}\` to create your own panel.`
          : `这个引导面板只对发起者可操作。请执行 \`${slashRef('onboarding')}\` 创建你自己的面板。`,
        flags: 64,
      });
      return;
    }

    if (!key) {
      await interaction.reply({ content: '❌ 无法识别当前频道。', flags: 64 });
      return;
    }

    if (!isOnboardingEnabled(session)) {
      await interaction.update({
        content: formatOnboardingDisabledMessage(language),
        components: [],
      });
      return;
    }

    if (parsed.action === 'set_lang') {
      const selectedLanguage = parseUiLanguageInput(parsed.value);
      if (selectedLanguage) {
        if (typeof commandActions.setLanguage === 'function') {
          commandActions.setLanguage(session, selectedLanguage);
        } else {
          session.language = selectedLanguage;
          saveDb();
        }
      }
    }

    if (parsed.action === 'set_provider' && !botProvider) {
      const provider = PROVIDER_CHOICES.includes(parsed.value)
        ? parsed.value
        : (parsed.value === 'gemini' || parsed.value === 'google' || parsed.value === 'agy' ? 'antigravity' : null);
      if (provider) {
        if (typeof commandActions.setProvider === 'function') {
          commandActions.setProvider(session, provider);
        } else {
          session.provider = provider;
          saveDb();
        }
      }
    }

    if (parsed.action === 'workspace_default') {
      if (typeof commandActions.clearWorkspaceDir === 'function') {
        commandActions.clearWorkspaceDir(session, key);
      } else {
        session.workspaceDir = null;
        saveDb();
      }
    }

    if (parsed.action === 'workspace_browse') {
      const currentLanguage = getSessionLanguage(session);
      if (typeof openWorkspaceBrowser === 'function') {
        await interaction.reply(openWorkspaceBrowser({
          key,
          session,
          userId: interaction.user.id,
          mode: 'thread',
          flags: 64,
        }));
        return;
      }

      await interaction.reply({
        content: currentLanguage === 'en'
          ? `Use \`${slashRef('setdir')} path:browse\` or \`!setdir browse\` to open the workspace picker.`
          : `请使用 \`${slashRef('setdir')} path:browse\` 或 \`!setdir browse\` 打开路径选择器。`,
        flags: 64,
      });
      return;
    }

    const currentLanguage = getSessionLanguage(session);

    if (parsed.action === 'done') {
      await interaction.update({
        content: formatOnboardingDoneReport(key, session, interaction.channel, currentLanguage),
        components: [],
      });
      return;
    }

    await interaction.update({
      content: formatOnboardingStepReport(parsed.step, key, session, interaction.channel, currentLanguage),
      components: buildOnboardingActionRows(parsed.step, key, interaction.user.id, session, currentLanguage),
    });
  }

  return {
    isOnboardingEnabled,
    parseOnboardingConfigAction,
    formatOnboardingDisabledMessage,
    formatOnboardingConfigReport,
    formatOnboardingConfigHelp,
    formatOnboardingReport,
    isOnboardingButtonId,
    buildOnboardingActionRows,
    formatOnboardingStepReport,
    formatOnboardingDoneReport,
    handleOnboardingButtonInteraction,
  };
}
