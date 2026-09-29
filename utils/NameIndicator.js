import { GuildMap } from "../db/index.js";

export const NAME_INDICATOR_STYLES = {
  full: { discord: "[Discord]", fluxer: "[Fluxer]" },
  short: { discord: "[D]", fluxer: "[F]" },
};

const MAX_WEBHOOK_NAME = 80;

export async function resolveNameIndicator(receiverGuildId, senderGuildId) {
  const guildIds = [
    ...new Set([receiverGuildId, senderGuildId].filter(Boolean)),
  ];
  if (guildIds.length === 0) return null;

  const rows = await GuildMap.findAll({
    where: { guildId: guildIds },
    attributes: ["guildId", "nameIndicator"],
    raw: true,
  });

  for (const guildId of guildIds) {
    const style =
      NAME_INDICATOR_STYLES[
        rows.find((x) => x.guildId === guildId)?.nameIndicator
      ];
    if (style) return style;
  }

  return null;
}

export function indicatorPrefix(platform, indicator) {
  return indicator ? `${indicator[platform]} ` : "";
}

export function withIndicator(name, platform, indicator) {
  const prefix = indicatorPrefix(platform, indicator);
  if (!prefix) return name;
  return prefix + name.slice(0, MAX_WEBHOOK_NAME - prefix.length);
}
