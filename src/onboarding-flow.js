export function createOnboardingFlow({
  onboardingEnabledByDefault = true,
  defaultUiLanguage = 'en',
  onboardingTotalSteps = 4,
  workspaceRoot = '',
  discordToken = '',
  allowedChannelIds = null,
  allowedUserIds = null,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  getSession,
  saveDb,
  getSessionProvider,
  getRuntimeSnapshot,
  getCliHealth,
  resolveSecurityContext,
  getEffectiveSecurityProfile,
  resolveTimeoutSetting,
  getSessionLanguage,
  normalizeUiLanguage,
  slashRef,
  formatCliHealth,
  formatLanguageLabel,
  formatSecurityProfileLabel,
  formatTimeoutLabel,
  formatQueueLimit,
  formatSecurityProfileDisplay,
  formatConfigCommandStatus,
  parseUiLanguageInput,
  parseSecurityProfileInput,
  parseTimeoutConfigAction,
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
        'ℹ️ Onboarding is currently disabled in this channel.',
        `Enable with \`${slashRef('onboarding_config')} on\` or \`!onboarding on\`.`,
      ].join('\n');
    }
    return [
      'ℹ️ 当前频道已关闭 onboarding。',
      `可通过 \`${slashRef('onboarding_config')} on\` 或 \`!onboarding on\` 重新开启。`,
    ].join('\n');
  }

  function formatOnboardingConfigReport(language, enabled, changed) {
    const state = enabled ? 'on' : 'off';
    if (language === 'en') {
      if (changed) {
        return `✅ Onboarding is now ${state}\nUse \`${slashRef('onboarding')}\` or \`!onboarding\` to open guide.`;
      }
      return `ℹ️ Onboarding is currently ${state}`;
    }
    if (changed) {
      return `✅ onboarding 已设置为 ${state}\n可使用 \`${slashRef('onboarding')}\` 或 \`!onboarding\` 打开引导。`;
    }
    return `ℹ️ 当前 onboarding = ${state}`;
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
    const provider = getSessionProvider(session);
    const runtime = getRuntimeSnapshot(key);
    const cliHealth = getCliHealth(provider);
    const security = resolveSecurityContext(channel, session);
    const profileSetting = getEffectiveSecurityProfile(session);
    const timeoutSetting = resolveTimeoutSetting(session);
    const currentLanguage = getSessionLanguage(session);
    const hasToken = Boolean(discordToken);
    const hasWorkspace = Boolean(String(workspaceRoot || '').trim());
    const lang = normalizeUiLanguage(language);
    const mentionHint = security.mentionOnly
      ? (lang === 'en'
        ? 'Normal chat messages require @Bot mention (or use `!` commands).'
        : '本频道普通消息需 @Bot（或直接用 `!` 命令）。')
      : (lang === 'en'
        ? 'Normal messages in this channel can be sent directly to the bot.'
        : '本频道普通消息可直接发送给 Bot。');
    const firstPromptHint = security.mentionOnly
      ? (lang === 'en'
        ? 'Send `@Bot check current directory and create a TODO`'
        : '发送 `@Bot 帮我检查当前目录并创建一个 TODO`')
      : (lang === 'en'
        ? 'Send `check current directory and create a TODO`'
        : '发送 `帮我检查当前目录并创建一个 TODO`');
    return {
      provider,
      language: lang,
      runtime,
      cliHealth,
      security,
      profileSetting,
      timeoutSetting,
      currentLanguage,
      hasToken,
      hasWorkspace,
      mentionHint,
      firstPromptHint,
    };
  }

  function formatOnboardingReport(key, session = null, channel = null, language = defaultUiLanguage) {
    const lang = normalizeUiLanguage(language);
    const snapshot = getOnboardingSnapshot(key, session, channel, lang);
    if (lang === 'en') {
      return [
        '🧭 **Onboarding (Text)**',
        `• For interactive steps, use \`${slashRef('onboarding')}\` (buttons + direct config on each step)`,
        '',
        '**1) Preflight check**',
        `• DISCORD_TOKEN: ${snapshot.hasToken ? '✅ loaded' : '❌ missing'}`,
        `• WORKSPACE_ROOT: ${snapshot.hasWorkspace ? `✅ \`${workspaceRoot}\`` : '❌ missing'}`,
        `• cli: ${formatCliHealth(snapshot.cliHealth)}`,
        `• ui language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
        `• profile setting: ${formatSecurityProfileLabel(snapshot.profileSetting.profile)} (${snapshot.profileSetting.source})`,
        `• timeout setting: ${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)} (${snapshot.timeoutSetting.source})`,
        '',
        '**2) Access scope & security policy (effective now)**',
        `• ALLOWED_CHANNEL_IDS: ${allowedChannelIds ? `${allowedChannelIds.size} configured` : '(all channels)'}`,
        `• ALLOWED_USER_IDS: ${allowedUserIds ? `${allowedUserIds.size} configured` : '(all users)'}`,
        `• security profile: ${formatSecurityProfileDisplay(snapshot.security)}`,
        `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'} (${snapshot.mentionHint})`,
        `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
        `• queued prompts now: ${snapshot.runtime.queued}`,
        `• !config: ${formatConfigCommandStatus()}`,
        '',
        '**3) First run flow**',
        `1. \`${slashRef('doctor')}\` or \`!doctor\` to verify health checks.`,
        `2. \`${slashRef('status')}\` or \`!status\` to verify mode/model/workspace.`,
        `3. \`${slashRef('setdir')} <path>\` or \`!setdir <path>\` to bind target project.`,
        `4. Send your first task: ${snapshot.firstPromptHint}`,
        `5. If backlog appears, check \`${slashRef('queue')}\` / \`!queue\`; use \`${slashRef('cancel')}\` / \`!abort\` when needed.`,
        '',
        '**4) Recommended defaults**',
        '• Start with 1 channel + 1 admin account, then gradually open access.',
        '• Keep `ENABLE_CONFIG_CMD=false`; if enabled, allowlist only required keys.',
        '• Keep `safe` as default; switch to `dangerous` only in trusted environments.',
        '',
        `Quick re-check: \`${slashRef('doctor')}\``,
      ].join('\n');
    }
    return [
      '🧭 **Onboarding（文本版）**',
      `• 交互分步版请使用 \`${slashRef('onboarding')}\`（每步可直接配置 + 上一步/下一步/完成）`,
      '',
      '**1) 安装自检（先看当前是否可跑）**',
      `• DISCORD_TOKEN: ${snapshot.hasToken ? '✅ loaded' : '❌ missing'}`,
      `• WORKSPACE_ROOT: ${snapshot.hasWorkspace ? `✅ \`${workspaceRoot}\`` : '❌ missing'}`,
      `• cli: ${formatCliHealth(snapshot.cliHealth)}`,
      `• ui language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
      `• profile setting: ${formatSecurityProfileLabel(snapshot.profileSetting.profile)}（${snapshot.profileSetting.source}）`,
      `• timeout setting: ${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)}（${snapshot.timeoutSetting.source}）`,
      '',
      '**2) 访问范围与安全策略（当前生效）**',
      `• ALLOWED_CHANNEL_IDS: ${allowedChannelIds ? `${allowedChannelIds.size} configured` : '(all channels)'}`,
      `• ALLOWED_USER_IDS: ${allowedUserIds ? `${allowedUserIds.size} configured` : '(all users)'}`,
      `• security profile: ${formatSecurityProfileDisplay(snapshot.security)}`,
      `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'}（${snapshot.mentionHint}）`,
      `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
      `• queued prompts now: ${snapshot.runtime.queued}`,
      `• !config: ${formatConfigCommandStatus()}`,
      '',
      '**3) 首跑流程（按顺序）**',
      `1. \`${slashRef('doctor')}\` 或 \`!doctor\`，确认健康检查通过。`,
      `2. \`${slashRef('status')}\` 或 \`!status\`，确认 mode/model/workspace。`,
      `3. \`${slashRef('setdir')} <path>\` 或 \`!setdir <path>\`，绑定目标项目目录。`,
      `4. 发送第一条任务：${snapshot.firstPromptHint}`,
      `5. 如有积压，用 \`${slashRef('queue')}\` / \`!queue\` 查看；必要时 \`${slashRef('cancel')}\` / \`!abort\`。`,
      '',
      '**4) 新用户默认建议**',
      '• 先限制到 1 个频道 + 1 个管理员账号，再逐步放开。',
      '• 保持 `ENABLE_CONFIG_CMD=false`；确实要开时仅白名单必要 key。',
      '• 默认用 `safe`；仅在可信环境切到 `dangerous`。',
      '',
      `需要快速复查时可直接执行：\`${slashRef('doctor')}\``,
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
    if (!['goto', 'refresh', 'done', 'set_lang', 'set_profile', 'set_timeout'].includes(action)) return null;
    if (!/^[0-9]{5,32}$/.test(String(userId || ''))) return null;
    return {
      action,
      step: normalizeOnboardingStep(rawStep),
      userId,
      value: String(rest.join(':') || '').trim().toLowerCase(),
    };
  }

  function buildOnboardingConfigRow(step, userId, session = null, language = defaultUiLanguage) {
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
      const activeProfile = getEffectiveSecurityProfile(session).profile;
      const options = ['auto', 'solo', 'team', 'public'];
      return new ActionRowBuilder().addComponents(
        ...options.map((profile) => new ButtonBuilder()
          .setCustomId(buildOnboardingButtonId('set_profile', current, userId, profile))
          .setLabel(profile)
          .setStyle(activeProfile === profile ? ButtonStyle.Primary : ButtonStyle.Secondary)),
      );
    }

    if (current === 3) {
      const activeTimeoutMs = resolveTimeoutSetting(session).timeoutMs;
      const presets = [
        { value: 0, label: lang === 'en' ? 'off' : '关闭' },
        { value: 30000, label: '30s' },
        { value: 60000, label: '60s' },
        { value: 120000, label: '120s' },
      ];
      return new ActionRowBuilder().addComponents(
        ...presets.map((preset) => new ButtonBuilder()
          .setCustomId(buildOnboardingButtonId('set_timeout', current, userId, String(preset.value)))
          .setLabel(preset.label)
          .setStyle(activeTimeoutMs === preset.value ? ButtonStyle.Primary : ButtonStyle.Secondary)),
      );
    }

    return null;
  }

  function buildOnboardingActionRows(step, userId, session = null, language = defaultUiLanguage) {
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
    const configRow = buildOnboardingConfigRow(current, userId, session, lang);
    if (configRow) rows.push(configRow);
    return rows;
  }

  function formatOnboardingStepReport(step, key, session = null, channel = null, language = defaultUiLanguage) {
    const lang = normalizeUiLanguage(language);
    const current = normalizeOnboardingStep(step);
    const snapshot = getOnboardingSnapshot(key, session, channel, lang);
    if (lang === 'en') {
      switch (current) {
        case 1:
          return [
            '🧭 **Onboarding 1/4: Preflight + Language**',
            `• DISCORD_TOKEN: ${snapshot.hasToken ? '✅ loaded' : '❌ missing'}`,
            `• WORKSPACE_ROOT: ${snapshot.hasWorkspace ? `✅ \`${workspaceRoot}\`` : '❌ missing'}`,
            `• cli: ${formatCliHealth(snapshot.cliHealth)}`,
            `• ui language (current): ${formatLanguageLabel(snapshot.currentLanguage)}`,
            '',
            'Choose language with buttons, then click "Next".',
          ].join('\n');
        case 2:
          return [
            '🧭 **Onboarding 2/4: Scope & Security Profile**',
            `• ALLOWED_CHANNEL_IDS: ${allowedChannelIds ? `${allowedChannelIds.size} configured` : '(all channels)'}`,
            `• ALLOWED_USER_IDS: ${allowedUserIds ? `${allowedUserIds.size} configured` : '(all users)'}`,
            `• security profile: ${formatSecurityProfileDisplay(snapshot.security)}`,
            `• profile setting: ${formatSecurityProfileLabel(snapshot.profileSetting.profile)} (${snapshot.profileSetting.source})`,
            `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'} (${snapshot.mentionHint})`,
            `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
            `• queued prompts now: ${snapshot.runtime.queued}`,
            '',
            'Choose `auto/solo/team/public` with buttons, then click "Next".',
          ].join('\n');
        case 3:
          return [
            '🧭 **Onboarding 3/4: Timeout**',
            `• runner timeout (current): ${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)} (${snapshot.timeoutSetting.source})`,
            '• quick presets: off / 30s / 60s / 120s',
            `• custom value: \`${slashRef('timeout')} <ms|off|status>\` or \`!timeout <ms|off|status>\``,
            '',
            'Choose a timeout preset with buttons, then click "Next".',
          ].join('\n');
        case 4:
        default:
          return [
            '🧭 **Onboarding 4/4: First Run Checklist**',
            `1. \`${slashRef('doctor')}\` or \`!doctor\` to verify health checks.`,
            `2. \`${slashRef('status')}\` or \`!status\` to verify mode/model/workspace/profile/timeout.`,
            `3. \`${slashRef('setdir')} <path>\` or \`!setdir <path>\` to bind project path.`,
            `4. Send the first task: ${snapshot.firstPromptHint}`,
            `5. Use \`${slashRef('queue')}\` / \`!queue\` for backlog, \`${slashRef('cancel')}\` / \`!abort\` to stop.`,
            '',
            `Current settings: language=${formatLanguageLabel(snapshot.currentLanguage)}, profile=${formatSecurityProfileLabel(snapshot.profileSetting.profile)}, timeout=${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)}`,
            '',
            'Click "Done" when finished.',
          ].join('\n');
      }
    }
    switch (current) {
      case 1:
        return [
          '🧭 **Onboarding 1/4：安装自检 + 语言设置**',
          `• DISCORD_TOKEN: ${snapshot.hasToken ? '✅ loaded' : '❌ missing'}`,
          `• WORKSPACE_ROOT: ${snapshot.hasWorkspace ? `✅ \`${workspaceRoot}\`` : '❌ missing'}`,
          `• cli: ${formatCliHealth(snapshot.cliHealth)}`,
          `• ui language（当前）：${formatLanguageLabel(snapshot.currentLanguage)}`,
          '',
          '请用按钮选择语言，然后点「下一步」。',
        ].join('\n');
      case 2:
        return [
          '🧭 **Onboarding 2/4：访问范围与安全策略**',
          `• ALLOWED_CHANNEL_IDS: ${allowedChannelIds ? `${allowedChannelIds.size} configured` : '(all channels)'}`,
          `• ALLOWED_USER_IDS: ${allowedUserIds ? `${allowedUserIds.size} configured` : '(all users)'}`,
          `• security profile: ${formatSecurityProfileDisplay(snapshot.security)}`,
          `• profile setting: ${formatSecurityProfileLabel(snapshot.profileSetting.profile)}（${snapshot.profileSetting.source}）`,
          `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'}（${snapshot.mentionHint}）`,
          `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
          `• queued prompts now: ${snapshot.runtime.queued}`,
          '',
          '请用按钮选择 `auto/solo/team/public`，然后点「下一步」。',
        ].join('\n');
      case 3:
        return [
          '🧭 **Onboarding 3/4：超时设置**',
          `• runner timeout（当前）：${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)}（${snapshot.timeoutSetting.source}）`,
          '• 快捷预设：off / 30s / 60s / 120s',
          `• 自定义值：\`${slashRef('timeout')} <毫秒|off|status>\` 或 \`!timeout <毫秒|off|status>\``,
          '',
          '请用按钮选择 timeout 预设，然后点「下一步」。',
        ].join('\n');
      case 4:
      default:
        return [
          '🧭 **Onboarding 4/4：首跑流程（5 步）**',
          `1. \`${slashRef('doctor')}\` 或 \`!doctor\`，确认健康检查通过。`,
          `2. \`${slashRef('status')}\` 或 \`!status\`，确认 mode/model/workspace/profile/timeout。`,
          `3. \`${slashRef('setdir')} <path>\` 或 \`!setdir <path>\`，绑定目标项目目录。`,
          `4. 发送第一条任务：${snapshot.firstPromptHint}`,
          `5. 如有积压，用 \`${slashRef('queue')}\` / \`!queue\` 查看；必要时 \`${slashRef('cancel')}\` / \`!abort\`。`,
          '',
          `当前设置：language=${formatLanguageLabel(snapshot.currentLanguage)}，profile=${formatSecurityProfileLabel(snapshot.profileSetting.profile)}，timeout=${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)}`,
          '完成后点击「完成」关闭引导面板。',
        ].join('\n');
    }
  }

  function formatOnboardingDoneReport(key, session = null, channel = null, language = defaultUiLanguage) {
    const lang = normalizeUiLanguage(language);
    const snapshot = getOnboardingSnapshot(key, session, channel, lang);
    if (lang === 'en') {
      return [
        '✅ **Onboarding Completed**',
        `• active security profile: ${formatSecurityProfileDisplay(snapshot.security)}`,
        `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'}`,
        `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
        `• ui language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
        `• runner timeout: ${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)} (${snapshot.timeoutSetting.source})`,
        '',
        `You can use: \`${slashRef('doctor')}\`, \`${slashRef('status')}\`, \`${slashRef('queue')}\``,
      ].join('\n');
    }
    return [
      '✅ **Onboarding 已完成**',
      `• 当前安全策略：${formatSecurityProfileDisplay(snapshot.security)}`,
      `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'}`,
      `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
      `• ui language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
      `• runner timeout: ${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)}（${snapshot.timeoutSetting.source}）`,
      '',
      `后续可直接使用：\`${slashRef('doctor')}\`、\`${slashRef('status')}\`、\`${slashRef('queue')}\``,
    ].join('\n');
  }

  async function handleOnboardingButtonInteraction(interaction) {
    const parsed = parseOnboardingButtonId(interaction.customId);
    if (!parsed) return;
    const key = interaction.channelId;
    const session = key ? getSession(key) : null;
    const language = getSessionLanguage(session);

    if (parsed.userId !== interaction.user.id) {
      await interaction.reply({
        content: language === 'en'
          ? `This onboarding panel is only controllable by its creator. Run \`${slashRef('onboarding')}\` to create your own panel.`
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
        session.language = selectedLanguage;
        saveDb();
      }
    }

    if (parsed.action === 'set_profile') {
      const profile = parseSecurityProfileInput(parsed.value);
      if (profile) {
        session.securityProfile = profile;
        saveDb();
      }
    }

    if (parsed.action === 'set_timeout') {
      const timeoutAction = parseTimeoutConfigAction(parsed.value);
      if (timeoutAction?.type === 'set') {
        session.timeoutMs = timeoutAction.timeoutMs;
        saveDb();
      }
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
      components: buildOnboardingActionRows(parsed.step, interaction.user.id, session, currentLanguage),
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
