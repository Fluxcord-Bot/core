import { Message as FluxerMessage } from "@fluxerjs/core";
import { applyBridgeToggle } from "../../utils/BridgeToggle.js";

/**
 * @type {import('../../utils/CommandSchema.js').CommandSchema}
 */
const command = {
  groupNames: ["guild", "g", "server", "s", "community", "c"],
  name: "toggledeletethread",
  aliases: ["deletethread", "setdeletethread", "thread"],
  description: "Toggle the bot deleting bridged threads ",
  requireElevated: true,
  params: "[on|off]",
  slashOptions: [
    {
      name: "state",
      type: "string",
      choices: [
        { name: "on", value: "on" },
        { name: "off", value: "off" },
      ],
    },
  ],
  async run(params, message) {
    if (!message.guildId) {
      await message.reply("This command can only be used in a server.");
      return;
    }

    const isFluxer = message instanceof FluxerMessage;
    const arg = params[0]?.toLowerCase();

    let requested;
    if (arg === "on") {
      requested = true;
    } else if (arg === "off") {
      requested = false;
    } else if (arg) {
      await message.reply("Usage: `on` or `off`.");
      return;
    }

    const { enabled, changed } = await applyBridgeToggle(
      message.guildId,
      isFluxer ? "fluxer" : "discord",
      "deleteThreadEnabled",
      requested
    );

    if (!changed) {
      await message.reply(`Thread deletion bridging is already ${enabled ? "enabled" : "disabled"}.`);
      return;
    }

    await message.reply(`Thread deletion bridging ${enabled ? "enabled" : "disabled"}.`);
  },
};

export default command;
