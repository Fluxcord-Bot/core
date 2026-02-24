import { DataTypes, QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.addColumn("ChannelMaps", "errorLoggingChannelId", {
    type: DataTypes.STRING,
    allowNull: true,
  });
  await queryInterface.addColumn("ChannelMaps", "errorLoggingPlatform", {
    type: DataTypes.ENUM("fluxer", "discord"),
    allowNull: true,
  });
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.removeColumn("ChannelMaps", "errorLoggingChannelId");
  await queryInterface.removeColumn("ChannelMaps", "errorLoggingPlatform");
}
