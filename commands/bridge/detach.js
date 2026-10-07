import { Message as FluxerMessage } from "@fluxerjs/core";
import { MessageMap } from "../../db/index.js";
import Config from "../../utils/ConfigHandler.js";
import { Op } from "sequelize";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["bridge", "b"],
  name: "detach",
  aliases: ["detachmessage"],
  description: "Detach a bridged message without deleting it",
  requireElevated: true,
  params: "[messageId]",
  slashOptions: [{ name: "message_id", type: "string" }],
  additionalInfo: `[messageId] - the Discord or Fluxer ID of the bridged message, defaults to the message you replied to
Detaching removes the bridge link for that message only. Both copies stay, but edits, deletes and pins will no longer sync between them.`,
  async run(params, message) {
    let isFluxer = message instanceof FluxerMessage;
    const replyId = isFluxer
      ? message.messageReference?.messageId
      : message.reference?.messageId;
    const messageId = params[0] ?? replyId;

    if (!messageId) {
      await message.reply(`Missing message. Usage:
\`\`\`
${Config.BotPrefix}bridge detach [MESSAGE_ID]
\`\`\`
Or reply to the bridged message and run \`${Config.BotPrefix}detach\`.`);
      return;
    }

    const messageMap = await MessageMap.findOne({
      where: {
        [Op.or]: [{ discordMessageId: messageId }, { fluxerMessageId: messageId }],
      },
      include: ["channelMap"],
    });

    if (!messageMap) {
      await message.reply("That message is not a bridged message.");
      return;
    }

    const channelMap = messageMap.channelMap;
    if (
      !channelMap ||
      (channelMap.discordChannelId !== message.channelId &&
        channelMap.fluxerChannelId !== message.channelId)
    ) {
      await message.reply("That message is not bridged in this channel.");
      return;
    }

    const repliers = await MessageMap.findAll({
      where: {
        [Op.or]: [
          { fluxerReplyId: messageMap.fluxerMessageId },
          { fluxerReplyId: messageMap.discordMessageId },
          { discordReplyId: messageMap.fluxerMessageId },
          { discordReplyId: messageMap.discordMessageId },
        ],
      },
    });

    for (const reply of repliers) {
      if (
        reply.fluxerReplyId === messageMap.fluxerMessageId ||
        reply.fluxerReplyId === messageMap.discordMessageId
      ) {
        reply.fluxerReplyId = null;
      }
      if (
        reply.discordReplyId === messageMap.fluxerMessageId ||
        reply.discordReplyId === messageMap.discordMessageId
      ) {
        reply.discordReplyId = null;
      }
      await reply.save();
    }

    await messageMap.destroy();

    await message.reply(
      "Message detached. It will stay on both sides, but edits, deletes and pins will no longer sync for it.",
    );
  },
};

export default command;
