import { Message as FluxerMessage, Message } from "@fluxerjs/core";
import Config from "../../utils/ConfigHandler.js";
import { GuildMap } from "../../db/index.js";
import changeBotBio from "../../utils/ChangeBotBio.js";

const MAX_BIO_LENGTH = 300;

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["guild", "g", "server", "s", "community", "c"],
  name: "bio",
  aliases: ["setbio"],
  description: "Set the bot's bio in this server/community",
  requireElevated: true,
  params: "[text|reset]",
  slashOptions: [{ name: "text", type: "string" }],
  async run(params, message, discordClient, fluxerClient) {
    if (!message.guildId) {
      await message.reply("This command can only be used in a server.");
      return;
    }

    const isFluxer = message instanceof FluxerMessage;
    const text = params.join(" ").trim();

    const guildMap = await GuildMap.findOrCreate({
      where: {
        guildId: message.guildId,
      },
      defaults: {
        guildType: message instanceof Message ? "fluxer" : "discord",
      },
    });

    if (text.toLowerCase() === "reset") {
      guildMap[0].customBio = null;
      await guildMap[0].save();
      try {
        if (isFluxer) {
          await changeBotBio(await fluxerClient.guilds.fetch(message.guildId));
        } else {
          await changeBotBio(await discordClient.guilds.fetch(message.guildId));
        }
      } catch {
        await message.reply("Failed to reset the bio.");
        return;
      }
      await message.reply("Bio reset to the automatic one!");
      return;
    }

    if (!text) {
      await message.reply(`Missing text. Usage:
\`\`\`
${Config.BotPrefix}guild bio [TEXT]
\`\`\`
Run \`${Config.BotPrefix}guild bio reset\` to go back to the automatic bio.`);
      return;
    }

    if (text.length > MAX_BIO_LENGTH) {
      await message.reply(`The bio cannot be longer than ${MAX_BIO_LENGTH} characters.`);
      return;
    }

    try {
      if (isFluxer) {
        const guild = await fluxerClient.guilds.fetch(message.guildId);
        await guild.members.me.edit({ bio: text });
      } else {
        const guild = await discordClient.guilds.fetch(message.guildId);
        await guild.members.editMe({ bio: text });
      }
    } catch {
      await message.reply("Failed to set the bio.");
      return;
    }

    guildMap[0].customBio = text;
    await guildMap[0].save();

    await message.reply("Bio updated!");
  },
};

export default command;
