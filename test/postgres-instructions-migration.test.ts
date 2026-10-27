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
  await insert("soul_configs", "id, json", [
    "channel:C3",
    JSON.stringify({ scopeId: "channel:C3", content: "Untouched.", version: 1, updatedAt: 5 }),
  ]);
  for (const [container, orders, setBy] of [
    ["C1", "Flag launch slips.", "U2"],
    ["C2", "Post a digest on Fridays.", null],
    ["G1", "Answer in Spanish.", "U3"],
    ["C3", "   ", "U4"],
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
      const orders = (await admin.query("SELECT container, orders FROM channel_policy ORDER BY container")).rows;
      assert.ok(
        orders.every((r) => r.orders === ""),
        "guidance is no longer kept on the channel policy",
      );
      await migrate(url);
      assert.deepEqual(await instructions(admin), rows, "the migration runs once");
    });
  });
}
