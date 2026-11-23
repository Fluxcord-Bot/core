import { QueryInterface } from "sequelize";

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.query(
    `UPDATE "BridgeEndpoints"
     SET "kind" = 'thread', "updatedAt" = CURRENT_TIMESTAMP
     WHERE "ParentBridgeEndpointId" IS NOT NULL AND "kind" = 'channel';`
  );
}

export async function down() {}
