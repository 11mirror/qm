import type { PoolClient } from "../persistence/pg-pool.ts";
import { CONFIG_TABLES } from "../resolution/config-tables.ts";
import { foldPrincipalId } from "../directory/person.ts";
import { personalScope } from "../types.ts";

type RewriteKind = "principal" | "scope" | "thread";

interface Rewrite {
  table: string;
  column: string;
  kind: RewriteKind;
  field?: string;
  key?: readonly string[];
}

const principal = (table: string, column: string, key?: readonly string[]): Rewrite => ({
  table,
  column,
  kind: "principal",
  ...(key ? { key } : {}),
});
const scope = (table: string, column: string, key?: readonly string[]): Rewrite => ({
  table,
  column,
  kind: "scope",
  ...(key ? { key } : {}),
});
const thread = (table: string, column: string, opts: { field?: string; unique?: boolean } = {}): Rewrite => ({
  table,
  column,
  kind: "thread",
  ...(opts.field ? { field: opts.field } : {}),
  ...(opts.unique ? { key: [] } : {}),
});

const TRIGGER_TABLES = ["crons", "monitors", "webhooks"];

const PRINCIPAL_REWRITES: readonly Rewrite[] = [
  principal("participants", "principal_id", ["session_id"]),
  scope("sessions", "scope_id"),
  scope("memory_facts", "scope_id"),
  scope("memory_capture_pending", "scope_id"),
  scope("memory_capture_pending", "conversation_scope_id"),
  principal("memory_capture_pending", "actor_id"),
  scope("memory_tidy_profiles", "id", []),
  principal("suggested_activity_profiles", "id", []),
  ...TRIGGER_TABLES.flatMap((table) => [
    principal(table, "owner"),
    scope(table, "owner_scope_id"),
    principal(table, "created_by"),
  ]),
  scope("deployments", "owner_scope_id"),
  scope("deployments", "created_in_scope"),
  principal("deployments", "created_by"),
  scope("file_artifacts", "owner_scope_id"),
  scope("file_artifacts", "created_in_scope"),
  principal("file_artifacts", "created_by"),
  scope("acl_grants", "owner_scope_id", ["path", "grantee_scope_id", "permission"]),
  scope("acl_grants", "grantee_scope_id", ["owner_scope_id", "path", "permission"]),
  scope("skills", "scope_id"),
  principal("skills", "created_by"),
  scope("skill_packs", "target_scope_id"),
  principal("skill_packs", "created_by"),
  principal("slack_accounts", "principal_id", []),
  principal("browser_sessions", "principal_id", []),
  principal("environments", "owner_actor_id"),
  scope("environment_attachments", "scope_id", []),
  scope("sandbox_resources", "owner_scope_id"),
  principal("sandbox_resources", "created_by"),
  scope("sandbox_defaults", "scope_id", []),
  ...Object.values(CONFIG_TABLES)
    .filter((spec) => spec.key === "scopeId")
    .map((spec) => scope(spec.table, "scope_id", [])),
  thread("crons", "session_ref"),
  ...TRIGGER_TABLES.map((table) => thread(table, "destination", { field: "target" })),
  thread("monitors", "thread_ref"),
  thread("process_sessions", "session_ref"),
  thread("session_turn_pointers", "thread_ref", { unique: true }),
  thread("sessions", "thread_ref", { unique: true }),
];

function values(kind: RewriteKind, aliasId: string, canonicalId: string): [string, string] {
  if (kind === "scope") return [personalScope(aliasId), personalScope(canonicalId)];
  if (kind === "thread") return [`web:${aliasId}:`, `web:${canonicalId}:`];
  return [aliasId, canonicalId];
}

function statements(r: Rewrite): string[] {
  const current = r.field ? `moved.${r.column}->>'${r.field}'` : `moved.${r.column}`;
  const assign = (expr: string) =>
    r.field ? `${r.column} = jsonb_set(moved.${r.column}, '{${r.field}}', to_jsonb(${expr}))` : `${r.column} = ${expr}`;
  const update = `UPDATE ${r.table} AS moved SET`;
  if (r.kind === "thread") {
    const next = `($2::text || substr(${current}, length($1::text) + 1))`;
    const free = (table: string, column: string) =>
      `NOT EXISTS (SELECT 1 FROM ${table} kept WHERE kept.${column} = ${next})`;
    const open = [free("sessions", "thread_ref"), ...(r.key ? [free(r.table, r.column)] : [])];
    return [`${update} ${assign(next)} WHERE starts_with(${current}, $1::text) AND ${open.join(" AND ")}`];
  }
  const rewrite = `${update} ${assign("$2::text")} WHERE ${current} = $1::text`;
  if (!r.key) return [rewrite];
  const same = r.key.map((k) => ` AND kept.${k} IS NOT DISTINCT FROM moved.${k}`).join("");
  return [
    `DELETE FROM ${r.table} AS moved WHERE moved.${r.column} = $1::text
       AND EXISTS (SELECT 1 FROM ${r.table} kept WHERE kept.${r.column} = $2::text${same})`,
    rewrite,
  ];
}

export async function mergePrincipalData(client: PoolClient, aliasId: string, canonicalId: string): Promise<void> {
  const { rows } = await client.query<{ name: string }>(
    "SELECT table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema = current_schema()",
  );
  const present = new Set(rows.map((row) => row.name));
  const rewrites = PRINCIPAL_REWRITES.filter((r) =>
    [r.column, ...(r.key ?? [])].every((column) => present.has(`${r.table}.${column}`)),
  );
  for (const spelling of new Set([aliasId, foldPrincipalId(aliasId)]))
    for (const r of rewrites)
      for (const sql of statements(r)) await client.query(sql, values(r.kind, spelling, canonicalId));
}
