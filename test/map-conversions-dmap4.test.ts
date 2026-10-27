import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { MODAL_BODIES, type StoredModalSandbox } from "../src/sandbox/modal-sandbox.ts";
import { createSandboxBodies } from "../src/sandbox/sandbox-bodies.ts";
import {
  createSandboxResourceStore,
  SANDBOX_DEFAULTS_MIGRATION,
  SANDBOX_RESOURCE_ROLLOUT_MIGRATION,
  SANDBOX_RESOURCES_MIGRATION,
  SANDBOX_ROUTING_MIGRATION,
} from "../src/sandbox/sandbox-resource-store.ts";
import type { SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import { SPRITES_BODIES } from "../src/sandbox/sprites-sandbox.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const modal: StoredModalSandbox = {
  checkpointAtMs: 1_761_000_000_001,
  checkpointId: "im-1",
  createdAtMs: 1_761_000_000_002,
  expiresAtMs: 1_761_000_000_003,
  homeDirty: false,
  lastActivityMs: 1_761_000_000_004,
  lastSnapshotMs: 1_761_000_000_005,
  orgId: "org-1",
  sandboxId: "sb-1",
};
const held: SandboxResource = {
  id: "legacy-1",
  backend: "modal",
  ownerScopeId: "personal:a",
  backingScopeId: "personal:a",
  name: "Existing scoped computer",
  createdBy: "system",
  createdAt: "2026-10-01T00:00:00.000Z",
  legacy: true,
  state: "ready",
  machineId: "sb-1",
  holders: [],
  spec: { os: "Debian", runtimes: ["Node"], cpus: 2 } as unknown as SandboxResource["spec"],
};
const failed: SandboxResource = { ...held, id: "managed-2", legacy: false, state: "failed", error: "boom" };
delete failed.holders;
delete failed.machineId;
delete failed.spec;

test("rows shaped like live data read back unchanged through the stores", async () => {
  const url = testDatabaseUrl();
  const { q } = createPgPool(url);
  const seed = async (table: string, id: string, json: unknown, migrationId: string) => {
    await q(`DROP TABLE IF EXISTS ${table}`);
    await q(`DELETE FROM qm_schema_migrations WHERE id = $1`, [migrationId]);
    await q(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    await q(`INSERT INTO ${table} (id, json) VALUES ($1, $2)`, [id, JSON.stringify(json)]);
  };
  await seed("modal_sandbox_bodies", "personal:a", modal, MODAL_BODIES.id);
  await seed("sprites_initialization", "qm-sprite-name", { pending: true }, SPRITES_BODIES.id);
  await seed("sandbox_resources", held.id, held, SANDBOX_RESOURCES_MIGRATION.id);
  await q(`INSERT INTO sandbox_resources (id, json) VALUES ($1, $2)`, [failed.id, JSON.stringify(failed)]);
  await seed("sandbox_defaults", "personal:a", { sandboxId: null }, SANDBOX_DEFAULTS_MIGRATION.id);
  await q(`INSERT INTO sandbox_defaults (id, json) VALUES ('personal:b', '{"sandboxId": "legacy-1"}')`);
  await seed(
    "sandbox_resource_rollout",
    "explicit-defaults",
    { activatedAt: "2026-10-01T00:00:00.000Z" },
    SANDBOX_RESOURCE_ROLLOUT_MIGRATION.id,
  );
  await seed("sandbox_routing", "personal:c", { backend: "e2b" }, SANDBOX_ROUTING_MIGRATION.id);
  assert.deepEqual(await createSandboxBodies(url, MODAL_BODIES).entries(), [["personal:a", modal]]);
  assert.deepEqual(await createSandboxBodies(url, SPRITES_BODIES).entries(), [["qm-sprite-name", {}]]);
  const store = createSandboxResourceStore(url);
  assert.deepEqual(
    await store.list(),
    [held, failed].toSorted((a, b) => a.id.localeCompare(b.id)),
  );
  assert.deepEqual(await store.defaults(), [
    ["personal:a", { sandboxId: null }],
    ["personal:b", { sandboxId: "legacy-1" }],
  ]);
  assert.equal(await store.upgraded(), true);
  assert.deepEqual(await store.legacyRoutes(), [["personal:c", { backend: "e2b" }]]);
});
