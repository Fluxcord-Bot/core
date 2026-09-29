import { ChannelMap, GuildMap } from "../db/index.js";

export async function getBridgeGuildMaps(guildId, guildType) {
  const channelMaps = await ChannelMap.findAll({
    where:
      guildType === "discord"
        ? { discordGuildId: guildId }
        : { fluxerGuildId: guildId },
    attributes: ["discordGuildId", "fluxerGuildId"],
  });

  const guilds = new Map([[`${guildId}:${guildType}`, { guildId, guildType }]]);
  for (const channelMap of channelMaps) {
    for (const [id, type] of [
      [channelMap.get("discordGuildId"), "discord"],
      [channelMap.get("fluxerGuildId"), "fluxer"],
    ]) {
      if (id) guilds.set(`${id}:${type}`, { guildId: id, guildType: type });
    }
  }

  const guildMaps = [];
  for (const where of guilds.values()) {
    const [guildMap] = await GuildMap.findOrCreate({ where });
    guildMaps.push(guildMap);
  }

  return guildMaps;
}

export async function applyBridgeToggle(guildId, guildType, field, requested) {
  const guildMaps = await getBridgeGuildMaps(guildId, guildType);
  const current = !guildMaps.some((g) => g.get(field) === false);
  const enabled = requested ?? !current;

  if (enabled !== current) {
    for (const guildMap of guildMaps) {
      guildMap.set(field, enabled);
      await guildMap.save();
    }
  }

  return { current, enabled, changed: enabled !== current };
}
