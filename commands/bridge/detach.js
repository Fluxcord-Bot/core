import { Message as FluxerMessage } from "@fluxerjs/core";
import { MessageLink } from "../../db/index.js";
import Config from "../../utils/ConfigHandler.js";
import { detachMessageGroup } from "../../utils/SetupHelper.js";

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
    const replyId = isFluxer ? message.messageReference?.messageId : message.reference?.messageId;
    const messageId = params[0] ?? replyId;

    if (!messageId) {
      await message.reply(`Missing message. Usage:
\`\`\`
${Config.BotPrefix}bridge detach [MESSAGE_ID]
\`\`\`
Or reply to the bridged message and run \`${Config.BotPrefix}detach\`.`);
      return;
    }

    const row = await MessageLink.findOne({ where: { messageId }, include: ["endpoint"] });
    if (!row) {
      await message.reply("That message is not a bridged message.");
      return;
    }

    if (row.endpoint?.channelId !== message.channelId) {
      await message.reply("That message is not bridged in this channel.");
      return;
    }

    await detachMessageGroup(row.linkGroup);

    await message.reply("Message detached. It will stay on both sides, but edits, deletes and pins will no longer sync for it.");
  },
};

export default command;
