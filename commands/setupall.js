import {
  EmbedBuilder,
  Message as FluxerMessage,
  GuildChannel as FluxerGuildChannel,
} from "@fluxerjs/core";
import RandomString from "../utils/RandomString.js";
import { PendingSetup } from "../utils/CommandHandler.js";
import Config from "../utils/ConfigHandler.js";
import { genAuthLink } from "../utils/GenAuthLink.js";
import { ChannelMap, GuildMap } from "../db/index.js";
import { Op } from "sequelize";
import { GuildChannel as DiscordGuildChannel } from "discord.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "setupall",
  description: "Set up bridging for all channels",
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
      const code = RandomString(6);

      PendingSetup.set(code, {
        guildId: message.guildId,
        channelId: message.channelId,
        isFluxer,
        direction: directionOrCode.startsWith("f")
          ? "f2d"
          : directionOrCode.startsWith("d")
            ? "d2f"
            : "both",
      });

      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Bridge all channels")
            .setDescription(
              `# \`${Config.BotPrefix}setupall ${code}\`
Execute that to the other side to continue setting up bridging for all channels! Code will expire after 5 minutes.

${isFluxer ? "Discord" : "Fluxer"} bot isn't there? [Invite the bot](${genAuthLink(message.client.user.id, !isFluxer)})!`,
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

      const msg = await message.reply(
        "Getting all channels and trying to bridge them...",
      );

      /**
       * @type {import("discord.js").Collection<string, import("discord.js").GuildBasedChannel>}
       */
      let discordChannels;
      /**
       * @type {import("@fluxerjs/core").GuildChannel[]}
       */
      let fluxerChannels;

      if (isFluxer) {
        const discordGuild = await discordClient.guilds.fetch(setup.guildId);
        discordChannels = discordGuild.channels.cache;
        const fluxerGuild = await fluxerClient.guilds.fetch(message.guildId);
        fluxerChannels = await fluxerGuild.fetchChannels();
      } else {
        const discordGuild = await discordClient.guilds.fetch(message.guild.id);
        discordChannels = discordGuild.channels.cache;
        const fluxerGuild = await fluxerClient.guilds.fetch(setup.guildId);
        fluxerChannels = await fluxerGuild.fetchChannels();
      }

      const results = [];

      for (let channel of discordChannels) {
        const channelName = channel[1].name.toLowerCase();

        const matchedChannel = fluxerChannels.find((x) =>
          x.name.toLowerCase().endsWith(channelName),
        );

        if (matchedChannel) {
          msg.edit({
            content: `Trying to bridge <#${isFluxer ? matchedChannel.id : channel[1].name}> to #${isFluxer ? channel[1].name : matchedChannel.name}...
Success: ${results.filter((x) => x?.success).length}, Failed: ${results.filter((x) => !x?.success).length}`,
          });
          try {
            const result = await bridgeChannel(
              matchedChannel,
              channel[1],
              setup,
            );
            results.push(result);
          } catch (e) {
            console.error(e);
            results.push({
              success: false,
              errorType: "UNHANDLED_EXCEPTION",
            });
          }
        }
      }

      msg.edit({
        content: `🎉 Successfully bridged ${results.filter((x) => x?.success).length} channels to ${!isFluxer ? "Fluxer" : "Discord"}!`,
      });

      PendingSetup.delete(directionOrCode);
    }
  },
};

/**
 * @param {import("@fluxerjs/core").GuildChannel} fluxerChannel
 * @param {import("discord.js").GuildBasedChannel} discordChannel
 */
async function bridgeChannel(fluxerChannel, discordChannel, setup) {
  const channelMap = await ChannelMap.findOne({
    where: {
      [Op.or]: {
        discordChannelId: discordChannel.id,
        fluxerChannelId: fluxerChannel.id,
      },
    },
  });

  if (channelMap) {
    return {
      success: false,
      errorType: "CHANNEL_ALREADY_BRIDGED",
    };
  }

  if (
    (discordChannel.nsfw && !fluxerChannel.nsfw) ||
    (!discordChannel.nsfw && fluxerChannel.nsfw)
  ) {
    return {
      success: false,
      errorType: "NSFW_CHANNEL_BRIDGING_TO_NON_NSFW",
    };
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
    fluxerChannel instanceof FluxerGuildChannel &&
    setup.direction !== "f2d"
  ) {
    const webhook = await fluxerChannel.createWebhook({
      name: `Fluxcord Bridge (${fluxerChannel.id} (F) ${setup.direction === "both" ? "<->" : "<--"} ${discordChannel.id} (D))`,
    });
    fluxerWebhookToken = webhook.token ?? "";
    fluxerWebhookId = webhook.id;
    fluxerChannelId = fluxerChannel.id;
    fluxerGuildId = fluxerChannel.guildId;
  }

  if (
    discordChannel instanceof DiscordGuildChannel &&
    setup.direction !== "d2f"
  ) {
    const webhook = await discordChannel.createWebhook({
      name: `Fluxcord Bridge (${discordChannel.id} (D) ${setup.direction === "both" ? "<->" : "<--"} ${fluxerChannel.id} (F))`,
    });
    discordWebhookToken = webhook.token;
    discordWebhookId = webhook.id;
    discordChannelId = discordChannel.id;
    discordGuildId = discordChannel.guildId;
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

  await discordChannel.send({
    content: "🎉 This channel is now bridged to Fluxer!",
  });

  await fluxerChannel.send({
    content: "🎉 This channel is now bridged to Discord!",
  });

  return {
    success: true,
  };
}

export default command;
