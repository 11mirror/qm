import { likeEscape } from "../persistence/like.ts";
import { createHash } from "node:crypto";
import { createPgPool, type PgPool, type PoolClient, withPgTransaction, tenantCols } from "../persistence/pg-pool.ts";
import type { PrincipalType } from "../types.ts";
import { foldPrincipalId, rosterIds } from "./person.ts";
import {
  MAX_CANDIDATES,
  groupParticipantsKey,
  normDirectoryQuery,
  type ChannelMembership,
  type DirectoryChannel,
  type DirectoryMember,
  type DirectoryStore,
} from "./directory-store.ts";
import { tenant } from "../tenant.ts";

function memberRow(r: Record<string, unknown>): DirectoryMember {
  return {
    principalId: r.principal_id as string,
    displayName: r.display_name as string,
    type: r.type as PrincipalType,
    ...(r.slack_id ? { slackId: r.slack_id as string } : {}),
    ...(r.avatar_url ? { avatarUrl: r.avatar_url as string } : {}),
  };
}
const MEMBER_COLS = "principal_id, display_name, type, slack_id, avatar_url";
function channelRow(r: Record<string, unknown>): DirectoryChannel {
  return {
    channelId: r.channel_id as string,
    name: r.name as string,
    isPrivate: r.is_private as boolean,
    ...(r.is_external ? { isExternal: true } : {}),
  };
}

function hashRoster(rows: string[]): string {
  return createHash("sha256").update(rows.slice().sort().join("\n")).digest("hex");
}

function dedupPairs<T>(rows: T[], idOf: (r: T) => string, pidOf: (r: T) => string): T[] {
  const seen = new Map<string, Set<string>>();
  const out: T[] = [];
  for (const r of rows) {
    const id = idOf(r);
    const pid = pidOf(r);
    if (!id || !pid) continue;
    let principals = seen.get(id);
    if (!principals) seen.set(id, (principals = new Set()));
    if (!principals.has(pid)) {
      principals.add(pid);
      out.push(r);
    }
  }
  return out;
}
function dedupMemberships(rows: ChannelMembership[]): ChannelMembership[] {
  return dedupPairs(
    rows,
    (m) => m.channelId,
    (m) => m.principalId,
  );
}

async function pick<T>(
  q: PgPool["q"],
  query: string,
  table: string,
  idCol: string,
  labelLcCol: string,
  cols: string,
  map: (r: Record<string, unknown>) => T,
): Promise<{ kind: "one"; item: T } | { kind: "ambiguous"; items: T[] } | { kind: "none" }> {
  const qn = normDirectoryQuery(query);
  if (!qn) return { kind: "none" };
  const from = `FROM ${table} WHERE org_id = $1`;

  const byId = await q(`SELECT ${cols} ${from} AND lower(${idCol}) = $2 LIMIT 1`, [tenant().orgId, qn]);
  if (byId.length) return { kind: "one", item: map(byId[0]!) };

  const exact = await q(`SELECT ${cols} ${from} AND ${labelLcCol} = $2 ORDER BY ${idCol} LIMIT ${MAX_CANDIDATES + 1}`, [
    tenant().orgId,
    qn,
  ]);
  if (exact.length === 1) return { kind: "one", item: map(exact[0]!) };
  if (exact.length > 1) return { kind: "ambiguous", items: exact.slice(0, MAX_CANDIDATES).map(map) };

  const esc = likeEscape(qn);
  for (const pattern of [`${esc}%`, `%${esc}%`]) {
    const rows = await q(
      `SELECT ${cols} ${from} AND ${labelLcCol} LIKE $2 ESCAPE '\\' ORDER BY ${labelLcCol}, ${idCol} LIMIT ${MAX_CANDIDATES + 1}`,
      [tenant().orgId, pattern],
    );
    if (rows.length === 1) return { kind: "one", item: map(rows[0]!) };
    if (rows.length > 1) return { kind: "ambiguous", items: rows.slice(0, MAX_CANDIDATES).map(map) };
  }
  return { kind: "none" };
}

async function swapIfChanged(
  pool: PgPool["pool"],
  hashCol: string,
  hash: string,
  syncedAt: number | undefined,
  write: (client: PoolClient) => Promise<boolean | void>,
  partial = false,
): Promise<boolean> {
  const syncedAtCol = hashCol.replace(/_hash$/, "_synced_at");
  return withPgTransaction(await pool(), async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('directory'), hashtext($1))", [tenant().orgId]);
    const sync = await client.query(`SELECT ${hashCol}, ${syncedAtCol} FROM directory_sync WHERE org_id = $1`, [
      tenant().orgId,
    ]);
    const row = sync.rows[0];
    if (
      syncedAt !== undefined &&
      row?.[syncedAtCol] != null &&
      (partial ? Number(row[syncedAtCol]) >= syncedAt : Number(row[syncedAtCol]) > syncedAt)
    ) {
      console.warn(
        `[directory] refused stale ${hashCol.replace(/_hash$/, "")} swap for ${tenant().orgId}: stamped ${Number(row[syncedAtCol]) - syncedAt}ms behind`,
      );
      return false;
    }
    if (!partial && row?.[hashCol] === hash) {
      if (syncedAt !== undefined) {
        await client.query(
          `UPDATE directory_sync SET ${syncedAtCol} = GREATEST(COALESCE(${syncedAtCol}, 0), $2) WHERE org_id = $1`,
          [tenant().orgId, syncedAt],
        );
      }
      return true;
    }
    const complete = await write(client);
    if (partial && complete === false) return false;
    await client.query(
      `INSERT INTO directory_sync (org_id, ${hashCol}, ${syncedAtCol}, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (${tenantCols("org_id")}) DO UPDATE SET ${hashCol} = EXCLUDED.${hashCol},
         ${syncedAtCol} = COALESCE(EXCLUDED.${syncedAtCol}, directory_sync.${syncedAtCol}),
         updated_at = EXCLUDED.updated_at`,
      [tenant().orgId, partial || complete === false ? null : hash, partial ? null : (syncedAt ?? null), Date.now()],
    );
    return true;
  });
}

function directoryRosterWrites(db: Pick<PgPool, "q" | "pool">) {
  const { pool } = db;
  return {
    async replace(members, syncedAt) {
      const byId = new Map<string, DirectoryMember>();
      for (const m of members) if (m.principalId && m.type === "internal") byId.set(m.principalId, m);
      const internal = [...byId.values()];

      const hash = hashRoster(
        internal.map((m) => `${m.principalId}|${m.displayName}|${m.type}|${m.slackId ?? ""}|${m.avatarUrl ?? ""}`),
      );

      return swapIfChanged(pool, "members_hash", hash, syncedAt, async (client) => {
        await client.query("DELETE FROM directory_members WHERE org_id = $1", [tenant().orgId]);
        if (internal.length) {
          await client.query(
            `INSERT INTO directory_members (org_id, principal_id, display_name, display_name_lc, type, slack_id, avatar_url)
             SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])`,
            [
              tenant().orgId,
              internal.map((m) => m.principalId),
              internal.map((m) => m.displayName),
              internal.map((m) => normDirectoryQuery(m.displayName)),
              internal.map((m) => m.type),
              internal.map((m) => m.slackId ?? null),
              internal.map((m) => m.avatarUrl ?? null),
            ],
          );
        }
      });
    },

    async replaceChannels(channels, channelMembers, syncedAt, channelRosterIds, revocations = [], partial = false) {
      if (partial && (syncedAt === undefined || !Number.isFinite(syncedAt) || channelMembers === undefined))
        return false;
      const byId = new Map<string, DirectoryChannel>();
      for (const c of channels) if (c.channelId && c.name) byId.set(c.channelId, c);
      let list = [...byId.values()];
      const listedIds = new Set(list.map((channel) => channel.channelId));

      let rosterIds =
        channelMembers === undefined
          ? undefined
          : new Set((channelRosterIds ?? [...listedIds]).filter((channelId) => listedIds.has(channelId)));
      let membershipRows =
        channelMembers === undefined
          ? undefined
          : dedupMemberships(channelMembers).filter((member) => rosterIds!.has(member.channelId));
      let revokedRows = dedupMemberships(revocations).filter((member) => listedIds.has(member.channelId));
      const channelsPart = list.map((c) => `${c.channelId}|${c.name}|${c.isPrivate ? 1 : 0}|${c.isExternal ? 1 : 0}`);
      const membersPart =
        membershipRows === undefined
          ? []
          : [
              ...[...rosterIds!].map((channelId) => `r:${channelId}`),
              ...membershipRows.map((m) => `m:${m.channelId}|${m.principalId}`),
              ...revokedRows.map((m) => `x:${m.channelId}|${m.principalId}`),
            ];
      const hash = hashRoster([...channelsPart, ...membersPart]);

      const applied = await swapIfChanged(
        pool,
        "channels_hash",
        hash,
        syncedAt,
        async (client) => {
          const protectedRows = await client.query(
            "SELECT channel_id FROM directory_channels WHERE org_id = $1 AND (observed_at > $2 OR ($3 AND observed_at = $2))",
            [tenant().orgId, syncedAt ?? null, partial],
          );
          const protectedIds = new Set(protectedRows.rows.map((row) => row.channel_id as string));
          if (partial && list.some((channel) => protectedIds.has(channel.channelId))) return false;
          list = list.filter((channel) => !protectedIds.has(channel.channelId));
          rosterIds = rosterIds && new Set([...rosterIds].filter((id) => !protectedIds.has(id)));
          membershipRows = membershipRows?.filter((member) => !protectedIds.has(member.channelId));
          revokedRows = revokedRows.filter((member) => !protectedIds.has(member.channelId));
          const retainedIds = [...listedIds, ...protectedIds];
          const channelIds = list.map((channel) => channel.channelId);
          if (!partial) {
            await client.query(
              "DELETE FROM directory_channels WHERE org_id = $1 AND NOT (channel_id = ANY($2::text[]))",
              [tenant().orgId, retainedIds],
            );
            await client.query(
              "DELETE FROM directory_channel_members WHERE org_id = $1 AND NOT (channel_id = ANY($2::text[]))",
              [tenant().orgId, retainedIds],
            );
          }
          if (list.length) {
            await client.query(
              `INSERT INTO directory_channels (org_id, channel_id, name, name_lc, is_private, is_external, roster_known, observed_at)
             SELECT $1, rows.*, $8::bigint FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::boolean[], $7::boolean[]) AS rows
             ON CONFLICT (${tenantCols("org_id, channel_id")}) DO UPDATE SET
               name = EXCLUDED.name,
               name_lc = EXCLUDED.name_lc,
               is_private = EXCLUDED.is_private,
               is_external = EXCLUDED.is_external,
               roster_known = directory_channels.roster_known OR EXCLUDED.roster_known,
               observed_at = EXCLUDED.observed_at`,
              [
                tenant().orgId,
                channelIds,
                list.map((c) => c.name),
                list.map((c) => normDirectoryQuery(c.name)),
                list.map((c) => !!c.isPrivate),
                list.map((c) => !!c.isExternal),
                list.map((c) => rosterIds?.has(c.channelId) ?? false),
                partial ? syncedAt : null,
              ],
            );
          }
          if (membershipRows !== undefined) {
            await client.query(
              "DELETE FROM directory_channel_members WHERE org_id = $1 AND channel_id = ANY($2::text[])",
              [tenant().orgId, [...rosterIds!]],
            );
            if (membershipRows.length) {
              await client.query(
                `INSERT INTO directory_channel_members (org_id, channel_id, principal_id)
               SELECT $1, * FROM unnest($2::text[], $3::text[])`,
                [tenant().orgId, membershipRows.map((m) => m.channelId), membershipRows.map((m) => m.principalId)],
              );
            }
          }
          if (revokedRows.length) {
            await client.query(
              `DELETE FROM directory_channel_members member
             USING unnest($2::text[], $3::text[]) AS revoked(channel_id, principal_id)
             WHERE member.org_id = $1 AND member.channel_id = revoked.channel_id
               AND member.principal_id = revoked.principal_id`,
              [tenant().orgId, revokedRows.map((m) => m.channelId), revokedRows.map((m) => m.principalId)],
            );
          }
          return partial || protectedIds.size === 0;
        },
        partial,
      );
      return applied;
    },
  } satisfies Partial<DirectoryStore>;
}

function directoryChannelReads(db: Pick<PgPool, "q" | "pool">) {
  const { q } = db;
  return {
    async setWorkspaceUrl(url) {
      await q(
        `INSERT INTO directory_meta (org_id, workspace_url, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (${tenantCols("org_id")}) DO UPDATE SET workspace_url = EXCLUDED.workspace_url, updated_at = EXCLUDED.updated_at`,
        [tenant().orgId, url, Date.now()],
      );
    },

    async meta() {
      const rows = await q("SELECT workspace_url FROM directory_meta WHERE org_id = $1", [tenant().orgId]);
      return { workspaceUrl: (rows[0]?.workspace_url as string | null) ?? null };
    },

    async channelMember(channelId, principalId) {
      const rows = await q(
        `SELECT 1 FROM directory_channel_members member
         JOIN directory_channels channel USING (org_id, channel_id)
         WHERE member.org_id = $1 AND member.channel_id = $2 AND member.principal_id = ANY($3::text[])
           AND NOT (channel.is_private AND channel.is_external) LIMIT 1`,
        [tenant().orgId, channelId, rosterIds(principalId)],
      );
      return rows.length > 0;
    },

    async channelMemberIds(channelId) {
      const known = await q("SELECT roster_known FROM directory_channels WHERE org_id = $1 AND channel_id = $2", [
        tenant().orgId,
        channelId,
      ]);
      if (known[0]?.roster_known !== true) return undefined;
      const rows = await q(
        "SELECT principal_id FROM directory_channel_members WHERE org_id = $1 AND channel_id = $2 ORDER BY principal_id",
        [tenant().orgId, channelId],
      );
      return rows.map((row) => row.principal_id as string);
    },

    async channelMembership(channelId, principalId) {
      const rows = await q(
        `SELECT EXISTS (
           SELECT 1 FROM directory_channel_members
           WHERE org_id = $1 AND channel_id = $2 AND principal_id = ANY($3::text[])
         ) AS member,
         (SELECT is_private FROM directory_channels WHERE org_id = $1 AND channel_id = $2) AS is_private,
         (SELECT roster_known FROM directory_channels WHERE org_id = $1 AND channel_id = $2) AS roster_known`,
        [tenant().orgId, channelId, rosterIds(principalId)],
      );
      const member = rows[0]?.member === true;
      if (rows[0]?.roster_known !== true) return undefined;
      return member || rows[0]?.is_private === true ? member : undefined;
    },

    async channelPrivacy(channelId) {
      const rows = await q("SELECT is_private FROM directory_channels WHERE org_id = $1 AND channel_id = $2 LIMIT 1", [
        tenant().orgId,
        channelId,
      ]);
      return rows.length > 0 ? (rows[0]!.is_private as boolean) : undefined;
    },
  } satisfies Partial<DirectoryStore>;
}

function directoryGroups(db: Pick<PgPool, "q" | "pool">) {
  const { q, pool } = db;
  return {
    async replaceGroups(groupMembers, syncedAt, groupIds, groupRosterIds) {
      const allRows = dedupPairs(
        groupMembers,
        (m) => m.groupId,
        (m) => m.principalId,
      );
      const listedIds = [...new Set((groupIds ?? allRows.map((member) => member.groupId)).filter(Boolean))];
      const listed = new Set(listedIds);
      const rosterIds = [...new Set((groupRosterIds ?? listedIds).filter((groupId) => listed.has(groupId)))];
      const rostered = new Set(rosterIds);
      const rows = allRows.filter((member) => rostered.has(member.groupId));
      const hash = hashRoster([
        ...listedIds.map((groupId) => `g:${groupId}`),
        ...rosterIds.map((groupId) => `r:${groupId}`),
        ...rows.map((member) => `m:${member.groupId}|${member.principalId}`),
      ]);

      return swapIfChanged(pool, "groups_hash", hash, syncedAt, async (client) => {
        await client.query(
          "DELETE FROM directory_group_members WHERE org_id = $1 AND NOT (group_id = ANY($2::text[]))",
          [tenant().orgId, listedIds],
        );
        await client.query("DELETE FROM directory_groups WHERE org_id = $1 AND NOT (group_id = ANY($2::text[]))", [
          tenant().orgId,
          listedIds,
        ]);
        if (listedIds.length) {
          await client.query(
            `INSERT INTO directory_groups (org_id, group_id, roster_known)
             SELECT $1, * FROM unnest($2::text[], $3::boolean[])
             ON CONFLICT (${tenantCols("org_id, group_id")}) DO UPDATE SET
               roster_known = directory_groups.roster_known OR EXCLUDED.roster_known`,
            [tenant().orgId, listedIds, listedIds.map((groupId) => rostered.has(groupId))],
          );
        }
        await client.query("DELETE FROM directory_group_members WHERE org_id = $1 AND group_id = ANY($2::text[])", [
          tenant().orgId,
          rosterIds,
        ]);
        if (rows.length) {
          await client.query(
            `INSERT INTO directory_group_members (org_id, group_id, principal_id)
             SELECT $1, * FROM unnest($2::text[], $3::text[])`,
            [tenant().orgId, rows.map((m) => m.groupId), rows.map((m) => m.principalId)],
          );
        }
      });
    },

    async upsertGroup(groupId, principalIds) {
      const ids = [...new Set(principalIds.filter(Boolean))];
      if (!groupId || !ids.length) return;
      await withPgTransaction(await pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('directory'), hashtext($1))", [tenant().orgId]);
        await client.query(
          `INSERT INTO directory_groups (org_id, group_id, roster_known) VALUES ($1, $2, TRUE)
           ON CONFLICT (${tenantCols("org_id, group_id")}) DO UPDATE SET roster_known = TRUE`,
          [tenant().orgId, groupId],
        );
        await client.query("DELETE FROM directory_group_members WHERE org_id = $1 AND group_id = $2", [
          tenant().orgId,
          groupId,
        ]);
        await client.query(
          `INSERT INTO directory_group_members (org_id, group_id, principal_id)
           SELECT $1, $2, * FROM unnest($3::text[])`,
          [tenant().orgId, groupId, ids],
        );
        const all = await client.query("SELECT group_id, principal_id FROM directory_group_members WHERE org_id = $1", [
          tenant().orgId,
        ]);
        await client.query(
          `INSERT INTO directory_sync (org_id, groups_hash, groups_synced_at, updated_at) VALUES ($1, $2, $3, $3)
           ON CONFLICT (${tenantCols("org_id")}) DO UPDATE SET groups_hash = EXCLUDED.groups_hash,
             groups_synced_at = GREATEST(COALESCE(directory_sync.groups_synced_at, 0), EXCLUDED.groups_synced_at),
             updated_at = EXCLUDED.updated_at`,
          [tenant().orgId, hashRoster(all.rows.map((r) => `${r.group_id}|${r.principal_id}`)), Date.now()],
        );
      });
    },

    async resolveGroupByParticipants(participants) {
      const key = groupParticipantsKey(participants);
      if (!key) return { kind: "none" };
      const rows = await q(
        `SELECT group_id FROM directory_group_members
         WHERE org_id = $1
         GROUP BY group_id
         HAVING string_agg(DISTINCT principal_id, ',' ORDER BY principal_id) = $2
         LIMIT 1`,
        [tenant().orgId, key],
      );
      return rows.length ? { kind: "one", groupId: rows[0]!.group_id as string } : { kind: "none" };
    },

    async groupMember(groupId, principalId) {
      const rows = await q(
        "SELECT 1 FROM directory_group_members WHERE org_id = $1 AND group_id = $2 AND principal_id = ANY($3::text[]) LIMIT 1",
        [tenant().orgId, groupId, rosterIds(principalId)],
      );
      return rows.length > 0;
    },

    async groupMembership(groupId, principalId) {
      const rows = await q(
        `SELECT EXISTS (
           SELECT 1 FROM directory_group_members
           WHERE org_id = $1 AND group_id = $2 AND principal_id = ANY($3::text[])
         ) AS member,
         EXISTS (
           SELECT 1 FROM directory_groups WHERE org_id = $1 AND group_id = $2
         ) AS listed,
         COALESCE((
           SELECT roster_known FROM directory_groups WHERE org_id = $1 AND group_id = $2
         ), FALSE) AS roster_known,
         EXISTS (
           SELECT 1 FROM directory_sync WHERE org_id = $1 AND groups_hash IS NOT NULL
         ) AS synced`,
        [tenant().orgId, groupId, rosterIds(principalId)],
      );
      if (rows[0]?.member === true) return true;
      if (rows[0]?.listed !== true) return rows[0]?.synced === true ? false : undefined;
      return rows[0]?.roster_known === true ? rows[0]?.member === true : undefined;
    },

    async listGroupsFor(principalId) {
      const rows = await q(
        "SELECT DISTINCT group_id FROM directory_group_members WHERE org_id = $1 AND principal_id = ANY($2::text[]) ORDER BY group_id",
        [tenant().orgId, rosterIds(principalId)],
      );
      return rows.map((row) => row.group_id as string);
    },
  } satisfies Partial<DirectoryStore>;
}

function directoryLookups(db: Pick<PgPool, "q" | "pool">) {
  const { q } = db;
  return {
    async conversationMembers(kind, id) {
      const rows =
        kind === "channel"
          ? await q(
              `SELECT channel.roster_known, channel.is_external, roster.principal_id AS roster_principal_id,
                      member.principal_id, member.display_name, member.type, member.slack_id
               FROM directory_channels channel
               LEFT JOIN directory_channel_members roster
                 ON roster.org_id = channel.org_id AND roster.channel_id = channel.channel_id
               LEFT JOIN directory_members member
                 ON member.org_id = roster.org_id AND member.principal_id = roster.principal_id
               WHERE channel.org_id = $1 AND channel.channel_id = $2
               ORDER BY roster.principal_id`,
              [tenant().orgId, id],
            )
          : await q(
              `SELECT group_row.roster_known, FALSE AS is_external, roster.principal_id AS roster_principal_id,
                      member.principal_id, member.display_name, member.type, member.slack_id
               FROM directory_groups group_row
               LEFT JOIN directory_group_members roster
                 ON roster.org_id = group_row.org_id AND roster.group_id = group_row.group_id
               LEFT JOIN directory_members member
                 ON member.org_id = roster.org_id AND member.principal_id = roster.principal_id
               WHERE group_row.org_id = $1 AND group_row.group_id = $2
               ORDER BY roster.principal_id`,
              [tenant().orgId, id],
            );
      if (!rows.length || rows[0]?.roster_known !== true || rows[0]?.is_external === true) return undefined;
      if (rows.some((row) => !row.roster_principal_id || !row.principal_id)) return undefined;
      return rows.map(memberRow);
    },

    async listChannelsFor(principalId) {
      const rows = await q(
        `SELECT channel_id, name, is_private, is_external FROM directory_channels c
         WHERE org_id = $1 AND (is_private = FALSE OR (is_external = FALSE AND EXISTS (
           SELECT 1 FROM directory_channel_members m
           WHERE m.org_id = c.org_id AND m.channel_id = c.channel_id AND m.principal_id = ANY($2::text[]))))
         ORDER BY name_lc`,
        [tenant().orgId, rosterIds(principalId)],
      );
      return rows.map(channelRow);
    },

    async list() {
      const rows = await q(`SELECT ${MEMBER_COLS} FROM directory_members WHERE org_id = $1`, [tenant().orgId]);
      return rows.map(memberRow);
    },

    async listChannels() {
      const rows = await q(
        "SELECT channel_id, name, is_private, is_external FROM directory_channels WHERE org_id = $1",
        [tenant().orgId],
      );
      return rows.map(channelRow);
    },

    async get(principalId) {
      const key = foldPrincipalId(principalId);
      const rows = await q(
        `SELECT ${MEMBER_COLS} FROM directory_members
         WHERE org_id = $1 AND (principal_id = $2 OR ($3 AND lower(principal_id) = $4))
         ORDER BY (principal_id = $2) DESC LIMIT 1`,
        [tenant().orgId, principalId, key.includes("@"), key],
      );
      return rows.length ? memberRow(rows[0]!) : null;
    },

    async getBySlackId(slackId) {
      const rows = await q(
        `SELECT ${MEMBER_COLS} FROM directory_members
         WHERE org_id = $1 AND (slack_id = $2 OR (slack_id IS NULL AND principal_id = $2)) LIMIT 1`,
        [tenant().orgId, slackId],
      );
      return rows.length ? memberRow(rows[0]!) : null;
    },

    async resolve(query) {
      const bySlackId = await q(
        `SELECT ${MEMBER_COLS} FROM directory_members WHERE org_id = $1 AND slack_id = $2 LIMIT 1`,
        [tenant().orgId, query.trim()],
      );
      if (bySlackId.length) return { kind: "one", member: memberRow(bySlackId[0]!) };
      const m = await pick(q, query, "directory_members", "principal_id", "display_name_lc", MEMBER_COLS, memberRow);
      if (m.kind === "one") return { kind: "one", member: m.item };
      if (m.kind === "ambiguous") return { kind: "ambiguous", candidates: m.items };
      return { kind: "none" };
    },

    async resolveChannel(query) {
      const m = await pick(
        q,
        query,
        "directory_channels",
        "channel_id",
        "name_lc",
        "channel_id, name, is_private, is_external",
        channelRow,
      );
      if (m.kind === "one") return { kind: "one", channel: m.item };
      if (m.kind === "ambiguous") return { kind: "ambiguous", candidates: m.items };
      return { kind: "none" };
    },
  } satisfies Partial<DirectoryStore>;
}

export function createPostgresDirectoryStore(connectionString: string): DirectoryStore {
  const db = createPgPool(connectionString, []);
  return {
    ...directoryRosterWrites(db),
    ...directoryChannelReads(db),
    ...directoryGroups(db),
    ...directoryLookups(db),
  };
}
