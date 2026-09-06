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

function normalizeChannelName(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function findMatchingChannel(fluxerChannels, discordChannel) {
  const channelName = normalizeChannelName(discordChannel.name);
  const isVoice = discordChannel.type === ChannelType.GuildVoice;

  const sameType = fluxerChannels.filter(
    (x) => (x.type === ChannelType.GuildVoice) === isVoice,
  );

  const exact = sameType.find(
    (x) => normalizeChannelName(x.name) === channelName,
  );
  if (exact) return exact;

  const fuzzyMatches = sameType.filter((x) =>
    normalizeChannelName(x.name).endsWith(channelName),
  );

  return fuzzyMatches[0] ?? null;
}

const command = {
  name: "setupall",
  description: "Set up bridging for all channels",
  requireElevated: true,
  params: "[(code)|both|discord2fluxer|fluxer2discord|d2f|f2d=both]",
  additionalInfo: `(code) - the code of the setup to send to the other side
both|discord2fluxer|fluxer2discord|d2f|f2d - the direction of the bridge, defaults to both`,
  async run(params, message, discordClient, fluxerClient) {
    let isFluxer = message instanceof FluxerMessage;
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

      const msg = await message.reply(
        "Getting all channels and trying to bridge them...",
      );

      let discordChannels;
      let fluxerChannels;
      let discordGuild;
      let fluxerGuild;

      if (isFluxer) {
        try {
          discordGuild = await discordClient.guilds.fetch(setup.guildId);
          fluxerGuild = await fluxerClient.guilds.fetch(message.guildId);
        } catch {
          await message.reply("Guild not found. Maybe invite the bot?");
          PendingSetup.delete(directionOrCode);
          return;
        }
        discordChannels = discordGuild.channels.cache;
        fluxerChannels = await fluxerGuild.fetchChannels();
      } else {
        if (!message.guildId) {
          await message.reply("This command can only be used in a server.");
          PendingSetup.delete(directionOrCode);
          return;
        }
        try {
          discordGuild = await discordClient.guilds.fetch(message.guildId);
          fluxerGuild = await fluxerClient.guilds.fetch(setup.guildId);
        } catch {
          await message.reply("Guild not found. Maybe invite the bot?");
          PendingSetup.delete(directionOrCode);
          return;
        }
        discordChannels = discordGuild.channels.cache;
        fluxerChannels = await fluxerGuild.fetchChannels();
      }

      const results = [];

      for (let channel of discordChannels) {
        const matchedChannel = findMatchingChannel(fluxerChannels, channel[1]);

        if (matchedChannel) {
          try {
            msg.edit({
              content: `Trying to bridge <#${isFluxer ? matchedChannel.id : channel[1].name}> to #${isFluxer ? channel[1].name : matchedChannel.name}...
  Success: ${results.filter((x) => x?.success).length}, Failed: ${results.filter((x) => !x?.success).length}`,
            });
          } catch {}
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

      await changeBotBio(discordGuild);
      await changeBotBio(fluxerGuild);

      PendingSetup.delete(directionOrCode);
    }
  },
};

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

  const isFluxerVoice = fluxerChannel.type == ChannelType.GuildVoice;
  const isDiscordVoice = discordChannel.type == ChannelType.GuildVoice;
  if (isFluxerVoice !== isDiscordVoice) {
    return {
      success: false,
      errorType: "CHANNEL_NOT_SAME_TYPE",
    };
  }

  const voiceText = isFluxerVoice && isDiscordVoice ? "voice" : "text";

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

  if (isFluxerVoice && isDiscordVoice) {
    await VoiceChannelMap.create({
      discordGuildId,
      discordChannelId,
      fluxerGuildId,
      fluxerChannelId,
    });
  }

  await discordChannel.send({
    content: "🎉 This " + voiceText + " channel is now bridged to Fluxer!",
  });

  await fluxerChannel.send({
    content: "🎉 This " + voiceText + " channel is now bridged to Discord!",
  });

  return {
    success: true,
  };
}

export default command;
