import { EmbedBuilder, Message as FluxerMessage } from "@fluxerjs/core";
import RandomString from "../../utils/RandomString.js";
import { PendingSetup } from "../../utils/CommandHandler.js";
import Config from "../../utils/ConfigHandler.js";
import { genAuthLink } from "../../utils/GenAuthLink.js";
import { VoiceChannelMap } from "../../db/index.js";
import { Op } from "sequelize";
import changeBotBio from "../../utils/ChangeBotBio.js";
import { checkBotPermissions } from "../../utils/CheckBotPerms.js";
import { isAnnouncementPairAllowed, isVoiceChannel, resolveChannelVoiceText } from "../../utils/AnnouncementPublish.js";
import { hasSilentFlag, stripSilentFlag } from "../../utils/SilentFlag.js";
import { resolveChannelNsfw } from "../../utils/ChannelNsfw.js";
import { setupBridgePair } from "../../utils/SetupHelper.js";
import { mirrorTopicFromEndpoint } from "../../utils/TopicMirror.js";
import { instanceIdOfClient, resolveFluxerClient } from "../../utils/FluxerClients.js";
import { embedFooterForMessage } from "../../utils/PerInstance.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["bridge", "b"],
  name: "setup",
  topLevelAliases: ["setup"],
  description: "Set up bridging",
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

      let isVoice = isVoiceChannel(message.channel);

      PendingSetup.set(code, {
        guildId: message.guildId,
        channelId: message.channelId,
        isVoice,
        isFluxer,
        instanceId: isFluxer ? (instanceIdOfClient(fluxerClient) ?? "default") : "default",
        silent: silentRequested,
        direction: directionOrCode.startsWith("f") ? "f2d" : directionOrCode.startsWith("d") ? "d2f" : "both",
      });

      let vcBridgeWarning = isVoice
        ? "heck <https://fluxcord.jbcrn.dev/vc-bridging/> for disclaimers of Fluxcord's Voice Bridging."
        : "";
      if (!!directionOrCode && directionOrCode != "both" && isVoice) {
        if (isFluxer) {
          vcBridgeWarning =
            "\n\n> [!NOTE] `" +
            directionOrCode +
            "` only affects the **voice channel chat**, not the actual voice channel itself.\n> Also c" +
            vcBridgeWarning;
        } else {
          vcBridgeWarning =
            "\n\n> 📝 **Note**\n> `" +
            directionOrCode +
            "` only affects the **voice channel chat**, not the actual voice channel itself.\n> Also c" +
            vcBridgeWarning;
        }
      } else if (isVoice) {
        if (isFluxer) {
          vcBridgeWarning = "\n\n> [!NOTE] C" + vcBridgeWarning;
        } else {
          vcBridgeWarning = "\n\n> 📝 **Note**\n> C" + vcBridgeWarning;
        }
      }

      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Set up Fluxcord")
            .setDescription(
              `# \`${Config.BotPrefix}bridge setup ${code}\`
Execute that to the other side to continue setting up bridging! Code will expire after 5 minutes.${vcBridgeWarning}${optionalWarning}

${isFluxer ? "Discord" : "Fluxer"} bot isn't there? [Invite the bot](${await genAuthLink(message.client.user.id, !isFluxer)})!`
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
          `Code can't be found or is expired already. Run \`${Config.BotPrefix}bridge setup\` again on the other side.`
        );
        return;
      }

      const setup = PendingSetup.get(directionOrCode);
      const sourceIsFluxer = setup.isFluxer ?? !isFluxer;
      const sourceInstanceId = setup.instanceId ?? "default";
      const otherClient = sourceIsFluxer ? resolveFluxerClient(sourceInstanceId) : discordClient;

      if (!setup) {
        await message.reply(
          `Code can't be found or is expired already. Run \`${Config.BotPrefix}bridge setup\` again on the other side.`
        );
        return;
      }

      let isVoice = isVoiceChannel(message.channel);
      let voiceText = isVoice ? "voice" : "text";

      if (setup.isVoice !== isVoice) {
        await message.reply(`You can only bridge ${voiceText} channels to ${voiceText} channels on the other side.`);
        PendingSetup.delete(directionOrCode);
        return;
      }

      let channel;
      let currentChannel;
      try {
        channel = await otherClient.channels.fetch(setup.channelId);
        currentChannel = await message.client.channels.fetch(message.channelId);
      } catch {
        await message.reply("Channel not found. Maybe invite the bot?");
        PendingSetup.delete(directionOrCode);
        return;
      }

      const discordSideChannel = isFluxer ? channel : currentChannel;
      const fluxerSideChannel = isFluxer ? currentChannel : channel;
      voiceText = resolveChannelVoiceText(discordSideChannel, fluxerSideChannel);

      if (!isAnnouncementPairAllowed(discordSideChannel, fluxerSideChannel)) {
        await message.reply(`You can only bridge voice channels to voice channels on the other side.`);
        PendingSetup.delete(directionOrCode);
        return;
      }

      const bridgesAnnouncement =
        (typeof discordSideChannel.isAnnouncement === "function" && discordSideChannel.isAnnouncement()) ||
        (typeof fluxerSideChannel.isAnnouncement === "function" && fluxerSideChannel.isAnnouncement());
      const announcementNote = bridgesAnnouncement
        ? `\n\nBridged announcement messages are auto published. Toggle with \`${Config.BotPrefix}guild autopublish on|off\`.`
        : "";

      const [currentNsfw, channelNsfw] = await Promise.all([
        resolveChannelNsfw(isFluxer ? fluxerClient : discordClient, currentChannel),
        resolveChannelNsfw(otherClient, channel),
      ]);
      if ((currentNsfw && !channelNsfw) || (!currentNsfw && channelNsfw)) {
        await message.reply("Both channels needs to be set as NSFW to bridge them.");
        return;
      }

      const bridgeType = setup.direction === "d2f" ? "discord2fluxer" : setup.direction === "f2d" ? "fluxer2discord" : "both";

      const currentIsFluxer = isFluxer;
      const { endpoints, merged } = await setupBridgePair(
        bridgeType,
        {
          platform: currentIsFluxer ? "fluxer" : "discord",
          instanceId: currentIsFluxer ? (instanceIdOfClient(fluxerClient) ?? "default") : "default",
          channel: currentChannel,
        },
        {
          platform: sourceIsFluxer ? "fluxer" : "discord",
          instanceId: sourceIsFluxer ? sourceInstanceId : "default",
          channel,
        },
        discordClient
      );
      const mergedNote =
        merged > 0 ? `\n\nFolded into an existing fanout bridge (merged ${merged} group${merged === 1 ? "" : "s"}).` : "";

      for (const endpoint of endpoints) {
        try {
          const sourceChannel =
            endpoint.channelId === currentChannel.id ? currentChannel : endpoint.channelId === channel.id ? channel : null;
          if (!sourceChannel) continue;
          await mirrorTopicFromEndpoint(endpoint, sourceChannel.topic ?? null, discordClient);
        } catch {}
      }

      const platformsDiffer = (sourceIsFluxer ? "fluxer" : "discord") !== (currentIsFluxer ? "fluxer" : "discord");
      if (isVoice && setup.isVoice && platformsDiffer) {
        const discordEndpoint = endpoints.find(e => e.platform === "discord");
        const fluxerEndpoint = endpoints.find(e => e.platform === "fluxer");
        if (discordEndpoint && fluxerEndpoint) {
          await VoiceChannelMap.destroy({
            where: {
              [Op.or]: [{ discordChannelId: discordEndpoint.channelId }, { fluxerChannelId: fluxerEndpoint.channelId }],
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

      PendingSetup.delete(directionOrCode);

      const silent = setup.silent || silentRequested;

      let remoteOptionalWarning = "";
      try {
        const remoteMember = await (await otherClient.guilds.fetch(channel.guildId)).members.fetchMe();
        const remotePerms = checkBotPermissions(remoteMember, channel);
        if (remotePerms.missingOptional.length > 0) {
          remoteOptionalWarning = isFluxer
            ? `\n\n> ⚠️ **Warning**\n> The bot is missing these optional permissions here: ${remotePerms.missingOptional.join(", ")}. Some things might not bridge properly.`
            : `\n\n> [!WARNING] The bot is missing these optional permissions here: ${remotePerms.missingOptional.join(", ")}. Some things might not bridge properly.`;
        }
      } catch {}

      if (!silent) {
        await channel.send({
          content: "🎉 This " + voiceText + " channel is now bridged!" + remoteOptionalWarning + announcementNote + mergedNote,
        });

        await message.reply({
          content: "🎉 This " + voiceText + " channel is now bridged!" + optionalWarning + announcementNote + mergedNote,
        });
      }

      await changeBotBio(channel.guild);
      if (message.guild) await changeBotBio(message.guild);
    }
  },
};

export default command;
