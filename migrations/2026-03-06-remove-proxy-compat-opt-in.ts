import { DataTypes, QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.removeColumn("UserConfigs", "proxyCompatibility");
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.addColumn("UserConfigs", "proxyCompatibility", {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
}
