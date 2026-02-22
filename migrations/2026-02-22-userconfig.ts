import { DataTypes, QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.createTable("UserConfigs", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userType: {
      type: DataTypes.ENUM("discord", "fluxer"),
      allowNull: false,
    },
    userId: { type: DataTypes.STRING, allowNull: false },
    proxyCompatibility: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    doNotBridgePrefix: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
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
  await queryInterface.dropTable("UserConfigs");
}
