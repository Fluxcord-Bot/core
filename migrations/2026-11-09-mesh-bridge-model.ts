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

  const escape = (value: any) => queryInterface.sequelize.escape(value);
  const MAP_TABLE = "_MeshEndpointMigrationMap";
  const CHANNEL_BATCH = 200;
  const MESSAGE_BATCH = 5000;
  const INSERT_BATCH = 1000;

  if (!(await queryInterface.tableExists(MAP_TABLE))) {
    await queryInterface.createTable(MAP_TABLE, {
      oldChannelMapId: { type: DataTypes.INTEGER, primaryKey: true },
      discordEndpointId: { type: DataTypes.INTEGER, allowNull: true },
      fluxerEndpointId: { type: DataTypes.INTEGER, allowNull: true },
    } as any);
  }

  const now = new Date().toISOString().replace("T", " ").replace("Z", " +00:00");
  const endpointIdByOld = new Map<number, { discord?: number; fluxer?: number }>();
  const mapped = (await queryInterface.sequelize.query(`SELECT * FROM "${MAP_TABLE}"`, {
    type: QueryTypes.SELECT,
  })) as any[];
  for (const entry of mapped) {
    endpointIdByOld.set(Number(entry.oldChannelMapId), {
      discord: entry.discordEndpointId ?? undefined,
      fluxer: entry.fluxerEndpointId ?? undefined,
    });
  }

  let lastChannelId = 0;
  for (;;) {
    const oldRows = (await queryInterface.sequelize.query(
      `SELECT * FROM "ChannelMaps" WHERE id > ${lastChannelId} ORDER BY id ASC LIMIT ${CHANNEL_BATCH}`,
      { type: QueryTypes.SELECT }
    )) as any[];
    if (oldRows.length === 0) break;
    for (const row of oldRows) {
      lastChannelId = Number(row.id);
      if (endpointIdByOld.has(Number(row.id))) continue;
      await queryInterface.sequelize.transaction(async transaction => {
        const groupInserted = (await queryInterface.bulkInsert(
          "BridgeGroups",
          [{ bridgeType: row.bridgeType ?? "both", createdAt: now, updatedAt: now }],
          { returning: dialect === "postgres", transaction } as any
        )) as any;
        let groupId = Array.isArray(groupInserted) && groupInserted[0]?.id != null ? groupInserted[0].id : null;
        if (groupId == null) {
          const latest = (await queryInterface.sequelize.query(`SELECT id FROM "BridgeGroups" ORDER BY id DESC LIMIT 1`, {
            type: QueryTypes.SELECT,
            transaction,
          })) as any[];
          groupId = latest[0]?.id;
        }

        const tagMap = row.tagMap == null ? null : typeof row.tagMap === "string" ? row.tagMap : JSON.stringify(row.tagMap);
        const kind = row.parentChannelMapId ? "thread" : "channel";
        const inserted = (await queryInterface.bulkInsert(
          "BridgeEndpoints",
          [
            {
              platform: "discord",
              instanceId: "default",
              channelId: row.discordChannelId,
              guildId: row.discordGuildId,
              webhookId: row.discordWebhookId,
              webhookToken: row.discordWebhookToken,
              kind,
              autoMirrored: row.autoMirrored ?? false,
              tagMap,
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
              kind,
              autoMirrored: row.autoMirrored ?? false,
              tagMap,
              BridgeGroupId: groupId,
              ParentBridgeEndpointId: null,
              createdAt: now,
              updatedAt: now,
            },
          ],
          { returning: dialect === "postgres", transaction } as any
        )) as any;

        let discordEndpointId;
        let fluxerEndpointId;
        if (Array.isArray(inserted) && inserted.length === 2) {
          [discordEndpointId, fluxerEndpointId] = inserted.map((x: any) => x.id);
        } else {
          const latest = (await queryInterface.sequelize.query(
            `SELECT id, platform FROM "BridgeEndpoints" WHERE "BridgeGroupId" = ${escape(groupId)} ORDER BY id ASC`,
            { type: QueryTypes.SELECT, transaction }
          )) as any[];
          discordEndpointId = latest.find(x => x.platform === "discord")?.id;
          fluxerEndpointId = latest.find(x => x.platform === "fluxer")?.id;
        }

        await queryInterface.bulkInsert(MAP_TABLE, [{ oldChannelMapId: row.id, discordEndpointId, fluxerEndpointId }], {
          transaction,
        } as any);
        endpointIdByOld.set(Number(row.id), { discord: discordEndpointId, fluxer: fluxerEndpointId });
      });
    }
  }

  lastChannelId = 0;
  for (;;) {
    const oldRows = (await queryInterface.sequelize.query(
      `SELECT * FROM "ChannelMaps" WHERE id > ${lastChannelId} ORDER BY id ASC LIMIT ${CHANNEL_BATCH}`,
      { type: QueryTypes.SELECT }
    )) as any[];
    if (oldRows.length === 0) break;
    for (const row of oldRows) {
      lastChannelId = Number(row.id);
      if (!row.parentChannelMapId) continue;
      const parent = endpointIdByOld.get(Number(row.parentChannelMapId));
      const own = endpointIdByOld.get(Number(row.id));
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
  }

  let lastMessageId = 0;
  let copiedMessages = 0;
  for (;;) {
    const oldMessages = (await queryInterface.sequelize.query(
      `SELECT * FROM "MessageMaps" WHERE id > ${lastMessageId} ORDER BY id ASC LIMIT ${MESSAGE_BATCH}`,
      { type: QueryTypes.SELECT }
    )) as any[];
    if (oldMessages.length === 0) break;
    lastMessageId = Number(oldMessages[oldMessages.length - 1].id);

    const candidates = oldMessages.filter(msg => endpointIdByOld.has(Number(msg.ChannelMapId)));
    if (candidates.length === 0) continue;

    const messageIds: string[] = [];
    for (const msg of candidates) {
      if (msg.discordMessageId != null) messageIds.push(String(msg.discordMessageId));
      if (msg.fluxerMessageId != null) messageIds.push(String(msg.fluxerMessageId));
    }

    const alreadyLinked = new Set<string>();
    for (let i = 0; i < messageIds.length; i += INSERT_BATCH) {
      const inList = messageIds
        .slice(i, i + INSERT_BATCH)
        .map(id => escape(id))
        .join(",");
      if (!inList) continue;
      const rows = (await queryInterface.sequelize.query(
        `SELECT DISTINCT "messageId" FROM "MessageLinks" WHERE "messageId" IN (${inList})`,
        { type: QueryTypes.SELECT }
      )) as any[];
      for (const row of rows) {
        if (row.messageId != null) alreadyLinked.add(String(row.messageId));
      }
    }

    const linkRows: any[] = [];
    for (const msg of candidates) {
      if (msg.discordMessageId != null && alreadyLinked.has(String(msg.discordMessageId))) continue;
      if (msg.fluxerMessageId != null && alreadyLinked.has(String(msg.fluxerMessageId))) continue;
      const endpointIds = endpointIdByOld.get(Number(msg.ChannelMapId));
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

    for (let i = 0; i < linkRows.length; i += INSERT_BATCH) {
      await queryInterface.bulkInsert("MessageLinks", linkRows.slice(i, i + INSERT_BATCH));
    }
    copiedMessages += candidates.length;
    if (copiedMessages % 50000 < MESSAGE_BATCH) {
      console.log(`Mesh migration: copied ${copiedMessages} MessageMaps rows (up to id ${lastMessageId})`);
    }
  }

  await queryInterface.dropTable("MessageMaps");
  await queryInterface.dropTable("ChannelMaps");
  await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "${MAP_TABLE}"`);
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.dropTable("MessageLinks");
  await queryInterface.dropTable("BridgeEndpoints");
  await queryInterface.dropTable("BridgeGroups");
  await queryInterface.removeColumn("VoiceChannelMaps", "fluxerInstanceId");
  await queryInterface.removeColumn("GuildMaps", "fluxerInstanceId");
}
