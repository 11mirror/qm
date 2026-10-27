import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { BACKGROUND_OWNERSHIP_MIGRATION } from "../src/runs/background-ownership.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

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
