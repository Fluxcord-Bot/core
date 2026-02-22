import { DataTypes, QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.createTable("ChannelMaps", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    discordGuildId: { type: DataTypes.STRING, allowNull: false },
    discordChannelId: { type: DataTypes.STRING, allowNull: false },
    discordWebhookId: { type: DataTypes.STRING, allowNull: false },
    discordWebhookToken: { type: DataTypes.STRING, allowNull: false },
    fluxerGuildId: { type: DataTypes.STRING, allowNull: false },
    fluxerChannelId: { type: DataTypes.STRING, allowNull: false },
    fluxerWebhookId: { type: DataTypes.STRING, allowNull: false },
    fluxerWebhookToken: { type: DataTypes.STRING, allowNull: false },
    bridgeType: {
      type: DataTypes.ENUM("discord2fluxer", "fluxer2discord", "both"),
      allowNull: false,
      defaultValue: "both",
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.createTable("MessageMaps", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    messageSource: {
      type: DataTypes.ENUM("discord", "fluxer"),
      allowNull: false,
    },
    discordMessageId: { type: DataTypes.STRING, allowNull: false },
    fluxerMessageId: { type: DataTypes.STRING, allowNull: false },
    authorId: { type: DataTypes.STRING, allowNull: false },
    content: { type: DataTypes.STRING, allowNull: false },
    ChannelMapId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "ChannelMaps", key: "id" },
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.dropTable("MessageMaps");
  await queryInterface.dropTable("ChannelMaps");
}
