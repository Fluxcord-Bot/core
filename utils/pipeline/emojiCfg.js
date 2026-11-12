import { readFileSync } from "node:fs";
import Config from "../ConfigHandler.js";
import { normalizeFcJson } from "../NormalizeJson.js";

let cachedCfg = undefined;

export function fluxcordBotEmojiCfg() {
  if (cachedCfg) return cachedCfg;
  try {
    cachedCfg = normalizeFcJson(JSON.parse(readFileSync(Config.DataFolderPath + "/fluxcord.json", "utf-8")));
  } catch {
    cachedCfg = null;
  }
  return cachedCfg;
}

export function fluxerReplyLine(instanceId) {
  const cfg = fluxcordBotEmojiCfg();
  const fluxerReplies = cfg?.fluxerReplyEmoji;
  const entry = fluxerReplies?.[instanceId] ?? fluxerReplies?.default ?? Object.values(fluxerReplies ?? {})[0];
  if (!entry?.replyL || !entry?.replyR) return "";
  return `-# ${entry.replyL}${entry.replyR} `;
}

export function discordReplyLine() {
  const cfg = fluxcordBotEmojiCfg();
  const discordReply = cfg?.discordReplyEmoji;
  if (!discordReply?.replyL || !discordReply?.replyR) return "";
  return `-# <:reply_l:${discordReply.replyL}><:reply_r:${discordReply.replyR}> `;
}

export function replyLineForPlatform(targetPlatform, targetInstanceId = null) {
  return targetPlatform === "fluxer" ? fluxerReplyLine(targetInstanceId ?? "default") : discordReplyLine();
}
