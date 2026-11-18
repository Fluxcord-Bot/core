import { EmbedBuilder, Message as FluxerMessage } from "@fluxerjs/core";
import RandomString from "../../utils/RandomString.js";
import { PendingSetup } from "../../utils/CommandHandler.js";
import Config from "../../utils/ConfigHandler.js";
import { genAuthLink } from "../../utils/GenAuthLink.js";
import { BridgeEndpoint, MessageLink } from "../../db/index.js";
import { syncForumTags } from "../../utils/ThreadMirror.js";
import { Op } from "sequelize";
import { createBridgeGroup } from "../../utils/SetupHelper.js";
import { newLinkGroup } from "../../utils/Bridging.js";
import { instanceIdOfClient, getFluxerClient } from "../../utils/FluxerClients.js";
import { ChannelType } from "discord.js";
import changeBotBio from "../../utils/ChangeBotBio.js";
import { checkBotPermissions } from "../../utils/CheckBotPerms.js";
import { log } from "../../utils/Logger.js";
import { hasSilentFlag, stripSilentFlag } from "../../utils/SilentFlag.js";
import { resolveChannelNsfw } from "../../utils/ChannelNsfw.js";
import { invalidateFluxerWebhookCache } from "../../utils/Webhooks.js";
import { embedFooterForMessage } from "../../utils/PerInstance.js";

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
      const code = RandomString(6);

      PendingSetup.set(code, {
        guildId: message.guildId,
        channelId: forum.id,
        postId: message.channel.id,
        isForum: true,
        isFluxer,
        instanceId: isFluxer ? (instanceIdOfClient(fluxerClient) ?? "default") : "default",
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

      const samePlatform = setup.isFluxer === isFluxer;

      let otherForum;
      try {
        const otherClient = setup.isFluxer ? getFluxerClient(setup.instanceId ?? "default") : discordClient;
        if (!otherClient) {
          await message.reply("Fluxer instance not connected. Is the bot running for it?");
          PendingSetup.delete(directionOrCode);
          return;
        }
        otherForum = await otherClient.channels.fetch(setup.channelId);
      } catch {
        await message.reply("Forum not found. Maybe invite the bot?");
        PendingSetup.delete(directionOrCode);
        return;
      }

      const otherOk = setup.isFluxer ? isFluxerForumLike(otherForum) : isDiscordForumLike(otherForum);
      if (!otherOk) {
        await message.reply("Both sides need to be forum channels to bridge them.");
        PendingSetup.delete(directionOrCode);
        return;
      }

      const otherNsfwClient = setup.isFluxer ? getFluxerClient(setup.instanceId ?? "default") : discordClient;
      const [forumNsfw, otherForumNsfw] = await Promise.all([
        resolveChannelNsfw(isFluxer ? fluxerClient : discordClient, forum),
        resolveChannelNsfw(otherNsfwClient, otherForum),
      ]);
      if ((forumNsfw && !otherForumNsfw) || (!forumNsfw && otherForumNsfw)) {
        await message.reply("Both forums needs to be set as NSFW to bridge them.");
        return;
      }

      const existing = await BridgeEndpoint.findAll({
        where: {
          [Op.or]: [
            { platform: isFluxer ? "fluxer" : "discord", channelId: forum.id, kind: "channel" },
            { platform: setup.isFluxer ? "fluxer" : "discord", channelId: otherForum.id, kind: "channel" },
          ],
        },
      });
      const sharedGroup = existing
        .map(e => e.groupId)
        .filter(id => existing.filter(x => x.groupId === id).length > 1);
      if (existing.length > 0 && sharedGroup.length > 0) {
        await message.reply("One of these forums is already bridged. Unbridge it first, then run this command again.");
        PendingSetup.delete(directionOrCode);
        return;
      }

      const myForum = forum;
      const myInstanceId = isFluxer ? (instanceIdOfClient(fluxerClient) ?? "default") : "default";
      const otherInstanceId = setup.isFluxer ? (setup.instanceId ?? "default") : "default";
      const myPlatform = isFluxer ? "fluxer" : "discord";
      const otherPlatform = setup.isFluxer ? "fluxer" : "discord";

      const { endpoints } = await createBridgeGroup("both", [
        { platform: myPlatform, instanceId: myInstanceId, channel: myForum },
        { platform: otherPlatform, instanceId: otherInstanceId, channel: otherForum },
      ]);

      const myForumEndpoint = endpoints.find(e => e.platform === myPlatform);
      const otherForumEndpoint = endpoints.find(e => e.platform === otherPlatform);

      const myPostId = message.channelId;
      const otherPostId = setup.postId;
      if (myPostId && otherPostId) {
        const myPostEndpoint = await BridgeEndpoint.create({
          platform: myPlatform,
          instanceId: myInstanceId,
          channelId: myPostId,
          guildId: myForum.guildId,
          webhookId: myForumEndpoint.webhookId,
          webhookToken: myForumEndpoint.webhookToken,
          kind: "thread",
          autoMirrored: true,
          parentEndpointId: myForumEndpoint.id,
          tagMap: null,
          groupId: myForumEndpoint.groupId,
        });
        const otherPostEndpoint = await BridgeEndpoint.create({
          platform: otherPlatform,
          instanceId: otherInstanceId,
          channelId: otherPostId,
          guildId: otherForum.guildId,
          webhookId: otherForumEndpoint.webhookId,
          webhookToken: otherForumEndpoint.webhookToken,
          kind: "thread",
          autoMirrored: true,
          parentEndpointId: otherForumEndpoint.id,
          tagMap: null,
          groupId: otherForumEndpoint.groupId,
        });

        const linkGroup = newLinkGroup();
        await MessageLink.create({
          linkGroup,
          messageId: myPostId,
          replyId: null,
          authorId: "",
          endpointId: myPostEndpoint.id,
        });
        await MessageLink.create({
          linkGroup,
          messageId: otherPostId,
          replyId: null,
          authorId: "",
          endpointId: otherPostEndpoint.id,
        });
      }

      await syncForumTags(myForum, myPlatform, discordClient);
      await syncForumTags(otherForum, otherPlatform, discordClient);

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
