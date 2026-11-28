import { EmbedBuilder, Message as FluxerMessage } from "@fluxerjs/core";
import RandomString from "../../utils/RandomString.js";
import { PendingSetup } from "../../utils/CommandHandler.js";
import Config from "../../utils/ConfigHandler.js";
import { VoiceChannelMap } from "../../db/index.js";
import { ChannelType } from "discord.js";
import changeBotBio from "../../utils/ChangeBotBio.js";
import { checkBotPermissions } from "../../utils/CheckBotPerms.js";
import { isDiscordAnnouncementChannel, isVoiceChannel } from "../../utils/AnnouncementPublish.js";
import { hasSilentFlag, stripSilentFlag } from "../../utils/SilentFlag.js";
import { setupBridgePair } from "../../utils/SetupHelper.js";
import { mirrorTopicFromEndpoint } from "../../utils/TopicMirror.js";
import { instanceIdOfClient, resolveFluxerClient } from "../../utils/FluxerClients.js";
import { resolveChannelNsfw } from "../../utils/ChannelNsfw.js";
import { embedFooterForMessage } from "../../utils/PerInstance.js";

const FLUXER_GUILD_LINK = 998;

function normalizeChannelName(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isBridgeableDiscordChannel(channel) {
  if (!channel) return false;
  if (typeof channel.isThread === "function" && channel.isThread()) return false;
  if (
    channel.type === ChannelType.GuildCategory ||
    channel.type === ChannelType.GuildForum ||
    channel.type === ChannelType.GuildMedia
  ) {
    return false;
  }
  if (typeof channel.send !== "function") return false;
  return true;
}

function isBridgeableFluxerChannel(channel) {
  if (!channel) return false;
  if (typeof channel.isThread === "function" && channel.isThread()) return false;
  if (typeof channel.isForum === "function" && channel.isForum()) return false;
  if (typeof channel.isMedia === "function" && channel.isMedia()) return false;
  if (channel.type === ChannelType.GuildCategory || channel.type === FLUXER_GUILD_LINK) return false;
  if (typeof channel.send !== "function") return false;
  return true;
}

function isBridgeableChannel(channel, platform) {
  return platform === "fluxer" ? isBridgeableFluxerChannel(channel) : isBridgeableDiscordChannel(channel);
}

function findMatchingChannel(candidates, sourceChannel, candidatePlatform) {
  const channelName = normalizeChannelName(sourceChannel.name);
  const isVoice = sourceChannel.type === ChannelType.GuildVoice;
  const sourceAnnouncement = isDiscordAnnouncementChannel(sourceChannel);

  const sameType = candidates.filter(
    x => isBridgeableChannel(x, candidatePlatform) && (x.type === ChannelType.GuildVoice) === isVoice
  );

  const rankCandidates = list => {
    if (candidatePlatform !== "discord") return list;
    const sameKind = list.filter(x => isDiscordAnnouncementChannel(x) === sourceAnnouncement);
    return sameKind.length > 0 ? sameKind : list;
  };

  const ranked = rankCandidates(sameType);

  const exact = ranked.find(x => normalizeChannelName(x.name) === channelName);
  if (exact) return exact;

  const fuzzyMatches = ranked.filter(x => normalizeChannelName(x.name).endsWith(channelName));

  return fuzzyMatches[0] ?? null;
}

async function fetchGuildSide(platform, instanceId, client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  const channels = platform === "discord" ? [...(await guild.channels.fetch()).values()] : await guild.fetchChannels();
  return { platform, instanceId, client, guild, channels };
}

async function bridgeChannel(sideA, sideB, { direction, silent, discordClient }) {
  const a = sideA.channel;
  const b = sideB.channel;

  if (!isBridgeableChannel(a, sideA.platform) || !isBridgeableChannel(b, sideB.platform)) {
    return {
      success: false,
      errorType: "CHANNEL_NOT_SUPPORTED",
    };
  }

  const aVoice = isVoiceChannel(a);
  const bVoice = isVoiceChannel(b);
  if (aVoice !== bVoice) {
    return {
      success: false,
      errorType: "CHANNEL_NOT_SAME_TYPE",
    };
  }

  const [aNsfw, bNsfw] = await Promise.all([
    resolveChannelNsfw(sideA.client, a).catch(() => false),
    resolveChannelNsfw(sideB.client, b).catch(() => false),
  ]);
  if (aNsfw !== bNsfw) {
    return {
      success: false,
      errorType: "NSFW_CHANNEL_BRIDGING_TO_NON_NSFW",
    };
  }

  const samePlatform = sideA.platform === sideB.platform;
  const bridgeType = samePlatform
    ? "both"
    : direction === "d2f"
      ? "discord2fluxer"
      : direction === "f2d"
        ? "fluxer2discord"
        : "both";

  const { endpoints } = await setupBridgePair(bridgeType, sideA, sideB, discordClient);

  for (const endpoint of endpoints) {
    try {
      const sourceSide = endpoint.channelId === a.id ? sideA : endpoint.channelId === b.id ? sideB : null;
      if (!sourceSide) continue;
      await mirrorTopicFromEndpoint(endpoint, sourceSide.channel.topic ?? null, discordClient);
    } catch {}
  }

  if (aVoice && bVoice && !samePlatform) {
    const discordEndpoint = endpoints.find(e => e.platform === "discord");
    const fluxerEndpoints = endpoints.filter(e => e.platform === "fluxer");
    if (discordEndpoint) {
      for (const fluxerEndpoint of fluxerEndpoints) {
        await VoiceChannelMap.destroy({
          where: {
            discordChannelId: discordEndpoint.channelId,
            fluxerChannelId: fluxerEndpoint.channelId,
          },
        });
        await VoiceChannelMap.create({
          discordGuildId: discordEndpoint.guildId,
          discordChannelId: discordEndpoint.channelId,
          fluxerGuildId: fluxerEndpoint.guildId,
          fluxerChannelId: fluxerEndpoint.channelId,
          fluxerInstanceId: fluxerEndpoint.instanceId,
        });
      }
    }
  }

  const voiceText =
    aVoice || bVoice ? "voice" : isDiscordAnnouncementChannel(a) || isDiscordAnnouncementChannel(b) ? "announcement" : "text";
  const voiceAudioUnsupported = aVoice && samePlatform && sideA.platform === "discord";

  if (!silent) {
    const notify = async (side, otherPlatform) => {
      if (typeof side.channel.send !== "function") return;
      const other = otherPlatform === "fluxer" ? "Fluxer" : "Discord";
      const audioNote = voiceAudioUnsupported
        ? " (voice audio isn't supported for Discord-to-Discord yet; text chat is bridged)"
        : "";
      const voiceNote =
        aVoice || bVoice
          ? "\n\nSeeing any VC bridge issues like glitchy sound, bot drops connection often, it disconnects and reconnects too much, or it doesn't connect at all? Please report it on Troubleshooting and Support forum in <https://fluxer.gg/jbcrn>."
          : "";
      await side.channel
        .send({ content: `🎉 This ${voiceText} channel is now bridged to ${other}!${audioNote}${voiceNote}` })
        .catch(() => {});
    };
    await notify(sideA, sideB.platform);
    await notify(sideB, sideA.platform);
  }

  return {
    success: true,
    voiceUnsupported: voiceAudioUnsupported,
  };
}

const command = {
  groupNames: ["bridge", "b"],
  name: "setup-all",
  aliases: ["setupall"],
  topLevelAliases: ["setupall", "setup-all"],
  description: "Set up bridging for all channels",
  requireElevated: true,
  params: "[(code)|both|discord2fluxer|fluxer2discord|d2f|f2d=both] [silent]",
  slashOptions: [
    { name: "code_or_direction", type: "string" },
    { name: "silent", type: "boolean", flag: "silent" },
  ],
  additionalInfo: `(code) - the code of the setup to send to the other side
both|discord2fluxer|fluxer2discord|d2f|f2d - the direction of the bridge, defaults to both
silent - skip the "this channel is now bridged" messages on both sides`,
  async run(params, message, discordClient, fluxerClient) {
    let isFluxer = message instanceof FluxerMessage;
    const silentRequested = hasSilentFlag(params);
    const directionOrCode = stripSilentFlag(params)[0] ?? "both";

    const botPerms = checkBotPermissions(message.guild.members.me, message.channel);

    if (!botPerms.hasAllCritical) {
      await message.reply(
        `Fluxcord doesn't have these critical permissions on this server or channel: ${[...botPerms.missingCritical, ...botPerms.missingGuildCritical].join(", ")}\nPlease add those permissions to the bot first before using this command.`
      );
      return;
    }

    const optionalWarning =
      botPerms.missingOptional.length > 0
        ? isFluxer
          ? `\n\n> [!WARNING] The bot is missing these optional permissions here: ${botPerms.missingOptional.join(", ")}. Some things might not bridge properly.`
          : `\n\n> ⚠️ **Warning**\n> The bot is missing these optional permissions here: ${botPerms.missingOptional.join(", ")}. Some things might not bridge properly.`
        : "";

    if (directionOrCode.length !== 6) {
      const code = RandomString(6);

      PendingSetup.set(code, {
        guildId: message.guildId,
        channelId: message.channelId,
        isFluxer,
        instanceId: isFluxer ? (instanceIdOfClient(fluxerClient) ?? "default") : "default",
        silent: silentRequested,
        direction: directionOrCode.startsWith("f") ? "f2d" : directionOrCode.startsWith("d") ? "d2f" : "both",
      });

      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Bridge all channels")
            .setDescription(
              `# \`${Config.BotPrefix}bridge setup-all ${code}\`
Execute that to the other side to continue setting up bridging for all channels! Code will expire after 5 minutes.

Bot isn't there? Run \`${Config.BotPrefix}invitebot\` to get invite links.${optionalWarning}`
            )
            .setFooter(
              embedFooterForMessage(message)
                ? {
                    text: embedFooterForMessage(message),
                  }
                : null
            ),
        ],
      });
    } else {
      if (!PendingSetup.has(directionOrCode)) {
        await message.reply(
          `Code can't be found or is expired already. Run \`${Config.BotPrefix}bridge setup-all\` again on the other side.`
        );
        return;
      }

      const setup = PendingSetup.get(directionOrCode);

      if (!setup) {
        await message.reply(
          `Code can't be found or is expired already. Run \`${Config.BotPrefix}bridge setup-all\` again on the other side.`
        );
        return;
      }

      if (!isFluxer && !message.guildId) {
        await message.reply("This command can only be used in a server.");
        PendingSetup.delete(directionOrCode);
        return;
      }

      const currentPlatform = isFluxer ? "fluxer" : "discord";
      const currentInstanceId = isFluxer ? (instanceIdOfClient(fluxerClient) ?? "default") : "default";
      const sourcePlatform = setup.isFluxer ? "fluxer" : "discord";
      const sourceInstanceId = setup.instanceId ?? "default";

      if (sourcePlatform === currentPlatform && sourceInstanceId === currentInstanceId && setup.guildId === message.guildId) {
        await message.reply(`You can't bridge a ${isFluxer ? "community" : "server"} to itself.`);
        PendingSetup.delete(directionOrCode);
        return;
      }

      const otherClient = setup.isFluxer ? resolveFluxerClient(sourceInstanceId) : discordClient;
      const otherSideName = setup.isFluxer ? "Fluxer community" : "Discord server";

      const msg = await message.reply("Getting all channels and trying to bridge them...");

      let currentSide;
      let otherSide;
      try {
        currentSide = await fetchGuildSide(
          currentPlatform,
          currentInstanceId,
          isFluxer ? fluxerClient : discordClient,
          message.guildId
        );
        otherSide = await fetchGuildSide(sourcePlatform, sourceInstanceId, otherClient, setup.guildId);
      } catch (e) {
        await message.reply(
          `Couldn't fetch the ${otherSideName} for this code (${
            e?.status ?? e?.message ?? "unknown error"
          }). Maybe invite the bot there?`
        );
        PendingSetup.delete(directionOrCode);
        return;
      }

      const discordSide = [currentSide, otherSide].find(side => side.platform === "discord") ?? null;
      const iterateSide = discordSide ?? currentSide;
      const targetSide = iterateSide === currentSide ? otherSide : currentSide;

      const usedTargets = new Set();
      const results = [];

      for (const channel of iterateSide.channels) {
        if (!isBridgeableChannel(channel, iterateSide.platform)) continue;
        const matchedChannel = findMatchingChannel(targetSide.channels, channel, targetSide.platform);
        if (!matchedChannel) continue;

        const targetKey = `${targetSide.platform}:${matchedChannel.id}`;
        if (usedTargets.has(targetKey)) continue;
        usedTargets.add(targetKey);

        try {
          const result = await bridgeChannel(
            { ...iterateSide, channel },
            { ...targetSide, channel: matchedChannel },
            {
              direction: setup.direction,
              silent: setup.silent || silentRequested,
              discordClient,
            }
          );
          results.push(result);
        } catch (e) {
          console.error(e);
          results.push({
            success: false,
            errorType: "UNHANDLED_EXCEPTION",
          });
        }

        if (results.length % 5 === 0) {
          try {
            await msg.edit({
              content: `Trying to bridge #${channel.name} (${iterateSide.platform}) to #${matchedChannel.name} (${targetSide.platform})...
  Success: ${results.filter(x => x?.success).length}, Failed: ${results.filter(x => !x?.success).length}`,
            });
          } catch {}
        }
      }

      const successCount = results.filter(x => x?.success).length;
      const voiceUnsupportedCount = results.filter(x => x?.voiceUnsupported).length;
      const voiceNote =
        voiceUnsupportedCount > 0
          ? `\n\n> ${voiceUnsupportedCount} voice channel${voiceUnsupportedCount === 1 ? "" : "s"} had their text chat bridged, but Discord-to-Discord voice audio isn't supported yet.`
          : "";

      await msg.edit({
        content: `🎉 Successfully bridged ${successCount} channels to ${
          targetSide.platform === "fluxer" ? "Fluxer" : "Discord"
        }!${voiceNote}${optionalWarning}`,
      });

      await changeBotBio(currentSide.guild);
      await changeBotBio(otherSide.guild);

      PendingSetup.delete(directionOrCode);
    }
  },
};

export default command;
