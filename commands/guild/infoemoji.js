import { Message as FluxerMessage } from "@fluxerjs/core";
import { applyBridgeValue } from "../../utils/BridgeToggle.js";
import { DEFAULT_INFO_EMOJI } from "../../utils/MessageBridgeInfo.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["guild", "g", "server", "s", "community", "c"],
  name: "infoemoji",
  aliases: ["setinfoemoji", "inforeact", "setinforeaction"],
  description: "Set the emoji that DMs message info, default is ℹ️",
  params: "[emoji]",
  slashOptions: [{ name: "emoji", type: "string" }],
  requireElevated: true,
  async run(params, message, discordClient, fluxerClient) {
    if (!message.guildId) {
      await message.reply("This command can only be used in a server.");
      return;
    }

    const isFluxer = message instanceof FluxerMessage;
    const guildType = isFluxer ? "fluxer" : "discord";

    if (!params[0]) {
      const { current } = await applyBridgeValue(
        message.guildId,
        guildType,
        "infoReactionEmoji",
        undefined,
        null
      );
      await message.reply(`Info reaction is currently ${current ?? DEFAULT_INFO_EMOJI}.`);
      return;
    }

    let emoji = params[0];
    if (isFluxer) {
      try {
        emoji = await fluxerClient.resolveEmoji(emoji, message.guildId);
      } catch {
        await message.reply("Specified emoji could not be resolved on this server.");
        return;
      }
    }

    if (/[<>:]/.test(emoji)) {
      await message.reply("Custom emojis are not supported. Use a standard emoji.");
      return;
    }

    await applyBridgeValue(message.guildId, guildType, "infoReactionEmoji", emoji, null);

    await message.reply(`Successfully set ${emoji} as the info reaction!`);
  },
};

export default command;
