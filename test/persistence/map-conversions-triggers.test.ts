import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { CRONS_MIGRATION } from "../../src/cron/cron-store.ts";
import { CRON_ITEMS_MIGRATION } from "../../src/inbox/ledger.ts";
import { MONITORS_MIGRATION } from "../../src/monitors/monitor-store.ts";
import { WEBHOOK_HISTORY_MIGRATION, WEBHOOKS_MIGRATION } from "../../src/webhooks/webhook-store.ts";
import { MEMORY_TIDY_PROFILES_MIGRATION } from "../../src/memory/tidy.ts";
import { SUGGESTED_ACTIVITY_PROFILES_MIGRATION } from "../../src/suggestions/activities.ts";
import { BACKGROUND_OWNERSHIP_MIGRATION } from "../../src/runs/background-ownership.ts";
import { assertMapConversion } from "../support/map-conversion.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const CONVERSIONS = [
  CRONS_MIGRATION,
  CRON_ITEMS_MIGRATION,
  WEBHOOKS_MIGRATION,
  WEBHOOK_HISTORY_MIGRATION,
  MONITORS_MIGRATION,
  MEMORY_TIDY_PROFILES_MIGRATION,
  SUGGESTED_ACTIVITY_PROFILES_MIGRATION,
];

for (const conversion of CONVERSIONS)
  test(`${conversion.spec.table} converts in place for one tenant and for two`, () => assertMapConversion(conversion));

test("background ownership keeps the owner a member-protocol row names and drops the protocol mirror", async () => {
  const member = { generation: 3, lastRequestId: null, lastRequest: null, members: [{ instanceId: "i" }] };
  const owned = { ownerDeploymentId: "core:green", setAt: "2026-10-01T00:00:00.000Z", setBy: "core:green" };
  const cases = [
    [{ ...owned, ...member, enabled: true, desiredDeploymentId: "core:green" }, owned],
    [{ ...owned, ...member, enabled: true, desiredDeploymentId: "core:blue" }, { ownerDeploymentId: "core:blue" }],
    [{ ...member, enabled: true, desiredDeploymentId: "core:blue" }, { ownerDeploymentId: "core:blue" }],
    [{ ...member, enabled: false, desiredDeploymentId: "core:blue" }, {}],
  ] as const;
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    for (const [stored, want] of cases) {
      await pool.query(`DROP TABLE IF EXISTS background_ownership`);
      await pool.query(`CREATE TABLE background_ownership (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
      await pool.query(`INSERT INTO background_ownership VALUES ('ownership', $1)`, [stored]);
      for (const statement of BACKGROUND_OWNERSHIP_MIGRATION.statements) await pool.query(statement);
      const { rows } = await pool.query(
        `SELECT json_strip_nulls(json_build_object('ownerDeploymentId', owner_deployment_id, 'setAt', set_at,
           'setBy', set_by)) AS row FROM background_ownership`,
      );
      assert.deepEqual(rows, [{ row: want }]);
    }
  } finally {
    await pool.end();
  }
});
