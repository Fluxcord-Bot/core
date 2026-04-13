import { DataTypes, QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.changeColumn("MessageMaps", "ChannelMapId", {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: "ChannelMaps", key: "id" },
    onDelete: "CASCADE",
    onUpdate: "CASCADE",
  });

  await queryInterface.changeColumn("ChannelMaps", "DiscordGuildMapId", {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: "GuildMaps", key: "id" },
    onDelete: "CASCADE",
    onUpdate: "CASCADE",
  });

  await queryInterface.changeColumn("ChannelMaps", "FluxerGuildMapId", {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: "GuildMaps", key: "id" },
    onDelete: "CASCADE",
    onUpdate: "CASCADE",
  });
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.changeColumn("MessageMaps", "ChannelMapId", {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: "ChannelMaps", key: "id" },
    onDelete: "SET NULL",
    onUpdate: "CASCADE",
  });

  await queryInterface.changeColumn("ChannelMaps", "DiscordGuildMapId", {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: "GuildMaps", key: "id" },
    onDelete: "NO ACTION",
    onUpdate: "NO ACTION",
  });

  await queryInterface.changeColumn("ChannelMaps", "FluxerGuildMapId", {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: "GuildMaps", key: "id" },
    onDelete: "NO ACTION",
    onUpdate: "NO ACTION",
  });
}