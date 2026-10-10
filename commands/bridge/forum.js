import { EmbedBuilder, Message as FluxerMessage } from "@fluxerjs/core";
import RandomString from "../../utils/RandomString.js";
import { PendingSetup } from "../../utils/CommandHandler.js";
import Config from "../../utils/ConfigHandler.js";
import { genAuthLink } from "../../utils/GenAuthLink.js";
import { ChannelMap, GuildMap, MessageMap } from "../../db/index.js";
import { syncForumTags } from "../../utils/ThreadMirror.js";
import { Op } from "sequelize";
import { ChannelType } from "discord.js";
import changeBotBio from "../../utils/ChangeBotBio.js";
import { checkBotPermissions } from "../../utils/CheckBotPerms.js";
import { log } from "../../utils/Logger.js";
import { hasSilentFlag, stripSilentFlag } from "../../utils/SilentFlag.js";

function isDiscordForumLike(channel) {
  return channel?.type === ChannelType.GuildForum || channel?.type === ChannelType.GuildMedia;
}

function isFluxerForumLike(channel) {
  if (!channel) return false;
  if (typeof channel.isForum === "function" && channel.isForum()) return true;
  return typeof channel.isMedia === "function" && channel.isMedia();
}

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["bridge", "b"],
  name: "forum",
  description: "Set up bridging for a forum channel (run inside a forum post)",
  requireElevated: true,
  params: "[(code)] [silent]",
  slashOptions: [
    { name: "code", type: "string" },
    { name: "silent", type: "boolean", flag: "silent" },
  ],
  additionalInfo: `(code) - the code of the setup to send to the other side
silent - skip the "this forum is now bridged" messages on both sides`,
  async run(params, message, discordClient, fluxerClient) {
    let isFluxer = message instanceof FluxerMessage;
    const silentRequested = hasSilentFlag(params);
    const directionOrCode = stripSilentFlag(params)[0];

    const parentId = message.channel?.parentId;
    if (!parentId) {
      await message.reply("Run this inside a forum post, so Fluxcord can find the forum channel.");
      return;
    }

    let forum;
    try {
      forum = await (isFluxer ? fluxerClient : discordClient).channels.fetch(parentId);
    } catch {
      await message.reply("Couldn't fetch the forum channel this post belongs to.");
      return;
    }

    const forumOk = isFluxer ? isFluxerForumLike(forum) : isDiscordForumLike(forum);
    if (!forumOk) {
      await message.reply("Run this inside a forum post, so Fluxcord can find the forum channel.");
      return;
    }

    const botPerms = checkBotPermissions(message.guild.members.me, message.channel);

    if (!botPerms.hasAllCritical) {
      await message.reply(
        `Fluxcord doesn't have these critical permissions on this server or channel: ${[...botPerms.missingCritical, ...botPerms.missingGuildCritical].join(", ")}\nPlease add those permissions to the bot first before using this command.`
      );
      return;
    }

    if (!directionOrCode || directionOrCode.length !== 6) {
      const existing = await ChannelMap.findOne({
        where: {
          [Op.or]: {
            discordChannelId: forum.id,
            fluxerChannelId: forum.id,
          },
        },
      });

      if (existing) {
        await message.reply(
          "This forum is already bridged. Run `" +
            Config.BotPrefix +
            "bridge remove` inside one of its posts to unbridge it first."
        );
        return;
      }

      const code = RandomString(6);

      PendingSetup.set(code, {
        guildId: message.guildId,
        channelId: forum.id,
        postId: message.channel.id,
        isForum: true,
        isFluxer,
        silent: silentRequested,
        direction: "both",
      });

      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Bridge a forum")
            .setDescription(
              `# \`${Config.BotPrefix}bridge forum ${code}\`
Execute that inside a post on the other side's forum to continue setting up forum bridging! Code will expire after 5 minutes.

${isFluxer ? "Discord" : "Fluxer"} bot isn't there? [Invite the bot](${await genAuthLink(message.client.user.id, !isFluxer)})!`
            )
            .setFooter(
              Config.EmbedFooterContent
                ? {
                    text: Config.EmbedFooterContent,
                  }
                : null
            ),
        ],
      });
    } else {
      if (!PendingSetup.has(directionOrCode)) {
        await message.reply(
          `Code can't be found or is expired already. Run \`${Config.BotPrefix}bridge forum\` again on the other side.`
        );
        return;
      }

      const setup = PendingSetup.get(directionOrCode);

      if (!setup) {
        await message.reply(
          `Code can't be found or is expired already. Run \`${Config.BotPrefix}bridge forum\` again on the other side.`
        );
        return;
      }

      if (setup.isFluxer === isFluxer) {
        await message.reply(`We don't support Fluxer <-> Fluxer or Discord <-> Discord currently.`);
        PendingSetup.delete(directionOrCode);
        return;
      }

      let otherForum;
      try {
        otherForum = await (isFluxer ? discordClient : fluxerClient).channels.fetch(setup.channelId);
      } catch {
        await message.reply("Forum not found. Maybe invite the bot?");
        PendingSetup.delete(directionOrCode);
        return;
      }

      const otherOk = isFluxer ? isDiscordForumLike(otherForum) : isFluxerForumLike(otherForum);
      if (!otherOk) {
        await message.reply("Both sides need to be forum channels to bridge them.");
        PendingSetup.delete(directionOrCode);
        return;
      }

      const existing = await ChannelMap.findOne({
        where: {
          [Op.or]: [
            { discordChannelId: forum.id },
            { fluxerChannelId: forum.id },
            { discordChannelId: otherForum.id },
            { fluxerChannelId: otherForum.id },
          ],
        },
      });

      if (existing) {
        await message.reply("One of these forums is already bridged. Unbridge it first, then run this command again.");
        return;
      }

      if ((forum.nsfw && !otherForum.nsfw) || (!forum.nsfw && otherForum.nsfw)) {
        await message.reply("Both forums needs to be set as NSFW to bridge them.");
        return;
      }

      const discordForum = isFluxer ? otherForum : forum;
      const fluxerForum = isFluxer ? forum : otherForum;

      const discordWebhook = await discordForum.createWebhook({
        name: `Fluxcord Bridge (${discordForum.id} (D) <-> ${fluxerForum.id} (F))`,
      });
      const fluxerWebhook = await fluxerForum.createWebhook({
        name: `Fluxcord Bridge (${fluxerForum.id} (F) <-> ${discordForum.id} (D))`,
      });

      const fluxerGuildMap = await GuildMap.findOrCreate({
        where: {
          guildId: fluxerForum.guildId,
          guildType: "fluxer",
        },
      });
      const discordGuildMap = await GuildMap.findOrCreate({
        where: {
          guildId: discordForum.guildId,
          guildType: "discord",
        },
      });

      const row = await ChannelMap.create({
        discordChannelId: discordForum.id,
        fluxerChannelId: fluxerForum.id,
        discordGuildId: discordForum.guildId,
        fluxerGuildId: fluxerForum.guildId,
        discordWebhookId: discordWebhook.id,
        discordWebhookToken: discordWebhook.token,
        fluxerWebhookId: fluxerWebhook.id,
        fluxerWebhookToken: fluxerWebhook.token ?? "",
        bridgeType: "both",
        fluxerGuildMapId: fluxerGuildMap[0].id,
        discordGuildMapId: discordGuildMap[0].id,
        autoMirrored: false,
      });

      const discordPostId = isFluxer ? setup.postId : message.channelId;
      const fluxerPostId = isFluxer ? message.channelId : setup.postId;
      if (discordPostId && fluxerPostId) {
        const postRow = await ChannelMap.create({
          discordChannelId: discordPostId,
          fluxerChannelId: fluxerPostId,
          discordGuildId: discordForum.guildId,
          fluxerGuildId: fluxerForum.guildId,
          discordWebhookId: discordWebhook.id,
          discordWebhookToken: discordWebhook.token,
          fluxerWebhookId: fluxerWebhook.id,
          fluxerWebhookToken: fluxerWebhook.token ?? "",
          bridgeType: "both",
          fluxerGuildMapId: fluxerGuildMap[0].id,
          discordGuildMapId: discordGuildMap[0].id,
          autoMirrored: true,
          parentChannelMapId: row.id,
        });
        await MessageMap.create({
          messageSource: "discord",
          discordMessageId: discordPostId,
          fluxerMessageId: fluxerPostId,
          channelMapId: postRow.id,
          authorId: "",
        });
      }

      await syncForumTags(discordForum, "discord", discordClient, fluxerClient);
      await syncForumTags(fluxerForum, "fluxer", discordClient, fluxerClient);

      PendingSetup.delete(directionOrCode);

      const silent = setup.silent || silentRequested;

      if (!silent) {
        try {
          await message.reply("🎉 This forum is now bridged!");
        } catch (e) {
          log(
            "FLUXER",
            `Couldn't send the setup reply in the bridged forum post ${message.channelId} (the bot can't send messages in other people's forum posts)`,
            e
          );
        }
      }

      try {
        await changeBotBio(message.guild);
      } catch {}
    }
  },
};

export default command;
