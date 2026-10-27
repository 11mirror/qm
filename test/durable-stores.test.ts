import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";
import { testAdvisoryLock, testDatabaseUrl, testDeployBackings } from "./support/test-database.ts";
import { markFired } from "./support/cron-slots.ts";

test("crons persist across store instances", async () => {
  const url = testDatabaseUrl();
  const s1 = createCronStore(url);
  const c = await s1.create({
    schedule: { everyMs: 60_000 },
    action: "summarize signups",
    ownerScopeId: scopeId("personal", "U1"),
    owner: "U1",
    createdBy: "U1",
    destination: { type: "dm", target: "U1" },
  });
  await markFired(s1, c.id, 123);

  const s2 = createCronStore(url);
  const got = await s2.get(c.id);
  assert.equal(got?.action, "summarize signups");
  assert.equal(got?.lastFiredAt, 123);
});

test("skill mutations reject names that could escape or collide when materialized", async () => {
  const databaseUrl = testDatabaseUrl();
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl });
  const manifest = (name: string) => ({ name, description: "d", requiredCapabilities: [], body: "b" });
  for (const name of ["..", "foo/bar", "foo\\bar", "foo bar", ".hidden", "foo."]) {
    await assert.rejects(
      () => skills.create({ scopeId: scopeId("personal", "U1"), manifest: manifest(name), createdBy: "U1" }),
      /skill name must/,
    );
  }

  const legacy = await skills.create({
    scopeId: scopeId("personal", "U1"),
    manifest: manifest("safe-name"),
    createdBy: "U1",
  });
  await createPgPool(databaseUrl).q(`UPDATE skills SET manifest = $2, status = 'reviewed' WHERE id = $1`, [
    legacy.id,
    manifest("foo/bar"),
  ]);
  await assert.rejects(() => skills.publish(legacy.id), /skill name must/);
  assert.equal(
    (await skills.visibleFor([scopeId("personal", "U1")])).length,
    0,
    "legacy unsafe records never reach materialization",
  );
});

test("deployments persist with immutable versions across store instances", async () => {
  const backing = testDeployBackings();
  const s1 = createDeployStore(backing);
  const d = await s1.create({
    ownerScopeId: scopeId("team", "T1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/1",
  });
  await s1.addVersion(d.id, { entrypoint: "node server.js --v2", snapshotDir: "/snap/2" });

  const s2 = createDeployStore(backing);
  const got = await s2.get(d.id);
  assert.equal(got?.versions.length, 2);
  assert.equal(got?.currentVersion, 2);
  assert.equal((await s2.versionOf(d.id, 1))?.snapshotDir, "/snap/1");
});
