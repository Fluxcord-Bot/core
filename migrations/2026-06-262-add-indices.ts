import { DataTypes, QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.addIndex("ChannelMaps", ["discordChannelId"]);
  await queryInterface.addIndex("ChannelMaps", ["fluxerChannelId"]);

  await queryInterface.addIndex("MessageMaps", ["discordMessageId"]);
  await queryInterface.addIndex("MessageMaps", ["fluxerMessageId"]);
  await queryInterface.addIndex("MessageMaps", ["ChannelMapId"]);
  await queryInterface.addIndex("MessageMaps", ["discordReplyId"]);
  await queryInterface.addIndex("MessageMaps", ["fluxerReplyId"]);

  await queryInterface.addIndex("GuildMaps", ["guildId", "guildType"]);
  await queryInterface.addIndex("UserConfigs", ["userId", "userType"]);

  await queryInterface.addIndex("VoiceChannelMaps", ["discordChannelId"]);
  await queryInterface.addIndex("VoiceChannelMaps", ["fluxerChannelId"]);

  await queryInterface.sequelize.query("ANALYZE;");
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.removeIndex("ChannelMaps", ["discordChannelId"]);
  await queryInterface.removeIndex("ChannelMaps", ["fluxerChannelId"]);
  await queryInterface.removeIndex("MessageMaps", ["discordMessageId"]);
  await queryInterface.removeIndex("MessageMaps", ["fluxerMessageId"]);
  await queryInterface.removeIndex("MessageMaps", ["ChannelMapId"]);
  await queryInterface.removeIndex("MessageMaps", ["discordReplyId"]);
  await queryInterface.removeIndex("MessageMaps", ["fluxerReplyId"]);
  await queryInterface.removeIndex("GuildMaps", ["guildId", "guildType"]);
  await queryInterface.removeIndex("UserConfigs", ["userId", "userType"]);
  await queryInterface.removeIndex("VoiceChannelMaps", ["discordChannelId"]);
  await queryInterface.removeIndex("VoiceChannelMaps", ["fluxerChannelId"]);

  await queryInterface.sequelize.query("ANALYZE;");
}
