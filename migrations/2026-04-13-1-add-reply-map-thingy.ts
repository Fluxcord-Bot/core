import { DataTypes, QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.addColumn("MessageMaps", "discordReplyId", {
    type: DataTypes.STRING,
    allowNull: true,
  });
  await queryInterface.addColumn("MessageMaps", "fluxerReplyId", {
    type: DataTypes.STRING,
    allowNull: true,
  });
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.removeColumn("MessageMaps", "discordReplyId");
  await queryInterface.removeColumn("MessageMaps", "fluxerReplyId");
}
