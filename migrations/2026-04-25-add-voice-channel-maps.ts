import { DataTypes, QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.createTable("VoiceChannelMaps", {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    discordGuildId: { type: DataTypes.STRING, allowNull: false },
    discordChannelId: { type: DataTypes.STRING, allowNull: false },
    fluxerGuildId: { type: DataTypes.STRING, allowNull: false },
    fluxerChannelId: { type: DataTypes.STRING, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.dropTable("VoiceChannelMaps");
}
