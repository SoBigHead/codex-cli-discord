export function createDiscordEntryHandlers({
  logger = console,
  registerSlashCommands,
  REST,
  Routes,
  discordToken,
  restProxyAgent = null,
  slashCommands = [],
  withDiscordNetworkRetry,
  safeReply,
  safeError = (err) => err?.message || String(err),
  isIgnorableDiscordRuntimeError = () => false,
  isRecoverableGatewayCloseCode = () => true,
  isAllowedUser = () => true,
  isAllowedChannel = () => true,
  isAllowedInteractionChannel = async () => true,
  getSession,
  resolveSecurityContext,
  handleCommand,
  enqueuePrompt,
  doesMessageTargetBot,
  buildPromptFromMessage,
  parseCommandActionButtonId,
  isWorkspaceBrowserComponentId,
  isOnboardingButtonId,
  handleWorkspaceBrowserInteraction,
  handleOnboardingButtonInteraction,
  routeSlashCommand,
  normalizeSlashCommandName,
} = {}) {
  async function joinThreadWithRetry(thread, context = 'thread.join') {
    if (!thread || thread.joined) return;

    await withDiscordNetworkRetry(
      () => thread.join(),
      {
        logger,
        label: `${context} thread.join (${thread.id})`,
        maxAttempts: 4,
        baseDelayMs: 500,
      },
    );
  }

  async function handleMessageCreate(message, bot) {
    try {
      if (message.author.bot) return;
      if (message.system) return;
      if (!isAllowedUser(message.author.id)) return;
      const channelAllowed = isAllowedChannel(message.channel);
      const key = message.channel.id;
      const session = getSession(key);
      const security = resolveSecurityContext(message.channel, session);

      const chId = message.channel.id;
      const parentId = message.channel.isThread?.() ? message.channel.parentId : null;
      const attachmentCount = message.attachments?.size || 0;
      logger.log(`[msg] ch=${chId} parent=${parentId} author=${message.author.tag} allowed=${channelAllowed} profile=${security.profile} mentionOnly=${security.mentionOnly} contentLen=${message.content.length} attachments=${attachmentCount} system=${message.system}`);

      if (!channelAllowed) return;

      const rawContent = message.content
        .replace(new RegExp(`<@!?${bot.user.id}>`, 'g'), '')
        .trim();
      const isCommand = rawContent.startsWith('!');

      if (isCommand) {
        await handleCommand(message, key, rawContent);
        return;
      }

      if (security.mentionOnly && !doesMessageTargetBot(message, bot.user.id)) return;

      const content = buildPromptFromMessage(rawContent, message.attachments);
      if (!content) return;
      await enqueuePrompt(message, key, content, security);
    } catch (err) {
      logger.error('messageCreate handler error:', err);
      try {
        await message.reactions.cache.get('⚡')?.users.remove(bot.user?.id).catch(() => {});
        await message.react('❌').catch(() => {});
        await safeReply(message, `❌ 处理失败：${safeError(err)}`);
      } catch {
        // ignore
      }
    }
  }

  async function sendInteractionResponse(interaction, payload) {
    const body = typeof payload === 'string' ? { content: payload } : payload;
    if (interaction.deferred && !interaction.replied) {
      const { flags: _ignoredFlags, ...editPayload } = body;
      return interaction.editReply(editPayload);
    }
    if (interaction.replied) {
      return interaction.followUp(body);
    }
    return interaction.reply(body);
  }

  async function safeInteractionFailureReply(interaction, err) {
    if (isIgnorableDiscordRuntimeError(err)) {
      logger.warn(`Ignoring non-fatal interaction error: ${safeError(err)}`);
      return;
    }

    try {
      await sendInteractionResponse(interaction, { content: `❌ ${safeError(err)}`, flags: 64 });
    } catch (replyErr) {
      if (isIgnorableDiscordRuntimeError(replyErr)) {
        logger.warn(`Ignoring non-fatal interaction reply error: ${safeError(replyErr)}`);
        return;
      }
      throw replyErr;
    }
  }

  async function handleInteractionCreate(interaction) {
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      const isWorkspaceBrowser = isWorkspaceBrowserComponentId(interaction.customId);
      const commandButton = interaction.isButton() ? parseCommandActionButtonId(interaction.customId) : null;
      const isOnboarding = interaction.isButton() && isOnboardingButtonId(interaction.customId);
      if (!isWorkspaceBrowser && !isOnboarding && !commandButton) return;
      try {
        if (!isAllowedUser(interaction.user.id)) {
          await interaction.reply({ content: '⛔ 没有权限。', flags: 64 });
          return;
        }
        if (!(await isAllowedInteractionChannel(interaction))) {
          await interaction.reply({ content: '⛔ 当前频道未开放。', flags: 64 });
          return;
        }
        if (commandButton) {
          if (commandButton.userId !== interaction.user.id) {
            await interaction.reply({ content: '⛔ 这组快捷按钮属于发起命令的用户。', flags: 64 });
            return;
          }
          const handled = await routeSlashCommand({
            interaction,
            commandName: commandButton.command,
            respond: (payload) => sendInteractionResponse(interaction, payload),
          });
          if (!handled) {
            await interaction.reply({ content: '❌ 快捷按钮已失效，请重新执行 slash 命令。', flags: 64 });
          }
          return;
        }
        if (isWorkspaceBrowser) {
          await handleWorkspaceBrowserInteraction(interaction);
          return;
        }
        await handleOnboardingButtonInteraction(interaction);
      } catch (err) {
        await safeInteractionFailureReply(interaction, err);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (!isAllowedUser(interaction.user.id)) {
      await interaction.reply({ content: '⛔ 没有权限。', flags: 64 });
      return;
    }

    try {
      await interaction.deferReply({ flags: 64 });
      const respond = (payload) => sendInteractionResponse(interaction, payload);

      if (!(await isAllowedInteractionChannel(interaction))) {
        await respond({ content: '⛔ 当前频道未开放。', flags: 64 });
        return;
      }

      const cmd = normalizeSlashCommandName(interaction.commandName);
      const handled = await routeSlashCommand({
        interaction,
        commandName: cmd,
        respond,
      });
      if (!handled) {
        await respond({ content: `❌ 未知命令：\`${interaction.commandName}\``, flags: 64 });
      }
    } catch (err) {
      await safeInteractionFailureReply(interaction, err);
    }
  }

  function bindClientHandlers(bot, lifecycle) {
    bot.once('ready', async () => {
      logger.log(`✅ Logged in as ${bot.user.tag}`);
      await registerSlashCommands({
        client: bot,
        REST,
        Routes,
        discordToken,
        restProxyAgent,
        slashCommands,
        logger,
      });
    });

    bot.on('threadCreate', async (thread) => {
      try {
        await joinThreadWithRetry(thread, 'threadCreate');
        logger.log(`🧵 Joined thread: ${thread.name} (${thread.id})`);
      } catch (err) {
        logger.error(`Failed to join thread ${thread.id}:`, err.message);
      }
    });

    bot.on('threadListSync', (threads) => {
      for (const thread of threads.values()) {
        if (!thread.joined) {
          joinThreadWithRetry(thread, 'threadListSync')
            .then(() => logger.log(`🧵 Synced into thread: ${thread.name}`))
            .catch((err) => logger.error(`Failed to sync thread ${thread.id}:`, err.message));
        }
      }
    });

    bot.on('messageCreate', (message) => handleMessageCreate(message, bot));
    bot.on('interactionCreate', handleInteractionCreate);

    bot.on('error', (err) => {
      if (isIgnorableDiscordRuntimeError(err)) {
        logger.warn(`Ignoring non-fatal Discord client error: ${safeError(err)}`);
        return;
      }
      logger.error('Discord client error:', err);
      lifecycle.scheduleSelfHeal('client_error', err);
    });

    bot.on('shardError', (err, shardId) => {
      logger.error(`Discord shard error (shard=${shardId}):`, err);
      lifecycle.scheduleSelfHeal(`shard_error:${shardId}`, err);
    });

    bot.on('shardDisconnect', (event, shardId) => {
      const code = event?.code ?? 'unknown';
      const recoverable = isRecoverableGatewayCloseCode(code);
      logger.warn(`Discord shard disconnected (shard=${shardId}, code=${code}, recoverable=${recoverable})`);
      if (recoverable) {
        lifecycle.scheduleSelfHeal(`shard_disconnect:${shardId}:code=${code}`);
      }
    });

    bot.on('invalidated', () => {
      logger.error('Discord session invalidated.');
      lifecycle.scheduleSelfHeal('session_invalidated');
    });
  }

  return {
    bindClientHandlers,
    handleInteractionCreate,
    handleMessageCreate,
    joinThreadWithRetry,
    sendInteractionResponse,
    safeInteractionFailureReply,
  };
}
