import { DataTypes, QueryInterface, QueryTypes } from "sequelize";
import { randomUUID } from "node:crypto";

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  const dialect = queryInterface.sequelize.getDialect();

  const enumType = (name: string) =>
    dialect === "postgres" ? DataTypes.ENUM(name, "discord", "fluxer") : DataTypes.ENUM("discord", "fluxer");
  const kindType = (name: string) =>
    dialect === "postgres" ? DataTypes.ENUM(name, "channel", "thread") : DataTypes.ENUM("channel", "thread");
  const bridgeTypeType = (name: string) =>
    dialect === "postgres"
      ? DataTypes.ENUM(name, "discord2fluxer", "fluxer2discord", "both")
      : DataTypes.ENUM("discord2fluxer", "fluxer2discord", "both");

  const tableExists = (name: string) => queryInterface.tableExists(name);
  const columnExists = async (table: string, column: string) => {
    const desc = await queryInterface.describeTable(table);
    return Object.keys(desc).includes(column);
  };
  const indexExists = async (table: string, indexName: string) => {
    if (dialect === "postgres") {
      const [rows] = await queryInterface.sequelize.query(`SELECT 1 FROM pg_indexes WHERE indexname = '${indexName}'`);
      return rows.length > 0;
    }
    const [rows] = await queryInterface.sequelize.query(
      `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = '${indexName}'`
    );
    return rows.length > 0;
  };
  const addIndexIfMissing = async (table: string, fields: string[], name: string) => {
    if (await indexExists(table, name)) return;
    await queryInterface.addIndex(table, fields, { name });
  };

  if (!(await tableExists("BridgeGroups"))) {
    await queryInterface.createTable("BridgeGroups", {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      bridgeType: { type: bridgeTypeType("bridgeType"), allowNull: false, defaultValue: "both" },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
  }

  if (!(await tableExists("BridgeEndpoints"))) {
    await queryInterface.createTable("BridgeEndpoints", {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      platform: { type: enumType("platform"), allowNull: false },
      instanceId: { type: DataTypes.STRING, allowNull: false, defaultValue: "default" },
      channelId: { type: DataTypes.STRING, allowNull: false },
      guildId: { type: DataTypes.STRING, allowNull: false },
      webhookId: { type: DataTypes.STRING, allowNull: true },
      webhookToken: { type: DataTypes.STRING, allowNull: true },
      kind: { type: kindType("kind"), allowNull: false, defaultValue: "channel" },
      autoMirrored: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      tagMap: { type: DataTypes.JSON, allowNull: true },
      BridgeGroupId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: "BridgeGroups", key: "id" },
      },
      ParentBridgeEndpointId: { type: DataTypes.INTEGER, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
  }

  await addIndexIfMissing("BridgeEndpoints", ["platform", "channelId"], "bridge_endpoints_platform_channel_id");
  await addIndexIfMissing("BridgeEndpoints", ["BridgeGroupId"], "bridge_endpoints_bridge_group_id");
  await addIndexIfMissing("BridgeEndpoints", ["platform", "guildId"], "bridge_endpoints_platform_guild_id");

  if (!(await tableExists("MessageLinks"))) {
    await queryInterface.createTable("MessageLinks", {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      linkGroup: { type: DataTypes.STRING, allowNull: false },
      messageId: { type: DataTypes.STRING, allowNull: false },
      replyId: { type: DataTypes.STRING, allowNull: true },
      authorId: { type: DataTypes.STRING, allowNull: true },
      BridgeEndpointId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: "BridgeEndpoints", key: "id" },
      },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
  }

  await addIndexIfMissing("MessageLinks", ["BridgeEndpointId", "messageId"], "message_links_bridge_endpoint_id_message_id");
  await addIndexIfMissing("MessageLinks", ["linkGroup"], "message_links_link_group");
  await addIndexIfMissing("MessageLinks", ["messageId"], "message_links_message_id");

  if (!(await columnExists("VoiceChannelMaps", "fluxerInstanceId"))) {
    await queryInterface.addColumn("VoiceChannelMaps", "fluxerInstanceId", {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "default",
    });
  }
  if (!(await columnExists("GuildMaps", "fluxerInstanceId"))) {
    await queryInterface.addColumn("GuildMaps", "fluxerInstanceId", {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "default",
    });
  }

  const hasOldTables = await queryInterface.tableExists("ChannelMaps");
  if (!hasOldTables) return;

  const existingRows = (await queryInterface.sequelize.query(`SELECT COUNT(*) AS count FROM BridgeEndpoints`, {
    type: QueryTypes.SELECT,
  })) as any[];
  const existingEndpoints = existingRows[0]?.count ?? 0;
  if (existingEndpoints > 0) {
    console.log("BridgeEndpoints already populated, skipping data copy");
    return;
  }

  const now = new Date();
  const oldRows = (await queryInterface.sequelize.query(`SELECT * FROM ChannelMaps`, { type: QueryTypes.SELECT })) as any[];
  const oldMessages = (await queryInterface.sequelize.query(`SELECT * FROM MessageMaps`, { type: QueryTypes.SELECT })) as any[];

  // old ChannelMap id -> { discord: newEndpointId, fluxer: newEndpointId }
  const endpointIdByOld = new Map();

  for (const row of oldRows) {
    await queryInterface.bulkInsert("BridgeGroups", [{ bridgeType: row.bridgeType ?? "both", createdAt: now, updatedAt: now }], {
      returning: dialect === "postgres",
    } as any);
    const groupId = (
      (await queryInterface.sequelize.query(`SELECT id FROM BridgeGroups ORDER BY id DESC LIMIT 1`, {
        type: QueryTypes.SELECT,
      })) as any[]
    )[0].id;

    const inserted = await queryInterface.bulkInsert(
      "BridgeEndpoints",
      [
        {
          platform: "discord",
          instanceId: "default",
          channelId: row.discordChannelId,
          guildId: row.discordGuildId,
          webhookId: row.discordWebhookId,
          webhookToken: row.discordWebhookToken,
          kind: "channel",
          autoMirrored: row.autoMirrored ?? false,
          tagMap: row.tagMap ?? null,
          BridgeGroupId: groupId,
          ParentBridgeEndpointId: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          platform: "fluxer",
          instanceId: "default",
          channelId: row.fluxerChannelId,
          guildId: row.fluxerGuildId,
          webhookId: row.fluxerWebhookId,
          webhookToken: row.fluxerWebhookToken,
          kind: "channel",
          autoMirrored: row.autoMirrored ?? false,
          tagMap: row.tagMap ?? null,
          BridgeGroupId: groupId,
          ParentBridgeEndpointId: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      { returning: dialect === "postgres" } as any
    );

    let discordEndpointId;
    let fluxerEndpointId;
    if (Array.isArray(inserted) && inserted.length === 2) {
      [discordEndpointId, fluxerEndpointId] = inserted.map(x => x.id);
    } else {
      const latest = (await queryInterface.sequelize.query(
        `SELECT id, platform FROM BridgeEndpoints WHERE BridgeGroupId = ${groupId} ORDER BY id ASC`,
        { type: QueryTypes.SELECT }
      )) as any[];
      discordEndpointId = latest.find(x => x.platform === "discord")?.id;
      fluxerEndpointId = latest.find(x => x.platform === "fluxer")?.id;
    }

    endpointIdByOld.set(row.id, { discord: discordEndpointId, fluxer: fluxerEndpointId });
  }

  for (const row of oldRows) {
    if (!row.parentChannelMapId) continue;
    const parent = endpointIdByOld.get(row.parentChannelMapId);
    const own = endpointIdByOld.get(row.id);
    if (!parent || !own) continue;
    await queryInterface.bulkUpdate(
      "BridgeEndpoints",
      { ParentBridgeEndpointId: parent.discord, updatedAt: now },
      { id: own.discord }
    );
    await queryInterface.bulkUpdate(
      "BridgeEndpoints",
      { ParentBridgeEndpointId: parent.fluxer, updatedAt: now },
      { id: own.fluxer }
    );
  }

  const linkRows = [];
  for (const msg of oldMessages) {
    const endpointIds = endpointIdByOld.get(msg.ChannelMapId);
    if (!endpointIds) continue;
    const uuid = randomUUID();
    linkRows.push({
      linkGroup: uuid,
      messageId: msg.discordMessageId,
      replyId: msg.discordReplyId ?? null,
      authorId: msg.authorId ?? null,
      BridgeEndpointId: endpointIds.discord,
      createdAt: now,
      updatedAt: now,
    });
    linkRows.push({
      linkGroup: uuid,
      messageId: msg.fluxerMessageId,
      replyId: msg.fluxerReplyId ?? null,
      authorId: msg.authorId ?? null,
      BridgeEndpointId: endpointIds.fluxer,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (let i = 0; i < linkRows.length; i += 500) {
    await queryInterface.bulkInsert("MessageLinks", linkRows.slice(i, i + 500));
  }

  await queryInterface.dropTable("MessageMaps");
  await queryInterface.dropTable("ChannelMaps");
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.dropTable("MessageLinks");
  await queryInterface.dropTable("BridgeEndpoints");
  await queryInterface.dropTable("BridgeGroups");
  await queryInterface.removeColumn("VoiceChannelMaps", "fluxerInstanceId");
  await queryInterface.removeColumn("GuildMaps", "fluxerInstanceId");
}
