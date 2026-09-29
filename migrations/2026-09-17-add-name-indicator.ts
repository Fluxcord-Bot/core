import { DataTypes, QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.addColumn("GuildMaps", "nameIndicator", {
    type: DataTypes.ENUM("off", "full", "short"),
    allowNull: false,
    defaultValue: "off",
  });
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.removeColumn("GuildMaps", "nameIndicator");
}
