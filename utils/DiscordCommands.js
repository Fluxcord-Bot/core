//@ts-check
import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  EmbedBuilder as DiscordEmbedBuilder,
  Events,
  PermissionFlagsBits,
} from "discord.js";
import { EmbedBuilder as FluxerEmbedBuilder } from "@fluxerjs/core";
import Config from "./ConfigHandler.js";
import { getCommands } from "./CommandHandler.js";
import { checkManageServerPerms } from "./CheckManageServerPerms.js";
import { log } from "./Logger.js";
import { getGuildPrefix } from "./GetGuildPrefix.js";

/** @type {string[]} */
const flagTokens = ["silent", "quiet", "-s", "--silent"];

/**
 * @param {string} token
 */
function isFlagToken(token) {
  return flagTokens.includes(token.toLowerCase().replace(/^[<\[(]+|[>\])]+$/g, ""));
}

/**
 * @param {string} raw
 */
function sanitizeName(raw) {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-_]/g, "");
  return (cleaned || "arg").slice(0, 32);
}

/**
 * @param {string | undefined} params
 */
function defsFromParams(params) {
  if (!params || !params.trim()) {
    return [];
  }
  const tokens = params.trim().split(/\s+/);
  /** @type {any[]} */
  const defs = [];
  tokens.forEach((token, i) => {
    const stripped = token.replace(/^[<\[(]+|[>\])]+$/g, "").replace(/^\.+/, "");
    const required = /^</.test(token) && />$/.test(token);
    if (!stripped || stripped === "...") {
      return;
    }
    if (stripped.startsWith("...")) {
      defs.push({
        name: sanitizeName(stripped.slice(3) || `arg${i + 1}`),
        type: ApplicationCommandOptionType.String,
        required: false,
        rest: true,
      });
      return;
    }
    const parts = stripped.split("|").map((x) => x.replace(/^[(\[]+|[)\]]+$/g, "")).filter(Boolean);
    if (parts.length > 1 && !parts.some((x) => x.includes("="))) {
      const base = parts.find((x) => !isFlagToken(x) && /[a-zA-Z]/.test(x) && !/^(code|d2f|f2d|both|on|off)$/i.test(x));
      defs.push({
        name: sanitizeName(base || `option${i + 1}`),
        type: ApplicationCommandOptionType.String,
        required,
        choices: parts.map((v) => ({ name: v.slice(0, 100), value: v })),
      });
      return;
    }
    if (isFlagToken(stripped)) {
      defs.push({
        name: sanitizeName(stripped),
        type: ApplicationCommandOptionType.Boolean,
        required: false,
        flag: stripped.toLowerCase().includes("silent") ? "silent" : stripped,
      });
      return;
    }
    defs.push({
      name: sanitizeName(stripped),
      type: ApplicationCommandOptionType.String,
      required,
    });
  });
  /** @type {any[]} */
  const requiredFirst = [...defs.filter((d) => d.required), ...defs.filter((d) => !d.required)];
  return requiredFirst;
}

/** @type {Record<string, ApplicationCommandOptionType>} */
const slashTypeMap = {
  string: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  boolean: ApplicationCommandOptionType.Boolean,
  channel: ApplicationCommandOptionType.Channel,
  attachment: ApplicationCommandOptionType.Attachment,
};

/**
 * @param {import("./CommandSchema.d.ts").CommandSchema} cmd
 */
function resolveDefs(cmd) {
  if (cmd.slashOptions && cmd.slashOptions.length > 0) {
    /** @type {any[]} */
    const mapped = cmd.slashOptions.map((d) => ({
      name: sanitizeName(d.name),
      type: slashTypeMap[d.type ?? "string"] ?? ApplicationCommandOptionType.String,
      required: d.type === "boolean" ? false : !!d.required,
      choices: d.choices,
      flag: d.flag,
      rest: d.rest,
      channelTypes: d.channelTypes,
    }));
    return [...mapped.filter((d) => d.required), ...mapped.filter((d) => !d.required)];
  }
  return defsFromParams(cmd.params);
}

/**
 * @param {any} payload
 */
function normalizePayload(payload) {
  /** @type {any} */
  let data = payload;
  if (typeof data === "string") {
    data = { content: data };
  }
  data = { ...data };
  if (Array.isArray(data.embeds)) {
    data.embeds = data.embeds.map((/** @type {any} */ e) => {
      if (e instanceof FluxerEmbedBuilder || e instanceof DiscordEmbedBuilder) {
        return e.toJSON();
      }
      if (e && typeof e.toJSON === "function") {
        try {
          return e.toJSON();
        } catch {
          return e;
        }
      }
      return e;
    });
  }
  if (Array.isArray(data.files)) {
    data.files = data.files.map((/** @type {any} */ f) => {
      if (f instanceof AttachmentBuilder) {
        return f;
      }
      if (f && typeof f === "object" && "data" in f && "name" in f) {
        return new AttachmentBuilder(/** @type {any} */ (f.data), { name: /** @type {any} */ (f.name) });
      }
      return f;
    });
  }
  if (Array.isArray(data.components)) {
    data.components = data.components.map((/** @type {any} */ c) => {
      if (c && typeof c.toJSON === "function") {
        try {
          return c.toJSON();
        } catch {
          return c;
        }
      }
      return c;
    });
  }
  return data;
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {import("discord.js").Client} discordClient
 */
function buildShimMessage(interaction, discordClient) {
  /** @type {any} */
  let replied = false;
  /** @type {any} */
  const sentMessageHolder = { value: null };
  async function doReply(/** @type {any} */ payload) {
    const data = normalizePayload(payload);
    if (!replied) {
      replied = true;
      const msg = await interaction.reply({ ...data, fetchReply: true });
      sentMessageHolder.value = msg;
      return wrapSent(msg);
    }
    const msg = await interaction.followUp(data);
    sentMessageHolder.value = msg;
    return wrapSent(msg);
  }
  function wrapSent(/** @type {any} */ msg) {
    return {
      ...msg,
      edit: async (/** @type {any} */ payload) => {
        const data = normalizePayload(payload);
        if (sentMessageHolder.value && sentMessageHolder.value.id === msg.id) {
          return await interaction.editReply(data);
        }
        return await msg.edit(data);
      },
    };
  }
  /** @type {any} */
  const shim = {
    author: interaction.user,
    member: interaction.member,
    content: "",
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    channel: interaction.channel,
    guild: interaction.guild,
    client: discordClient,
    createdTimestamp: interaction.createdTimestamp,
    reference: null,
    interaction: null,
    reply: doReply,
  };
  return { shim, sentMessageHolder };
}

/**
 * @param {any[]} defs
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
function buildParams(defs, interaction) {
  /** @type {string[]} */
  const params = [];
  for (const def of defs) {
    if (def.type === ApplicationCommandOptionType.Boolean) {
      if (interaction.options.getBoolean(def.name)) {
        params.push(def.flag || def.name);
      }
      continue;
    }
    if (def.type === ApplicationCommandOptionType.Integer) {
      const value = interaction.options.getInteger(def.name);
      if (value === null || value === undefined) {
        continue;
      }
      params.push(String(value));
      continue;
    }
    if (def.type === ApplicationCommandOptionType.Channel) {
      const value = interaction.options.getChannel(def.name);
      if (!value) {
        continue;
      }
      params.push(value.id);
      continue;
    }
    if (def.type === ApplicationCommandOptionType.Attachment) {
      const value = interaction.options.getAttachment(def.name);
      if (!value) {
        continue;
      }
      params.push(value.url);
      continue;
    }
    const value = interaction.options.getString(def.name);
    if (value === null || value === undefined) {
      continue;
    }
    if (def.rest) {
      params.push(...String(value).split(/\s+/).filter(Boolean));
    } else {
      params.push(String(value));
    }
  }
  return params;
}

/**
 * @param {import("./CommandSchema.d.ts").CommandSchema[]} commands
 */
export function toSlashCommandJson(commands) {
  /** @type {Map<string, any[]>} */
  const grouped = new Map();
  /** @type {Map<string, boolean>} */
  const groupedAllowDM = new Map();
  /** @type {any[]} */
  const topLevel = [];
  for (const cmd of commands) {
    if (cmd.hideFromHelp || cmd.excludeFromSlash) {
      log("DEBUG", `SlashCommands skip ${cmd.name} hideFromHelp=${!!cmd.hideFromHelp} excludeFromSlash=${!!cmd.excludeFromSlash}`);
      continue;
    }
    const defs = resolveDefs(cmd);
    /** @type {any[]} */
    const options = defs.map((d) => {
      /** @type {any} */
      const opt = {
        name: d.name,
        description: d.name,
        type: d.type,
        required: d.type === ApplicationCommandOptionType.Boolean ? false : !!d.required,
      };
      if (d.choices) {
        opt.choices = d.choices;
      }
      if (d.channelTypes) {
        opt.channel_types = d.channelTypes;
      }
      return opt;
    });
    /** @type {any} */
    const sub = {
      name: sanitizeName(cmd.name),
      description: (cmd.description ?? cmd.name).slice(0, 100),
      type: ApplicationCommandOptionType.Subcommand,
      options,
    };
    const groupFirst = cmd.groupNames && cmd.groupNames.length > 0 ? cmd.groupNames[0] ?? "" : "";
    const parent = groupFirst ? sanitizeName(groupFirst) : undefined;
    if (parent) {
      if (!grouped.has(parent)) {
        grouped.set(parent, []);
        groupedAllowDM.set(parent, true);
      }
      grouped.get(parent)?.push(sub);
      if (!cmd.allowDM) {
        groupedAllowDM.set(parent, false);
      }
    } else {
      topLevel.push({
        name: sanitizeName(cmd.name),
        description: (cmd.description ?? cmd.name).slice(0, 100),
        type: 1,
        options,
        default_member_permissions: cmd.requireElevated
          ? PermissionFlagsBits.ManageGuild.toString()
          : undefined,
        dm_permission: cmd.allowDM ? undefined : false,
      });
    }
  }
  for (const [groupName, subs] of grouped) {
    log("DEBUG", `SlashCommands group ${groupName} subcommands=${subs.map((s) => s.name).join(",")}`);
    topLevel.push({
      name: groupName,
      description: groupName,
      type: 1,
      options: subs,
      dm_permission: groupedAllowDM.get(groupName) ? undefined : false,
    });
  }
  log("DEBUG", `SlashCommands built count=${topLevel.length} names=${topLevel.map((c) => c.name).join(",")}`);
  return topLevel;
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
export async function registerDiscordCommands(discordClient, fluxerClient) {
  void fluxerClient;
  const commands = await getCommands();
  log("DEBUG", `SlashCommands registering prefixCommands=${commands.length}`);
  const json = toSlashCommandJson(commands);
  log("DEBUG", `SlashCommands pushing applicationCommands=${json.length}`);
  await discordClient.application?.commands.set(json);
  log("DEBUG", `SlashCommands registered applicationCommands=${json.length}`);
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
export function setupDiscordCommands(discordClient, fluxerClient) {
  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }
    try {
      const commands = await getCommands();
      const sub = interaction.options.getSubcommand(false);
      const targetName = sub ?? interaction.commandName;
      let commandToRun = commands.find((x) => x.name.toLowerCase() === targetName.toLowerCase());
      if (!commandToRun && !sub) {
        commandToRun = commands.find(
          (x) => x.aliases?.some((a) => a.toLowerCase() === interaction.commandName.toLowerCase()),
        );
      }
      if (!commandToRun) {
        if (interaction.replied || interaction.deferred) {
          return;
        }
        await interaction.reply({
          content: "Unknown command.",
          ephemeral: true,
        });
        return;
      }
      if (
        commandToRun.requireOwner &&
        !Config.AdminAccountIds.includes(interaction.user.id)
      ) {
        await interaction.reply({
          content: "Only bot admins can execute this command!",
          ephemeral: true,
        });
        return;
      }
      if (
        commandToRun.requireElevated &&
        !(await checkManageServerPerms(
          interaction.guildId ?? "",
          interaction.user.id,
          discordClient,
        ))
      ) {
        await interaction.reply({
          content: "You need at least **Manage Server** permissions to run this command!",
          ephemeral: true,
        });
        return;
      }
      const { shim } = buildShimMessage(interaction, discordClient);
      try {
        if (interaction.channel && !shim.channel) {
          shim.channel = interaction.channel;
        }
        if (!shim.channel) {
          try {
            shim.channel = await discordClient.channels.fetch(interaction.channelId ?? "");
          } catch {
            shim.channel = null;
          }
        }
        if (interaction.guildId && !shim.guild) {
          try {
            shim.guild = await discordClient.guilds.fetch(interaction.guildId);
          } catch {
            shim.guild = null;
          }
        }
        if (shim.guild && interaction.guild) {
          shim.guild = interaction.guild;
        }
      } catch {}
      const defs = resolveDefs(commandToRun);
      const params = buildParams(defs, interaction);
      const prefix = await getGuildPrefix(interaction.guildId ?? "");
      shim.content = `${prefix}${commandToRun.name} ${params.join(" ")}`.trim();
      await commandToRun.run(params, shim, discordClient, fluxerClient);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Command completed.",
          ephemeral: true,
        });
      }
    } catch (e) {
      log("DISCORD", e);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: `A error has occurred while executing this command: \`${e}\``,
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: `A error has occurred while executing this command: \`${e}\``,
            ephemeral: true,
          });
        }
      } catch {}
    }
  });
}
