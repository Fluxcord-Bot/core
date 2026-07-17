import { Message as FluxerMessage } from "@fluxerjs/core";
import { getFluxerWebappUrl } from "./GetFluxerUrls.js";

/**
 * @param {import("discord.js").Message | import("@fluxerjs/core").Message} message
 */
export async function genMsgLink(message) {
  if (message instanceof FluxerMessage) {
    const webappUrl = await getFluxerWebappUrl();
    return `${webappUrl}/channels/${message.guildId}/${message.channelId}/${message.id}`;
  } else {
    return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
  }
}
