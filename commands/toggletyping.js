import { Message as FluxerMessage } from "@fluxerjs/core";
import { GuildMap } from "../db/index.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "toggletyping",
  aliases: ["typing"],
  description: "Toggle typing indicator relaying",
  requireElevated: true,
  params: "[on|off]",
  async run(params, message) {
    if (!message.guildId) {
      await message.reply("This command can only be used in a server.");
      return;
    }

    const isFluxer = message instanceof FluxerMessage;
    const [guildMap] = await GuildMap.findOrCreate({
      where: {
        guildId: message.guildId,
      },
      defaults: {
        guildType: isFluxer ? "fluxer" : "discord",
      },
    });

    const arg = params[0]?.toLowerCase();
    const current = guildMap.get("typingEnabled") !== false;

    let enabled;
    if (arg === "on") {
      enabled = true;
    } else if (arg === "off") {
      enabled = false;
    } else if (arg) {
      await message.reply("Usage: `on` or `off`.");
      return;
    } else {
      enabled = !current;
    }

    if (enabled === current) {
      await message.reply(
        `Typing indicator relaying is already ${enabled ? "enabled" : "disabled"}.`,
      );
      return;
    }

    guildMap.set("typingEnabled", enabled);
    await guildMap.save();

    await message.reply(
      `Typing indicator relaying ${enabled ? "enabled" : "disabled"}.`,
    );
  },
};

export default command;
