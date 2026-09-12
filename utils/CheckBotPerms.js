import {
  ChannelType as DiscordChannelType,
  GuildMember as DiscordGuildMember,
} from "discord.js";
import {
  ChannelType as FluxerChannelType,
  GuildMember as FluxerGuildMember,
} from "@fluxerjs/core";

export function checkBotPermissions(botMember, channel) {
  const isFluxer = botMember instanceof FluxerGuildMember;
  const isVoice = isFluxer
    ? channel.type === FluxerChannelType.GuildVoice
    : channel.type === DiscordChannelType.GuildVoice ||
      channel.type === DiscordChannelType.GuildStageVoice;
  const perms = isFluxer
    ? botMember.permissionsIn(channel)
    : channel.permissionsFor(botMember);
  const missingGuildCritical = isFluxer
    ? botMember.permissions.missing([
        "ManageRoles",
        "ManageExpressions",
        "CreateExpressions",
      ])
    : [];
  const missingCritical = perms.missing([
    "ViewChannel",
    "SendMessages",
    "ManageMessages",
    "ManageWebhooks",
    "EmbedLinks",
    "AttachFiles",
    "ReadMessageHistory",
    "AddReactions",
    ...(isVoice
      ? isFluxer
        ? ["Connect", "Speak", "UseVad"]
        : ["Connect", "Speak", "UseVAD", "SetVoiceChannelStatus"]
      : []),
  ]);
  const missingOptional = perms.missing(
    isFluxer
      ? ["UseExternalEmojis", "UseExternalStickers", "PinMessages"]
      : [
          "MentionEveryone",
          "UseExternalEmojis",
          "UseExternalStickers",
          "PinMessages",
          "SendPolls",
          "CreatePublicThreads",
          "SendMessagesInThreads",
        ],
  );
  return {
    missingGuildCritical,
    missingCritical,
    missingOptional,
    hasAllCritical:
      missingGuildCritical.length === 0 && missingCritical.length === 0,
  };
}
