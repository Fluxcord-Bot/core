//@ts-check
import { Events as FluxerEvents, Client as FluxerClient } from "@fluxerjs/core";
import {
  Client as DiscordClient,
  Events as DiscordEvents,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import Config from "./utils/ConfigHandler.js";
import {
  FluxerBulkDeleteMessageHandler,
  FluxerCreateMessageHandler,
  FluxerDeleteMessageHandler,
  FluxerPinsUpdateHandler,
  FluxerUpdateMessageHandler,
} from "./utils/FluxerHandler.js";
import {
  DiscordBulkDeleteMessageHandler,
  DiscordCreateMessageHandler,
  DiscordDeleteMessageHandler,
  DiscordPinsUpdateHandler,
  DiscordUpdateMessageHandler,
} from "./utils/DiscordHandler.js";
import { log } from "./utils/Logger.js";
import fs from "node:fs";
import { ChannelMap, GuildMap } from "./db/index.js";
import { sendErrorMessage } from "./utils/SendErrorMessage.js";
import { genAuthLink, renderBox } from "./utils/GenAuthLink.js";
import changeBotBios from "./utils/ChangeBotBio.js";

const discordClient = new DiscordClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

export const botStartingTime = new Date();

const maps = await ChannelMap.findAll();

const fluxerClient = new FluxerClient({
  rest: {
    api: Config.FluxerAPIBaseURL,
  },
  intents: 0,
  presence: {
    status: "online",
    custom_status: {
      text: `${Config.BotPrefix}help | bridging ${maps.length} channel${maps.length > 1 ? "s" : ""}`,
    },
  },
});

discordClient.on(DiscordEvents.GuildDelete, async (guild) => {
  if (!guild.available) return;

  await GuildMap.destroy({
    where: {
      guildId: guild.id,
    },
  });
});

discordClient.on(DiscordEvents.MessageCreate, async (msg) => {
  if (msg.author.id === discordClient.user?.id) return;
  try {
    await DiscordCreateMessageHandler(msg, discordClient, fluxerClient);
  } catch (e) {
    if (`${e}`.includes("Explicit content")) {
      try {
        await DiscordCreateMessageHandler(msg, discordClient, fluxerClient);
      } catch (e) {
        await sendErrorMessage(msg, discordClient, fluxerClient, e, true);
      }
    } else await sendErrorMessage(msg, discordClient, fluxerClient, e, true);
  }
});

discordClient.on(DiscordEvents.MessageUpdate, async (oldMsg, newMsg) => {
  try {
    await DiscordUpdateMessageHandler(oldMsg, newMsg, fluxerClient);
  } catch (e) {
    await sendErrorMessage(newMsg, discordClient, fluxerClient, e);
  }
});

discordClient.on(DiscordEvents.MessageDelete, async (msg) => {
  try {
    await DiscordDeleteMessageHandler(msg, fluxerClient);
  } catch (e) {
    log("FLUXER", e);
  }
});

discordClient.on(DiscordEvents.MessageBulkDelete, async (msgs) => {
  try {
    await DiscordBulkDeleteMessageHandler(msgs, fluxerClient);
  } catch (e) {
    log("FLUXER", e);
  }
});

discordClient.on(DiscordEvents.ChannelPinsUpdate, async (channel) => {
  try {
    await DiscordPinsUpdateHandler(channel, fluxerClient);
  } catch (e) {
    log("FLUXER", e);
  }
});

// prob contributed on the sudden deletions, will comment this for now
// fluxerClient.on(FluxerEvents.GuildDelete, async (guild) => {
//   if (guild.unavailable) return;

//   await GuildMap.destroy({
//     where: {
//       guildId: guild.id
//     }
//   })
// })

fluxerClient.on(FluxerEvents.MessageCreate, async (msg) => {
  try {
    if (msg.author.id === fluxerClient.user?.id) return;
    await FluxerCreateMessageHandler(msg, fluxerClient, discordClient);
  } catch (e) {
    await sendErrorMessage(msg, discordClient, fluxerClient, e, true);
  }
});
fluxerClient.on(FluxerEvents.MessageUpdate, async (oldMsg, newMsg) => {
  try {
    await FluxerUpdateMessageHandler(oldMsg, newMsg, discordClient);
  } catch (e) {
    await sendErrorMessage(newMsg, discordClient, fluxerClient, e);
  }
});
fluxerClient.on(FluxerEvents.MessageDelete, async (msg) => {
  try {
    FluxerDeleteMessageHandler(msg, discordClient);
  } catch (e) {
    log("DISCORD", e);
  }
});

fluxerClient.on(FluxerEvents.MessageDeleteBulk, async (msgs) => {
  try {
    FluxerBulkDeleteMessageHandler(msgs, discordClient);
  } catch (e) {
    log("DISCORD", e);
  }
});

fluxerClient.on(FluxerEvents.ChannelPinsUpdate, async (chnl) => {
  try {
    FluxerPinsUpdateHandler(chnl, discordClient, fluxerClient);
  } catch (e) {
    log("DISCORD", e);
  }
});

let discordReady = false;
let fluxerReady = false;

async function onBothReady() {
  if (!fs.existsSync(Config.DataFolderPath + "/fluxcord.json")) {
    log("META", "Welcome to Fluxcord! Doing first-time setup...");
    try {
      const replyL = fs.readFileSync(Config.DataFolderPath + "/reply-l.webp");
      const replyR = fs.readFileSync(Config.DataFolderPath + "/reply-r.webp");

      const fluxerGuild = await fluxerClient.guilds.fetch(
        Config.FluxerTempEmojiGuildId,
      );
      try {
        await fluxerGuild?.createEmojisBulk([
          {
            // @ts-ignore
            image: replyL.toString("base64"),
            name: "reply_l",
          },
          {
            // @ts-ignore
            image: replyR.toString("base64"),
            name: "reply_r",
          },
        ]);
      } catch {}

      const fluxerEmojiReplyL = await fluxerClient.resolveEmoji(
        ":reply_l:",
        Config.FluxerTempEmojiGuildId,
      );
      const fluxerEmojiReplyR = await fluxerClient.resolveEmoji(
        ":reply_r:",
        Config.FluxerTempEmojiGuildId,
      );

      let discordEmojiReplyL;
      try {
        discordEmojiReplyL = await discordClient.application?.emojis.create({
          attachment: replyL,
          name: "reply_l",
        });
      } catch {}

      let discordEmojiReplyR;
      try {
        discordEmojiReplyR = await discordClient.application?.emojis.create({
          attachment: replyR,
          name: "reply_r",
        });
      } catch {}

      if (!discordEmojiReplyL || !discordEmojiReplyR) {
        const existing = await discordClient.application?.emojis.fetch();
        discordEmojiReplyL ??= existing?.find((e) => e.name === "reply_l");
        discordEmojiReplyR ??= existing?.find((e) => e.name === "reply_r");
      }

      fs.writeFileSync(
        Config.DataFolderPath + "/fluxcord.json",
        JSON.stringify({
          autoGenerated:
            "This file is automatically generated by Fluxcord. Please do not touch it!",
          fluxerReplyEmoji: {
            replyL: fluxerEmojiReplyL,
            replyR: fluxerEmojiReplyR,
          },
          discordReplyEmoji: {
            replyL: discordEmojiReplyL?.id,
            replyR: discordEmojiReplyR?.id,
          },
        }),
      );
      log("META", "First time setup done! Enjoy using the bot!");
    } catch (e) {
      log("META", "First time setup failed:", e);
    }
  }

  await changeBotBios(fluxerClient, discordClient);

  renderBox([
    "To invite Fluxcord to your server, here's the invite links:",
    "",
    "Discord:",
    genAuthLink(Config.DiscordClientId),
    "",
    "Fluxer:",
    genAuthLink(fluxerClient.user?.id, true),
  ]);
}

fluxerClient.on(FluxerEvents.Ready, async () => {
  log(
    "FLUXER",
    `${fluxerClient.user?.username}#${fluxerClient.user?.discriminator} is ready!`,
  );
  fluxerReady = true;
  if (discordReady) onBothReady();
});

discordClient.on(DiscordEvents.ClientReady, async () => {
  log("DISCORD", `${discordClient.user?.tag} is ready!`);

  discordClient.user?.setActivity(
    `${Config.BotPrefix}help | bridging ${maps.length}  channel${maps.length > 1 ? "s" : ""}`,
  );

  discordReady = true;
  if (fluxerReady) onBothReady();
});

process.on("uncaughtException", (error) => {
  log("META", "A uncaught exception occurred.", error);

  try {
    discordClient.destroy();
  } catch {}

  try {
    fluxerClient.destroy();
  } catch {}

  process.exit(1);
});

// @ts-ignore
process.on("unhandledRejection", (reason, promise) => {
  log("META", "A unhandled rejection occurred.", reason);

  try {
    discordClient.destroy();
  } catch {}

  try {
    fluxerClient.destroy();
  } catch {}

  process.exit(1);
});

if ((Config.VoiceChannelMaps ?? []).length > 0) {
  const { setupVoiceHandling } = await import("./utils/VoiceHandler.js");
  setupVoiceHandling(discordClient, fluxerClient);
  log(
    "VOICE",
    `Voice bridging active for ${Config.VoiceChannelMaps.length} channel map(s)`,
  );
}

discordClient.login(Config.DiscordBotToken);
fluxerClient.login(Config.FluxerBotToken);

function checkIfFluxerConnected() {
  if (!fluxerClient.isReady()) {
    log("DEBUG", "Fluxer didn't connect after 10 seconds, restarting...");
    process.exit(1);
  }
}

setInterval(() => checkIfFluxerConnected(), 10000);

// TODO: Make VC mappings automatic instead of assigning them, like in the example config
