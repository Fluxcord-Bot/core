import {
  Message as FluxerMessage,
  PermissionsBitField as FluxerPermissionsBitField,
} from "@fluxerjs/core";
import {
  PermissionsBitField as DiscordPermissionsBitField,
  AttachmentBuilder,
  ChannelType,
} from "discord.js";

/**
 * @type {import('../utils/CommandSchema.js').CommandSchema}
 */
const command = {
  name: "probe",
  description: "Probe all channels",
  requireElevated: true,
  requireOwner: false,
  async run(params, message, discordClient, fluxerClient) {
    let isFluxer = message instanceof FluxerMessage;
    /**
     * @type {import("discord.js").Collection<string, import("discord.js").GuildBasedChannel> | import("@fluxerjs/core").GuildChannel[]}
     */
    let channels;

    let processedChannels = [];

    if (isFluxer) {
      const fluxerGuild = await fluxerClient.guilds.fetch(message.guildId);
      const fluxerUser = await fluxerGuild.members.fetchMe();
      channels = await fluxerGuild.fetchChannels();

      for (const channel of channels) {
        if (
          channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildVoice
        )
          continue;
        const perms = fluxerUser.permissionsIn(channel);

        processedChannels.push({
          name: channel.name,
          id: channel.id,
          perms: new FluxerPermissionsBitField(perms).toArray(),
        });
      }
    } else {
      const discordGuild = await discordClient.guilds.fetch(message.guild.id);
      const discordUser = await discordGuild.members.fetchMe();
      channels = discordGuild.channels.cache;

      for (const channel of channels) {
        if (
          channel[1].type !== ChannelType.GuildText &&
          channel[1].type !== ChannelType.GuildVoice
        )
          continue;
        const perms = discordUser.permissionsIn(channel[1]);
        processedChannels.push({
          name: channel[1].name,
          id: channel[1].id,
          perms: new DiscordPermissionsBitField(perms).toArray(),
        });
      }
    }

    const str = processedChannels
      .map((x) => `#${x.name} (${x.id}): ${x.perms.join(", ")}`)
      .join("\n");

    const strBuf = Buffer.from(str, "utf-8");

    if (message instanceof FluxerMessage) {
      await message.reply({ files: [{ name: "probed.txt", data: strBuf }] });
    } else {
      await message.reply({
        files: [new AttachmentBuilder(strBuf).setName("probed.txt")],
      });
    }
  },
};

export default command;
