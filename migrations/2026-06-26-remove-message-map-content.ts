import { DataTypes, QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.removeColumn("MessageMaps", "content");
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.addColumn("MessageMaps", "content", {
    type: DataTypes.STRING,
    allowNull: false,
  });
}
