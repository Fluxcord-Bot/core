import { Message as FluxerMessage } from "@fluxerjs/core";
import Config from "../../utils/ConfigHandler.js";

/**
 * @param {any} message
 * @returns {string | undefined}
 */
function messageImageUrl(message) {
  const raw = message?.attachments;
  if (!raw) return undefined;
  const list = Array.isArray(raw) ? raw : [...raw.values()];
  const image = list.find(x => x?.contentType?.startsWith("image/")) ?? list.find(x => x?.url);
  return image?.proxyURL ?? image?.proxyUrl ?? image?.url ?? undefined;
}

/**
 * @param {string} url
 * @returns {string | undefined}
 */
function checkImageUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "That is not a valid image URL.";
    }
  } catch {
    return "That is not a valid image URL.";
  }
  return undefined;
}

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["guild", "g", "server", "s", "community", "c"],
  name: "avatar",
  aliases: ["setavatar"],
  description: "Set the bot's avatar in this server/community",
  requireElevated: true,
  params: "[imageUrl|reset]",
  slashOptions: [{ name: "image", type: "attachment" }],
  async run(params, message, discordClient, fluxerClient) {
    if (!message.guildId) {
      await message.reply("This command can only be used in a server.");
      return;
    }

    const isFluxer = message instanceof FluxerMessage;
    const input = params[0] ?? messageImageUrl(message);

    if (input && input.toLowerCase() === "reset") {
      try {
        if (isFluxer) {
          const guild = await fluxerClient.guilds.fetch(message.guildId);
          await guild.members.me.edit({ avatar: null });
        } else {
          const guild = await discordClient.guilds.fetch(message.guildId);
          await guild.members.editMe({ avatar: null });
        }
      } catch {
        await message.reply("Failed to reset the avatar.");
        return;
      }
      await message.reply("Avatar reset!");
      return;
    }

    if (!input) {
      await message.reply(`Missing image. Usage:
\`\`\`
${Config.BotPrefix}guild avatar [IMAGE_URL]
\`\`\`
Attach an image or pass an image URL. Run \`${Config.BotPrefix}guild avatar reset\` to clear it.`);
      return;
    }

    const invalid = checkImageUrl(input);
    if (invalid) {
      await message.reply(invalid);
      return;
    }

    try {
      if (isFluxer) {
        const res = await fetch(input);
        if (!res.ok) {
          await message.reply("Could not download the image.");
          return;
        }
        const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
        if (!mime.startsWith("image/")) {
          await message.reply("That URL is not an image.");
          return;
        }
        const guild = await fluxerClient.guilds.fetch(message.guildId);
        await guild.members.me.edit({
          avatar: `data:${mime};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`,
        });
      } else {
        const guild = await discordClient.guilds.fetch(message.guildId);
        await guild.members.editMe({ avatar: input });
      }
    } catch {
      await message.reply("Failed to set the avatar.");
      return;
    }

    await message.reply("Avatar updated!");
  },
};

export default command;
