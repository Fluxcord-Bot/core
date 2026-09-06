import {
  EmbedBuilder,
  Message as FluxerMessage,
  GuildChannel as FluxerGuildChannel,
} from "@fluxerjs/core";
import RandomString from "../utils/RandomString.js";
import { PendingSetup } from "../utils/CommandHandler.js";
import Config from "../utils/ConfigHandler.js";
import { genAuthLink } from "../utils/GenAuthLink.js";
import { ChannelMap, GuildMap, VoiceChannelMap } from "../db/index.js";
import { Op } from "sequelize";
import { ChannelType, GuildChannel as DiscordGuildChannel } from "discord.js";
import changeBotBio from "../utils/ChangeBotBio.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "setup",
  description: "Set up bridging",
  requireElevated: true,
  params: "[(code)|both|discord2fluxer|fluxer2discord|d2f|f2d=both]",
  additionalInfo: `(code) - the code of the setup to send to the other side
both|discord2fluxer|fluxer2discord|d2f|f2d - the direction of the bridge, defaults to both`,
  async run(params, message, discordClient, fluxerClient) {
    let isFluxer = message instanceof FluxerMessage;
    /**
     * @type {string & {length: 6} | "both" | "discord2fluxer" | "fluxer2discord" | "d2f" | "f2d" | "template"}
     */
    const directionOrCode = params[0] ?? "both";

    if (directionOrCode.length !== 6) {
      const channelMap = await ChannelMap.findOne({
        where: {
          [Op.or]: {
            discordChannelId: message.channelId,
            fluxerChannelId: message.channelId,
          },
        },
      });

      if (channelMap) {
        await message.reply(
          "This channel is already bridged. Run `" +
            Config.BotPrefix +
            "unbridge` to unbridge, then run setup again.",
        );
        return;
      }

      const code = RandomString(6);

      let isVoice = message.channel?.type == ChannelType.GuildVoice;

      PendingSetup.set(code, {
        guildId: message.guildId,
        channelId: message.channelId,
        isVoice,
        isFluxer,
        direction: directionOrCode.startsWith("f")
          ? "f2d"
          : directionOrCode.startsWith("d")
            ? "d2f"
            : "both",
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
              `# \`${Config.BotPrefix}setup ${code}\`
Execute that to the other side to continue setting up bridging! Code will expire after 5 minutes.${vcBridgeWarning}

${isFluxer ? "Discord" : "Fluxer"} bot isn't there? [Invite the bot](${await genAuthLink(message.client.user.id, !isFluxer)})!`,
            )
            .setFooter(
              Config.EmbedFooterContent
                ? {
                    text: Config.EmbedFooterContent,
                  }
                : null,
            ),
        ],
      });
    } else {
      if (!PendingSetup.has(directionOrCode)) {
        await message.reply(
          `Code can't be found or is expired already. Run \`${Config.BotPrefix}setup\` again on the other side.`,
        );
        return;
      }

      const setup = PendingSetup.get(directionOrCode);

      if (!setup) {
        await message.reply(
          `Code can't be found or is expired already. Run \`${Config.BotPrefix}setup\` again on the other side.`,
        );
        return;
      }

      if (setup.isFluxer === isFluxer) {
        await message.reply(
          `We don't support Fluxer <-> Fluxer or Discord <-> Discord currently.`,
        );
        PendingSetup.delete(directionOrCode);
        return;
      }

      let isVoice = message.channel?.type == ChannelType.GuildVoice;
      const voiceText = isVoice ? "voice" : "text";

      if (setup.isVoice !== isVoice) {
        await message.reply(
          `You can only bridge ${voiceText} channels to ${voiceText} channels on the other side.`,
        );
        PendingSetup.delete(directionOrCode);
        return;
      }

      const channelMap = await ChannelMap.findOne({
        where: {
          [Op.or]: {
            discordChannelId: message.channelId,
            fluxerChannelId: message.channelId,
          },
        },
      });

      if (channelMap) {
        await message.reply(
          "This channel is already bridged. Run `" +
            Config.BotPrefix +
            "unbridge` to unbridge, then run this command again.",
        );
        return;
      }

      let channel;
      let currentChannel;
      try {
        channel = await (isFluxer ? discordClient : fluxerClient).channels.fetch(
          setup.channelId,
        );
        currentChannel = await message.client.channels.fetch(message.channelId);
      } catch {
        await message.reply("Channel not found. Maybe invite the bot?");
        PendingSetup.delete(directionOrCode);
        return;
      }

      if (
        (currentChannel.nsfw && !channel.nsfw) ||
        (!currentChannel.nsfw && channel.nsfw)
      ) {
        await message.reply(
          "Both channels needs to be set as NSFW to bridge them.",
        );
        return;
      }

      let fluxerWebhookId = "";
      let fluxerWebhookToken = "";
      let fluxerChannelId = "";
      let fluxerGuildId = "";
      let discordWebhookId = "";
      let discordWebhookToken = "";
      let discordChannelId = "";
      let discordGuildId = "";

      if (
        currentChannel instanceof FluxerGuildChannel &&
        setup.direction !== "f2d"
      ) {
        const webhook = await currentChannel.createWebhook({
          name: `Fluxcord Bridge (${currentChannel.id} (F) ${setup.direction === "both" ? "<->" : "<--"} ${channel.id} (D))`,
        });
        fluxerWebhookToken = webhook.token ?? "";
        fluxerWebhookId = webhook.id;
        fluxerChannelId = currentChannel.id;
        fluxerGuildId = currentChannel.guildId;
      } else if (setup.direction !== "d2f") {
        const webhook = await currentChannel.createWebhook({
          name: `Fluxcord Bridge (${currentChannel.id} (D) ${setup.direction === "both" ? "<->" : "<--"} ${channel.id} (F))`,
        });
        discordWebhookToken = webhook.token;
        discordWebhookId = webhook.id;
        discordChannelId = currentChannel.id;
        discordGuildId = currentChannel.guildId;
      }

      if (channel instanceof FluxerGuildChannel && setup.direction !== "f2d") {
        const webhook = await channel.createWebhook({
          name: `Fluxcord Bridge (${channel.id} (F) ${setup.direction === "both" ? "<->" : "<--"} ${currentChannel.id} (D))`,
        });
        fluxerWebhookToken = webhook.token ?? "";
        fluxerWebhookId = webhook.id;
        fluxerChannelId = channel.id;
        fluxerGuildId = channel.guildId;
      } else if (
        channel instanceof DiscordGuildChannel &&
        setup.direction !== "d2f"
      ) {
        const webhook = await channel.createWebhook({
          name: `Fluxcord Bridge (${channel.id} (D) ${setup.direction === "both" ? "<->" : "<--"} ${currentChannel.id} (F))`,
        });
        discordWebhookToken = webhook.token;
        discordWebhookId = webhook.id;
        discordChannelId = channel.id;
        discordGuildId = channel.guildId;
      }

      const fluxerGuildMap = await GuildMap.findOrCreate({
        where: {
          guildId: fluxerGuildId,
          guildType: "fluxer",
        },
      });
      const discordGuildMap = await GuildMap.findOrCreate({
        where: {
          guildId: discordGuildId,
          guildType: "discord",
        },
      });

      await ChannelMap.create({
        fluxerChannelId,
        discordChannelId,
        fluxerGuildId,
        discordGuildId,
        fluxerWebhookId,
        discordWebhookId,
        fluxerWebhookToken,
        discordWebhookToken,
        fluxerGuildMapId: fluxerGuildMap[0].id,
        discordGuildMapId: discordGuildMap[0].id,
        bridgeType:
          setup.direction === "d2f"
            ? "discord2fluxer"
            : setup.direction === "f2d"
              ? "fluxer2discord"
              : "both",
      });

      if (isVoice && setup.isVoice) {
        await VoiceChannelMap.create({
          discordGuildId,
          discordChannelId,
          fluxerGuildId,
          fluxerChannelId,
        });
      }

      PendingSetup.delete(directionOrCode);

      await channel.send({
        content:
          "🎉 This " +
          voiceText +
          " channel is now bridged to " +
          (isFluxer ? "Fluxer" : "Discord") +
          "!",
      });

      await message.reply({
        content:
          "🎉 This " +
          voiceText +
          " channel is now bridged to " +
          (!isFluxer ? "Fluxer" : "Discord") +
          "!",
      });

      await changeBotBio(channel.guild);
      if (message.guild) await changeBotBio(message.guild);
    }
  },
};

export default command;
