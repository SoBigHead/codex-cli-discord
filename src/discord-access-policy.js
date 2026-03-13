export function createDiscordAccessPolicy({
  allowedChannelIds = null,
  allowedUserIds = null,
} = {}) {
  function isAllowedUser(userId) {
    if (!allowedUserIds) return true;
    return allowedUserIds.has(userId);
  }

  function isAllowedChannel(channel) {
    if (!allowedChannelIds) return true;
    if (allowedChannelIds.has(channel.id)) return true;

    const parentId = channel.isThread?.() ? channel.parentId : null;
    return Boolean(parentId && allowedChannelIds.has(parentId));
  }

  async function isAllowedInteractionChannel(interaction) {
    if (!allowedChannelIds) return true;

    const channelId = interaction.channelId;
    if (channelId && allowedChannelIds.has(channelId)) return true;

    let channel = interaction.channel || null;
    if (!channel && channelId) {
      try {
        channel = await interaction.client.channels.fetch(channelId);
      } catch {
        channel = null;
      }
    }
    if (!channel) return false;

    const parentId = channel.isThread?.() ? channel.parentId : null;
    return Boolean(parentId && allowedChannelIds.has(parentId));
  }

  return {
    isAllowedUser,
    isAllowedChannel,
    isAllowedInteractionChannel,
  };
}
