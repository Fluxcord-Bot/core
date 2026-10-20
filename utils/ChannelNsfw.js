export async function resolveChannelNsfw(client, channel) {
  if (typeof channel.nsfw === "boolean") return channel.nsfw;
  const isThread = typeof channel.isThread === "function" && channel.isThread();
  const id = isThread ? channel.parentId : channel.id;
  if (!id) return false;
  const data = await client.rest.get(`/channels/${id}`);
  return data.nsfw ?? false;
}
