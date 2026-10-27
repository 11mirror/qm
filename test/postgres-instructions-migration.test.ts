import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the instructions migration test";
const exec = promisify(execFile);

async function withDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const parent = new pg.Pool({ connectionString: databaseUrl });
  const name = `instructions_${randomUUID().replaceAll("-", "")}`;
  await parent.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: url.toString() });
  try {
    await run(url.toString(), admin);
  } finally {
    await admin.end();
    await parent.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await parent.end();
  }
}

const migrate = (url: string) =>
  exec(process.execPath, ["src/migrate-main.ts"], {
    cwd: new URL("..", import.meta.url),
    timeout: 120_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: url,
      SANDBOX_BACKEND: "local",
      ORG_ID: "o",
      CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
    },
  });

const legacy = async (admin: pg.Pool, tenant: string | null) => {
  const tenantColumn = tenant ? "tenant_id UUID NOT NULL, " : "";
  const key = tenant ? "tenant_id, " : "";
  await admin.query(
    `CREATE TABLE soul_configs (${tenantColumn}id TEXT NOT NULL, json JSONB NOT NULL, PRIMARY KEY (${key}id))`,
  );
  await admin.query(`CREATE TABLE channel_policy (${tenantColumn}org_id TEXT NOT NULL, container TEXT NOT NULL,
    orders TEXT NOT NULL DEFAULT '', bots JSONB NOT NULL DEFAULT '{}'::jsonb, ambient_enabled BOOLEAN,
    set_by TEXT, updated_at BIGINT NOT NULL, PRIMARY KEY (${key}org_id, container))`);
  await admin.query(`CREATE TABLE channel_state (${tenantColumn}org_id TEXT NOT NULL, container TEXT NOT NULL,
    last_ts TEXT, oldest_ts TEXT, name TEXT, kind TEXT, members JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at BIGINT NOT NULL, PRIMARY KEY (${key}org_id, container))`);
  const values = (n: number) => Array.from({ length: n }, (_, i) => `$${i + 1 + (tenant ? 1 : 0)}`).join(", ");
  const insert = (table: string, columns: string, args: unknown[]) =>
    admin.query(
      `INSERT INTO ${table} (${key}${columns}) VALUES (${tenant ? "$1, " : ""}${values(args.length)})`,
      tenant ? [tenant, ...args] : args,
    );
  const revision = { scopeId: "channel:C1", content: "Be terse.", version: 2, updatedAt: 20, updatedBy: "U1" };
  await insert("soul_configs", "id, json", [
    "channel:C1",
    JSON.stringify({
      ...revision,
      history: [revision, { ...revision, content: "Be brief.", version: 1, updatedAt: 10 }],
    }),
  ]);
  const soul = (id: string, content: string, updatedBy?: string) =>
    insert("soul_configs", "id, json", [
      id,
      JSON.stringify({ scopeId: id, content, version: 1, updatedAt: 5, ...(updatedBy ? { updatedBy } : {}) }),
    ]);
  await soul("group:web-project-p2", "Project rules.");
  // What the retired 0002 left on a database it ran on: a web project's guidance under a channel scope.
  await soul("channel:web-project-p3", "Misfiled guidance.", "U6");
  await soul("group:web-project-p3", "Group rules.");
  await soul("channel:web-project-p4", "Lone misfiled guidance.", "U7");
  await insert("soul_configs", "id, json", [
    "channel:C3",
    JSON.stringify({ scopeId: "channel:C3", content: "Untouched.", version: 1, updatedAt: 5 }),
  ]);
  for (const [container, orders, setBy] of [
    ["C1", "Flag launch slips.", "U2"],
    ["C2", "Post a digest on Fridays.", null],
    ["G1", "Answer in Spanish.", "U3"],
    ["C3", "   ", "U4"],
    ["web-project-p1", "Use the project glossary.", "U5"],
    ["web-project-p2", "Ship on Fridays.", null],
  ])
    await insert("channel_policy", "org_id, container, orders, set_by, updated_at", ["o", container, orders, setBy, 1]);
  await insert("channel_state", "org_id, container, kind, updated_at", ["o", "G1", "group", 1]);
  await insert("channel_state", "org_id, container, kind, updated_at", ["o", "C1", "channel", 1]);
};

const instructions = async (admin: pg.Pool) =>
  Object.fromEntries(
    (await admin.query("SELECT id, json FROM soul_configs")).rows.map((r) => [r.id, r.json]),
  ) as Record<
    string,
    { content: string; version: number; updatedBy?: string; history: Array<{ content: string; version: number }> }
  >;

for (const tenant of [null, "6a1f6f62-3a52-4c6f-9a8e-0d7c8f6d2a11"]) {
  test(`channel guidance moves into the channel's instructions${tenant ? " per tenant" : ""}`, { skip }, async () => {
    await withDatabase(async (url, admin) => {
      // A fresh database gets the schema baseline; then put the three tables back in their pre-move shape and
      // rerun the move alone, as on a database that booted before it existed. The ledger also keeps a row for
      // the retired 0002, as on a database that ran it; boot must not trip over it.
      await migrate(url);
      await admin.query(
        "DELETE FROM qm_schema_migrations WHERE id = 'surface-cache/channel-policy/0003-orders-into-instructions'",
      );
      await admin.query(
        "INSERT INTO qm_schema_migrations (id, checksum) VALUES ('surface-cache/channel-policy/0002-orders-into-instructions', 'retired') ON CONFLICT DO NOTHING",
      );
      await admin.query("DROP TABLE soul_configs, channel_policy, channel_state CASCADE");
      await legacy(admin, tenant);
      await migrate(url);
      const rows = await instructions(admin);
      assert.equal(rows["channel:C1"]!.content, "Be terse.\n\n---\n\nFlag launch slips.");
      assert.equal(rows["channel:C1"]!.version, 3);
      assert.equal(rows["channel:C1"]!.updatedBy, "U2");
      assert.deepEqual(
        rows["channel:C1"]!.history.map((r) => [r.version, r.content]),
        [
          [3, "Be terse.\n\n---\n\nFlag launch slips."],
          [2, "Be terse."],
          [1, "Be brief."],
        ],
      );
      assert.equal(rows["channel:C2"]!.content, "Post a digest on Fridays.");
      assert.equal(rows["channel:C2"]!.version, 1);
      assert.equal(rows["channel:C2"]!.updatedBy, undefined);
      assert.equal(rows["group:G1"]!.content, "Answer in Spanish.", "a group DM's guidance lands on its group scope");
      assert.equal(rows["channel:G1"], undefined);
      assert.equal(rows["channel:C3"]!.content, "Untouched.", "blank guidance leaves instructions alone");
      assert.equal(rows["channel:C3"]!.version, 1);
      assert.equal(
        rows["group:web-project-p1"]!.content,
        "Use the project glossary.",
        "a web project's guidance lands on its group scope without a channel_state row",
      );
      assert.equal(rows["group:web-project-p1"]!.updatedBy, "U5");
      assert.equal(rows["group:web-project-p2"]!.content, "Project rules.\n\n---\n\nShip on Fridays.");
      assert.equal(rows["group:web-project-p2"]!.version, 2);
      assert.equal(rows["group:web-project-p3"]!.content, "Group rules.\n\n---\n\nMisfiled guidance.");
      assert.equal(rows["group:web-project-p3"]!.updatedBy, "U6");
      assert.equal(rows["group:web-project-p4"]!.content, "Lone misfiled guidance.");
      for (const id of ["p1", "p2", "p3", "p4"])
        assert.equal(rows[`channel:web-project-${id}`], undefined, `nothing is left on channel:web-project-${id}`);
      const orders = (await admin.query("SELECT container, orders FROM channel_policy ORDER BY container")).rows;
      assert.deepEqual(
        orders.map((r) => [r.container, r.orders]),
        [
          ["C1", "Flag launch slips."],
          ["C2", "Post a digest on Fridays."],
          ["C3", "   "],
          ["G1", "Answer in Spanish."],
          ["web-project-p1", "Use the project glossary."],
          ["web-project-p2", "Ship on Fridays."],
        ],
        "the channel policy keeps its guidance for a rollback",
      );
      await migrate(url);
      assert.deepEqual(await instructions(admin), rows, "the migration runs once");
    });
  });
}
