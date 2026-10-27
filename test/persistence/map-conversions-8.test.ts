import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { DEACTIVATED_PRINCIPALS_MIGRATION, EXTERNAL_MEMBERS_MIGRATION } from "../../src/identity/identity-service.ts";
import { PRINCIPAL_LINKS_MIGRATION } from "../../src/identity/principal-links.ts";
import { MCP_SERVERS_MIGRATION } from "../../src/mcp/mcp-server-store.ts";
import { MEMORY_CAPTURE_PENDING_MIGRATION } from "../../src/memory/strategies/per-turn.ts";
import { SKILL_BUNDLES_MIGRATION } from "../../src/skills/skill-bundle-store.ts";
import { SKILL_PACKS_MIGRATION } from "../../src/skills/skill-pack-store.ts";
import { createSkillStore, SKILLS_MIGRATION } from "../../src/skills/skill-store.ts";
import { scopeId } from "../../src/types.ts";
import { assertMapConversion } from "../support/map-conversion.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";

const CONVERSIONS = [
  PRINCIPAL_LINKS_MIGRATION,
  DEACTIVATED_PRINCIPALS_MIGRATION,
  EXTERNAL_MEMBERS_MIGRATION,
  SKILLS_MIGRATION,
  SKILL_PACKS_MIGRATION,
  SKILL_BUNDLES_MIGRATION,
  MCP_SERVERS_MIGRATION,
  MEMORY_CAPTURE_PENDING_MIGRATION,
];

for (const conversion of CONVERSIONS)
  test(`${conversion.spec.table} converts in place for one tenant and for two`, () => assertMapConversion(conversion));

test("a live-shaped skills map row converts and reads back through the store unchanged", async () => {
  const databaseUrl = testDatabaseUrl();
  const pool = new pg.Pool({ connectionString: databaseUrl });
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
  try {
    await pool.query(`DROP TABLE skills CASCADE`);
    await pool.query(`CREATE TABLE skills (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    await pool.query(`INSERT INTO skills VALUES ($1, $2), ($3, $4)`, [
      skill.id,
      { ...skill, signature: "legacy-hmac" },
      "no-last-use",
      { ...skill, id: "no-last-use", lastUsedAt: undefined, signature: "legacy-hmac" },
    ]);
    for (const statement of SKILLS_MIGRATION.statements) await pool.query(statement);
  } finally {
    await pool.end();
  }
  const store = createSkillStore({ databaseUrl, advisoryLock: testAdvisoryLock() });
  assert.deepEqual(await store.get(skill.id), skill);
  const { lastUsedAt: _, ...unused } = skill;
  assert.deepEqual(await store.get("no-last-use"), { ...unused, id: "no-last-use" });
  assert.deepEqual(
    (await store.visibleFor([scopeId("org", "acme")])).map((r) => r.skill?.id),
    ["0b7c6f0e-1d1a-4c55-9f5e-3c1f2e4d5a6b"],
  );
});
