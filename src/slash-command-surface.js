import { buildSlashCommandEntries } from './command-spec.js';

export function slashName(base, slashPrefix = '') {
  const cmd = String(base || '').trim().toLowerCase();
  if (!slashPrefix) return cmd;

  const prefix = `${slashPrefix}_`;
  const maxBaseLen = Math.max(1, 32 - prefix.length);
  return `${prefix}${cmd.slice(0, maxBaseLen)}`;
}

export function normalizeSlashCommandName(name, slashPrefix = '') {
  const raw = String(name || '').trim().toLowerCase();
  if (!slashPrefix) return raw;
  const prefix = `${slashPrefix}_`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

export function slashRef(base, slashPrefix = '') {
  return `/${slashName(base, slashPrefix)}`;
}

function buildSlashCommandBuilder(entry, commandName, { SlashCommandBuilder, slashPrefix }) {
  const builder = new SlashCommandBuilder()
    .setName(slashName(commandName, slashPrefix))
    .setDescription(entry.aliasDescriptions?.[commandName] || entry.description);
  return entry.configure ? entry.configure(builder) : builder;
}

export function buildSlashCommands({ SlashCommandBuilder, slashPrefix = '', botProvider = null } = {}) {
  return buildSlashCommandEntries({ botProvider }).flatMap((entry) => {
    const names = [entry.name, ...(entry.aliases || [])];
    return names.map((name) => buildSlashCommandBuilder(entry, name, { SlashCommandBuilder, slashPrefix }));
  });
}

export async function registerSlashCommands({
  client,
  REST,
  Routes,
  discordToken,
  restProxyAgent = null,
  slashCommands,
  logger = console,
} = {}) {
  try {
    const rest = new REST({ version: '10' }).setToken(discordToken);
    if (restProxyAgent) {
      rest.setAgent(restProxyAgent);
    }
    const body = slashCommands.map(c => c.toJSON());
    const guildTargets = [...client.guilds.cache.values()].map((guild) => ({
      id: guild.id,
      name: guild.name || guild.id,
    }));

    if (!guildTargets.length) {
      try {
        const fetched = await client.guilds.fetch();
        for (const guild of fetched.values()) {
          guildTargets.push({
            id: guild.id,
            name: guild.name || guild.id,
          });
        }
      } catch (fetchErr) {
        logger.warn(`⚠️ Failed to fetch guild list for slash registration: ${fetchErr?.message || fetchErr}`);
      }
    }

    if (!guildTargets.length) {
      logger.warn('⚠️ No guilds available for slash command registration.');
      return;
    }

    for (const guild of guildTargets) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body });
      logger.log(`📝 Registered ${body.length} slash commands in guild: ${guild.name} (${guild.id})`);
    }
  } catch (err) {
    logger.error('Failed to register slash commands:', err);
  }
}
