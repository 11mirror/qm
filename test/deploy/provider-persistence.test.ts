import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { createSandboxBodies } from "../../src/sandbox/sandbox-bodies.ts";
import { SUPERSERVE_BODIES, type StoredSuperserveSandbox } from "../../src/sandbox/superserve-sandbox.ts";
import { flyDeployPorts } from "../../src/deploy/fly-deploy-ports.ts";
import { CONTRACT_MIGRATIONS } from "../../src/persistence/contract-migrations.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

test("Fly assignments retain scalar port owners during typed conversion", async () => {
  const url = testDatabaseUrl();
  const db = createPgPool(url);
  await db.q("CREATE TABLE fly_deploy_ports (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
  await db.q("INSERT INTO fly_deploy_ports VALUES ($1, $2::jsonb)", ["company:25000", JSON.stringify("app-a")]);
  const ports = flyDeployPorts(url);
  assert.equal(await ports.putIfAbsent("company:25000", "app-b"), "app-a");
  assert.equal(await ports.putIfAbsent("company:25001", "app-b"), "app-b");
  assert.equal(await flyDeployPorts(url).putIfAbsent("company:25001", "app-c"), "app-b");
});

test("Superserve initialization survives all contract migrations", async () => {
  const url = testDatabaseUrl();
  const bodies = createSandboxBodies<StoredSuperserveSandbox>(url, SUPERSERVE_BODIES);
  await bodies.upsert("personal:owner", { sandboxId: "box-1", initializationPending: false });
  const db = createPgPool(url, CONTRACT_MIGRATIONS);
  await db.q("SELECT 1");
  assert.equal((await bodies.get("personal:owner"))?.sandboxId, "box-1");
  const fields = await db.q(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'superserve_sandbox_bodies'",
  );
  assert.ok(fields.some((field) => field.column_name === "scope_id"));
  assert.equal(
    fields.some((field) => field.column_name === "json"),
    false,
  );
});
