import { withFluxerRateLimit } from "./FluxerRateLimit.js";

export async function resolveChannelNsfw(client, channel) {
  if (typeof channel.nsfw === "boolean") return channel.nsfw;
  const isThread = typeof channel.isThread === "function" && channel.isThread();
  const id = isThread ? channel.parentId : channel.id;
  if (!id) return false;

  const isFluxer = typeof client.channels?.get === "function";
  if (isFluxer) {
    const cached = client.channels.get(id);
    if (typeof cached?.nsfw === "boolean") return cached.nsfw;
  }

  const request = () => client.rest.get(`/channels/${id}`);
  const data = isFluxer ? await withFluxerRateLimit(request, `channel:${id}`) : await request();
  return data.nsfw ?? false;
}
