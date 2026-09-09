import { DataTypes, QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.addColumn("GuildMaps", "typingEnabled", {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  });
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.removeColumn("GuildMaps", "typingEnabled");
}
