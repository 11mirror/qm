import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore, type DeployStore } from "../src/deploy/deploy-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const databaseUrl = testDatabaseUrl();
const raw = (sql: string, params: unknown[] = []) => createPgPool(databaseUrl).q(sql, params);

function makeStore(opts: { touchDebounceMs?: number } = {}): DeployStore {
  return createDeployStore({ databaseUrl, git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-pg-")) }, ...opts });
}

const createInput = (name?: string) => ({
  ownerScopeId: scopeId("personal", "U1"),
  createdBy: "U1",
  entrypoint: "node s.js",
  snapshotDir: "/snap",
  ...(name ? { name } : {}),
});

test("touch upserts deployment_access without rewriting the deployment row", async () => {
  const store = makeStore({ touchDebounceMs: 0 });
  const d = await store.create(createInput());

  await store.touch(d.id, 111);
  assert.equal((await store.get(d.id))!.lastAccessAt, 111);
  assert.equal((await store.list()).find((x) => x.id === d.id)!.lastAccessAt, 111);

  const row = (await raw("SELECT last_access_at FROM deployments WHERE id = $1", [d.id]))[0]!;
  assert.equal(row.last_access_at, null, "touch stays out of the deployment row");

  await store.touch("missing-id", 5);
  assert.equal((await raw("SELECT count(*) c FROM deployment_access WHERE id = 'missing-id'"))[0]!.c, "0");

  await raw("DELETE FROM deployments WHERE id = $1", [d.id]);
  assert.equal(
    (await raw("SELECT count(*) c FROM deployment_access WHERE id = $1", [d.id]))[0]!.c,
    "0",
    "access rows cascade with their deployment",
  );
});

test("touch keeps the max across instances (GREATEST) and debounces per instance", async () => {
  const a = makeStore({ touchDebounceMs: 0 });
  const b = makeStore({ touchDebounceMs: 0 });
  const d = await a.create(createInput());

  await a.touch(d.id, 2_000);
  await b.touch(d.id, 500);
  assert.equal((await b.get(d.id))!.lastAccessAt, 2_000, "a late lower write never regresses last-access");
  await b.touch(d.id, 3_000);
  assert.equal((await a.get(d.id))!.lastAccessAt, 3_000);

  const debounced = makeStore();
  await debounced.touch(d.id, 10_000);
  await debounced.touch(d.id, 50_000);
  assert.equal(
    Number((await raw("SELECT last_access_at FROM deployment_access WHERE id = $1", [d.id]))[0]!.last_access_at),
    10_000,
    "a touch inside the 60s window is skipped",
  );
  await debounced.touch(d.id, 70_001);
  assert.equal((await debounced.get(d.id))!.lastAccessAt, 70_001);
});

test("getByName resolves by indexed SQL lookup and hydrates last-access", async () => {
  const store = makeStore({ touchDebounceMs: 0 });
  const d = await store.create(createInput("slug-app"));
  assert.equal((await store.getByName("slug-app"))!.id, d.id);
  assert.equal(await store.getByName("no-such-app"), null);
  await store.touch(d.id, 4_242);
  assert.equal((await store.getByName("slug-app"))!.lastAccessAt, 4_242);
});

test("a racing create with a taken name fails on the unique index, not just the pre-check", async () => {
  const a = makeStore();
  const b = makeStore();
  await a.create(createInput("contested"));
  await assert.rejects(b.create(createInput("contested")), /deployment name taken: contested/);
});

test("renaming onto a taken name is rejected by the unique index", async () => {
  const store = makeStore();
  await store.create(createInput("held"));
  const other = await store.create(createInput("free"));
  await assert.rejects(store.setName(other.id, "held"), /deployment name taken: held/);
  assert.equal((await store.get(other.id))!.name, "free");
});

test("pre-existing duplicate names degrade gracefully: no index, deterministic getByName", async () => {
  await raw("DROP INDEX IF EXISTS deployments_name_unique");
  for (const id of ["dup-b", "dup-a"])
    await raw(
      `INSERT INTO deployments (id, owner_scope_id, created_by, name, current_version, status, versions)
       VALUES ($1, 'personal:U1', 'U1', 'doubled', 1, 'stopped', '[]')`,
      [id],
    );

  const store = makeStore();
  assert.equal((await store.getByName("doubled"))!.id, "dup-a", "lowest id wins");
  const created = await store.create(createInput("fresh-name"));
  assert.equal((await store.getByName("fresh-name"))!.id, created.id);
});
