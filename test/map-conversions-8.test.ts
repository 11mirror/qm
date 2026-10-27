import { test } from "node:test";
import assert from "node:assert/strict";
import { createSkillStore, SKILLS_MIGRATION } from "../src/skills/skill-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";
import { testAdvisoryLock, testDatabaseUrl } from "./support/test-database.ts";

test("a live-shaped skills map row converts and reads back through the store unchanged", async () => {
  const databaseUrl = testDatabaseUrl();
  const skill = {
    id: "0b7c6f0e-1d1a-4c55-9f5e-3c1f2e4d5a6b",
    scopeId: "org:acme",
    manifest: {
      name: "send",
      description: "Make a PR \u00e9\u{1F600}",
      requiredCapabilities: ["git"],
      body: "# send\n",
      files: [{ path: "scripts/run.sh", content: "#!/bin/sh\necho hi\n", executable: true }],
    },
    status: "published",
    createdBy: "system:skills-seed",
    version: 3,
    grantedCapabilities: ["git"],
    approvals: ["system:skills-reviewer"],
    createdAt: 1_761_000_000_000,
    updatedAt: 1_761_000_000_500,
    lastUsedAt: 1_761_000_001_000,
  };
  const { q } = createPgPool(databaseUrl);
  await q(`DROP TABLE skills CASCADE`);
  await q(`CREATE TABLE skills (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
  await q(`INSERT INTO skills VALUES ($1, $2), ($3, $4)`, [
    skill.id,
    { ...skill, signature: "legacy-hmac" },
    "no-last-use",
    { ...skill, id: "no-last-use", lastUsedAt: undefined, signature: "legacy-hmac" },
  ]);
  for (const statement of SKILLS_MIGRATION.statements) await q(statement);
  const store = createSkillStore({ databaseUrl, advisoryLock: testAdvisoryLock() });
  assert.deepEqual(await store.get(skill.id), skill);
  const { lastUsedAt: _, ...unused } = skill;
  assert.deepEqual(await store.get("no-last-use"), { ...unused, id: "no-last-use" });
  assert.deepEqual(
    (await store.visibleFor([scopeId("org", "acme")])).map((r) => r.skill?.id),
    ["0b7c6f0e-1d1a-4c55-9f5e-3c1f2e4d5a6b"],
  );
});
