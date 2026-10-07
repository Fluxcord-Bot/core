import { Message as FluxerMessage } from "@fluxerjs/core";
import { applyBridgeToggle } from "../../utils/BridgeToggle.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["guild", "g", "server", "s", "community", "c"],
  name: "typing",
  aliases: ["toggletyping"],
  description: "Toggle typing indicator relaying",
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
      "typingEnabled",
      requested,
    );

    if (!changed) {
      await message.reply(
        `Typing indicator relaying is already ${enabled ? "enabled" : "disabled"}.`,
      );
      return;
    }

    await message.reply(
      `Typing indicator relaying ${enabled ? "enabled" : "disabled"}.`,
    );
  },
};

export default command;
