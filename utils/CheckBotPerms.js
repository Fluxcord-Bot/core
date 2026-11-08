import { ChannelType as DiscordChannelType, GuildMember as DiscordGuildMember } from "discord.js";
import { Channel, ChannelType as FluxerChannelType, GuildMember as FluxerGuildMember, GuildChannel } from "@fluxerjs/core";

export function checkBotPermissions(botMember, channel) {
  const isFluxer = botMember instanceof FluxerGuildMember;
  const isVoice = isFluxer
    ? channel.type === FluxerChannelType.GuildVoice
    : channel.type === DiscordChannelType.GuildVoice || channel.type === DiscordChannelType.GuildStageVoice;
  const perms = isFluxer ? botMember.permissionsIn(channel) : channel.permissionsFor(botMember);
  const missingCritical = perms.missing([
    "ViewChannel",
    "SendMessages",
    "ManageMessages",
    "ManageWebhooks",
    "EmbedLinks",
    "AttachFiles",
    "ReadMessageHistory",
    "AddReactions",
    ...(isVoice ? (isFluxer ? ["Connect", "Speak", "UseVad"] : ["Connect", "Speak", "UseVAD", "SetVoiceChannelStatus"]) : []),
  ]);
  const missingOptional = perms.missing(
    isFluxer
      ? ["UseExternalEmojis", "UseExternalStickers", "PinMessages", "ManageChannels"]
      : [
          "MentionEveryone",
          "UseExternalEmojis",
          "UseExternalStickers",
          "PinMessages",
          "SendPolls",
          "ManageChannels",
          "CreatePublicThreads",
          "SendMessagesInThreads",
          "ManageThreads",
        ]
  );
  return {
    missingGuildCritical: [],
    missingCritical,
    missingOptional: [...missingOptional],
    hasAllCritical: missingCritical.length === 0,
  };
}
