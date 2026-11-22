import { QueryInterface, QueryTypes } from "sequelize";

type EndpointRow = { id: number; groupId: number; parentId: number | null };

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  const sequelize = queryInterface.sequelize;

  const endpoints = (await sequelize.query(
    `SELECT id, "BridgeGroupId" AS "groupId", "ParentBridgeEndpointId" AS "parentId", kind FROM "BridgeEndpoints"`,
    { type: QueryTypes.SELECT }
  )) as (EndpointRow & { kind: string })[];
  if (endpoints.length === 0) return;

  const threadRows = endpoints.filter(row => row.kind === "thread");
  if (threadRows.length === 0) return;

  const threadIds = new Set(threadRows.map(row => Number(row.id)));
  const currentGroup = new Map(endpoints.map(row => [Number(row.id), Number(row.groupId)]));
  const parentId = new Map(threadRows.map(row => [Number(row.id), row.parentId == null ? null : Number(row.parentId)]));

  const parentOf = new Map<number, number>();
  for (const id of threadIds) parentOf.set(id, id);
  const find = (id: number): number => {
    let root = id;
    while (parentOf.get(root) !== root) root = parentOf.get(root) as number;
    let cur = id;
    while (parentOf.get(cur) !== root) {
      const next = parentOf.get(cur) as number;
      parentOf.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parentOf.set(rb, ra);
  };

  const starterRows = (await sequelize.query(
    `SELECT ml."linkGroup" AS "linkGroup", be.id AS id
     FROM "MessageLinks" ml
     JOIN "BridgeEndpoints" be ON be.id = ml."BridgeEndpointId"
     WHERE be.kind = 'thread' AND ml."messageId" = be."channelId"`,
    { type: QueryTypes.SELECT }
  )) as { linkGroup: string; id: number }[];

  const byLinkGroup = new Map<string, number[]>();
  for (const row of starterRows) {
    const id = Number(row.id);
    if (!threadIds.has(id)) continue;
    const list = byLinkGroup.get(row.linkGroup) ?? [];
    list.push(id);
    byLinkGroup.set(row.linkGroup, list);
  }
  for (const list of byLinkGroup.values()) {
    for (let i = 1; i < list.length; i++) union(list[0]!, list[i]!);
  }

  const groupMembers = new Map<number, number[]>();
  const groupKinds = new Map<number, Set<string>>();
  for (const row of endpoints) {
    const id = Number(row.id);
    const groupId = Number(row.groupId);
    const members = groupMembers.get(groupId) ?? [];
    members.push(id);
    groupMembers.set(groupId, members);
    const kinds = groupKinds.get(groupId) ?? new Set<string>();
    kinds.add(row.kind);
    groupKinds.set(groupId, kinds);
  }
  const threadOnlyGroup = (groupId: number) => {
    const kinds = groupKinds.get(groupId);
    return Boolean(kinds && kinds.size === 1 && kinds.has("thread"));
  };
  for (const [groupId, members] of groupMembers) {
    if (!threadOnlyGroup(groupId)) continue;
    const threadMembers = members.filter(id => threadIds.has(id));
    for (let i = 1; i < threadMembers.length; i++) union(threadMembers[0]!, threadMembers[i]!);
  }

  const groupRows = (await sequelize.query(`SELECT id, "bridgeType" FROM "BridgeGroups"`, {
    type: QueryTypes.SELECT,
  })) as { id: number; bridgeType: string }[];
  const groupType = new Map(groupRows.map(row => [Number(row.id), row.bridgeType]));

  const typeFor = (ids: number[]) => {
    for (const id of ids) {
      const groupId = currentGroup.get(id);
      if (groupId != null && threadOnlyGroup(groupId) && groupType.has(groupId)) return groupType.get(groupId) as string;
    }
    for (const id of ids) {
      const pid = parentId.get(id);
      const groupId = pid != null ? currentGroup.get(pid) : null;
      if (groupId != null && groupType.has(groupId)) return groupType.get(groupId) as string;
    }
    return "both";
  };

  const roots = new Map<number, number[]>();
  for (const id of threadIds) {
    const root = find(id);
    const list = roots.get(root) ?? [];
    list.push(id);
    roots.set(root, list);
  }

  type Assignment = { ids: number[]; bridgeType: string };
  const assignments: Assignment[] = [];
  for (const ids of roots.values()) {
    if (ids.length > 1) {
      const groups = new Set(ids.map(id => currentGroup.get(id)));
      if (groups.size === 1) {
        const onlyGroup = [...groups][0];
        if (onlyGroup != null && threadOnlyGroup(onlyGroup)) continue;
      }
      assignments.push({ ids, bridgeType: typeFor(ids) });
      continue;
    }
    const id = ids[0]!;
    const groupId = currentGroup.get(id);
    if (groupId != null && threadOnlyGroup(groupId)) continue;
    assignments.push({ ids, bridgeType: typeFor(ids) });
  }
  if (assignments.length === 0) return;

  const now = new Date();
  const groupRowsToInsert = assignments.map(assignment => ({
    bridgeType: assignment.bridgeType,
    createdAt: now,
    updatedAt: now,
  }));
  for (let start = 0; start < groupRowsToInsert.length; start += 200) {
    await queryInterface.bulkInsert("BridgeGroups", groupRowsToInsert.slice(start, start + 200));
  }

  const maxRows = (await sequelize.query(
    `SELECT COALESCE(MAX(id), 0) AS "maxId" FROM "BridgeGroups"`,
    { type: QueryTypes.SELECT }
  )) as { maxId: number }[];
  const maxId = Number(maxRows[0]?.maxId ?? 0);
  const newGroups = (await sequelize.query(
    `SELECT id FROM "BridgeGroups" WHERE id <= :maxId ORDER BY id DESC LIMIT :count`,
    { replacements: { maxId, count: assignments.length }, type: QueryTypes.SELECT }
  )) as { id: number }[];
  const newIds = newGroups.map(row => Number(row.id)).reverse();
  if (newIds.length !== assignments.length) {
    throw new Error(`Thread group migration expected ${assignments.length} new groups but created ${newIds.length}`);
  }

  for (let i = 0; i < assignments.length; i++) {
    const groupId = newIds[i]!;
    const ids = assignments[i]!.ids;
    for (let start = 0; start < ids.length; start += 500) {
      const chunk = ids.slice(start, start + 500);
      await sequelize.query(`UPDATE "BridgeEndpoints" SET "BridgeGroupId" = :groupId WHERE id IN (:ids)`, {
        replacements: { groupId, ids: chunk },
      });
    }
  }

  await sequelize.query(
    `DELETE FROM "BridgeGroups" WHERE id NOT IN (SELECT DISTINCT "BridgeGroupId" FROM "BridgeEndpoints" WHERE "BridgeGroupId" IS NOT NULL)`
  );
}
