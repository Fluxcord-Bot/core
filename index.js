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
import { setupReactionHandling } from "./utils/ReactionHandler.js";

const discordClient = new DiscordClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
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

discordClient.on(DiscordEvents.ChannelDelete, async (chnl) => {
  await ChannelMap.destroy({
    where: {
      discordChannelId: chnl.id,
    },
  });
});

discordClient.on(DiscordEvents.TypingStart, async (type) => {
  if (type.user.id === discordClient.user?.id) return;

  const channelMap = await ChannelMap.findOne({
    where: {
      discordChannelId: type.channel.id,
    },
  });

  if (channelMap) {
    const channel = await fluxerClient.channels.fetch(
      //@ts-expect-error
      channelMap.fluxerChannelId,
    );
    channel.sendTyping();
  }
});

discordClient.on(DiscordEvents.MessageCreate, async (msg) => {
  if (msg.author.id === discordClient.user?.id) return;
  try {
    await DiscordCreateMessageHandler(msg, discordClient, fluxerClient);
  } catch (e) {
    await sendErrorMessage(msg, discordClient, fluxerClient, e, true);
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

fluxerClient.on(FluxerEvents.ChannelDelete, async (chnl) => {
  await ChannelMap.destroy({
    where: {
      fluxerChannelId: chnl.id,
    },
  });
});

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
    await FluxerDeleteMessageHandler(msg, discordClient, fluxerClient);
  } catch (e) {
    log("DISCORD", e);
  }
});

fluxerClient.on(FluxerEvents.MessageDeleteBulk, async (msgs) => {
  try {
    await FluxerBulkDeleteMessageHandler(msgs, discordClient);
  } catch (e) {
    log("DISCORD", e);
  }
});

fluxerClient.on(FluxerEvents.ChannelPinsUpdate, async (chnl) => {
  try {
    await FluxerPinsUpdateHandler(chnl, discordClient, fluxerClient);
  } catch (e) {
    log("DISCORD", e);
  }
});

fluxerClient.on(FluxerEvents.TypingStart, async (type) => {
  if (type.user_id === fluxerClient.user?.id) return;

  const channelMap = await ChannelMap.findOne({
    where: {
      fluxerChannelId: type.channel_id,
    },
  });

  if (channelMap) {
    try {
      const channel = await discordClient.channels.fetch(
        //@ts-expect-error
        channelMap.discordChannelId,
      );
      if (channel && channel.isSendable()) channel.sendTyping();
    } catch {}
  }
});

let discordReady = false;
let fluxerReady = false;
/** @type {null | (() => void)} */
let startVoiceRecovery = null;

/** @param {unknown} error */
function isRecoverableRuntimeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return false;

  return [
    "WebSocket error",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "Connect Timeout Error",
  ].some((needle) => message.includes(needle));
}

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

  if (
    Config.Motds &&
    Config.Motds.length > 0 &&
    Config.Motds.every((x) => !!x)
  ) {
    setInterval(
      () => {
        motdLoop();
      },
      10 * 60 * 1000,
    );
    motdLoop();
  }

  renderBox([
    "To invite Fluxcord to your server, here's the invite links:",
    "",
    "Discord:",
    await genAuthLink(Config.DiscordClientId),
    "",
    "Fluxer:",
    await genAuthLink(fluxerClient.user?.id, true),
  ]);

  startVoiceRecovery?.();
}

fluxerClient.on(FluxerEvents.Ready, async () => {
  log(
    "FLUXER",
    `${fluxerClient.user?.username}#${fluxerClient.user?.discriminator} is ready!`,
  );

  fluxerClient.sendToGateway(0, {
    op: 3,
    d: {
      custom_status: {
        text: `${Config.BotPrefix}help | bridging ${maps.length} channel${maps.length > 1 ? "s" : ""}`,
      },
      status: "online",
    },
  });

  fluxerReady = true;
  if (discordReady) onBothReady();
});

discordClient.on(DiscordEvents.ClientReady, async () => {
  log("DISCORD", `${discordClient.user?.tag} is ready!`);

  discordClient.user?.setActivity(
    `${Config.BotPrefix}help | bridging ${maps.length} channel${maps.length > 1 ? "s" : ""}`,
  );

  discordReady = true;
  if (fluxerReady) onBothReady();
});

process.on("uncaughtException", (error) => {
  log("META", "A uncaught exception occurred.", error);

  if (isRecoverableRuntimeError(error)) {
    log(
      "META",
      "Ignoring recoverable runtime error and keeping the process alive.",
    );
    return;
  }

  try {
    discordClient.destroy();
  } catch {}

  try {
    fluxerClient.destroy();
  } catch {}

  process.exit(1);
});

// @ts-ignore
process.on(
  "unhandledRejection",
  /** @param {unknown} reason */ (reason, promise) => {
    log("META", "A unhandled rejection occurred.", reason);

    if (isRecoverableRuntimeError(reason)) {
      log(
        "META",
        "Ignoring recoverable runtime rejection and keeping the process alive.",
      );
      return;
    }

    try {
      discordClient.destroy();
    } catch {}

    try {
      fluxerClient.destroy();
    } catch {}

    process.exit(1);
  },
);

if (Config.VoiceBridgingEnabled) {
  const voiceHandler = await import("./utils/VoiceHandler.js");
  const { setupVoiceHandling } = voiceHandler;
  startVoiceRecovery = voiceHandler.startVoiceRecovery;
  await setupVoiceHandling(discordClient, fluxerClient);
}

setupReactionHandling(discordClient, fluxerClient);

discordClient.login(Config.DiscordBotToken);
fluxerClient.login(Config.FluxerBotToken);

function checkIfFluxerConnected() {
  if (!fluxerClient.isReady()) {
    log("DEBUG", "Fluxer didn't connect after 10 seconds, restarting...");
    process.exit(1);
  }
}

function motdLoop() {
  const motds = Config.Motds;
  const motd = motds[Math.floor(Math.random() * motds.length)];

  if (motd) updateBotStatus(motd);
}

/**
 * @param {{ text: string, emoji: string | { fluxer: { name: string, id: string }, discord: string } | undefined }} status
 */
function updateBotStatus(status) {
  let emoji = undefined;

  if (status.emoji)
    if (status.emoji instanceof Object) {
      emoji = {
        discord: status.emoji.discord,
        fluxer: {
          emoji_id: status.emoji.fluxer.id,
          emoji_name: status.emoji.fluxer.name,
        },
      };
    } else {
      emoji = {
        discord: status.emoji,
        fluxer: {
          emoji_name: status.emoji,
        },
      };
    }

  fluxerClient.sendToGateway(0, {
    op: 3,
    d: {
      custom_status: {
        text: `${Config.BotPrefix}help | ${status.text}`,
        ...(emoji ? emoji.fluxer : {}),
      },
      status: "online",
    },
  });

  discordClient.user?.setActivity(
    `${emoji?.discord ? `${emoji.discord} ` : ""}${Config.BotPrefix}help | ${status.text}`,
  );
}

setInterval(() => checkIfFluxerConnected(), 10000);
