import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { typedTable, type MapConversion } from "../src/persistence/typed-table.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { APPROVALS_MIGRATION } from "../src/core/approval-store.ts";
import { TASK_ACKS_MIGRATION } from "../src/slack/task-ack.ts";
import { SLACK_INSTALLATION_MIGRATION } from "../src/surfaces/slack-installation.ts";
import { WEB_UI_STATE_MIGRATION } from "../src/surfaces/ui-state.ts";

const REAL_ROWS: Array<[MapConversion, Record<string, Record<string, unknown>>]> = [
  [
    WEB_UI_STATE_MIGRATION,
    {
      "U1#inbox-crons": { value: ["c1", "c2"], updatedAt: 1761000000000 },
      "U1#flag": { value: false, updatedAt: 1761000000001 },
      "U1#inbox-filter": { value: "all", updatedAt: 1761000000002 },
      "U1#canvas": { value: { html: "<p/>", rev: 3, pinned: true }, updatedAt: 1761000000003 },
    },
  ],
  [
    TASK_ACKS_MIGRATION,
    {
      r1: { channel: "D1", emoji: "eyes", target: "1.0", previous: [], finished: true, synced: true },
      r2: { channel: "D1", emoji: "eyes", target: "2.0", previous: ["1.0", "1.5"], finished: false, synced: false },
    },
  ],
  [
    SLACK_INSTALLATION_MIGRATION,
    {
      org: {
        orgId: "org",
        appId: "A1",
        botTokenEnc: "enc",
        disabled: false,
        installedAt: 1761000000000,
        installId: "I1",
        serviceBlocked: false,
        teamId: "T1",
        teamName: "Team",
        updatedAt: 1761000000001,
        updatedBy: "slack-service",
        version: "v1",
      },
    },
  ],
  [
    APPROVALS_MIGRATION,
    {
      a1: {
        approvalKey: "k",
        blocksInput: true,
        command: "git push",
        createdAt: 1761000000000,
        kind: "approval",
        matched: "git push*",
        purpose: "ship",
        reason: "requires approval",
        request: { surface: "slack", actor: { id: "U1" }, conversation: { kind: "dm", threadRef: "dm:D1" } },
        sessionId: "s1",
        summary: "Push",
      },
    },
  ],
];

for (const [conversion, rows] of REAL_ROWS)
  test(`${conversion.spec.table} keeps real-shaped rows exactly`, async () => {
    const url = testDatabaseUrl();
    const pool = new pg.Pool({ connectionString: url });
    const table = conversion.spec.table;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.query(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
      for (const [id, json] of Object.entries(rows))
        await pool.query(`INSERT INTO ${table} (id, json) VALUES ($1, $2)`, [id, JSON.stringify(json)]);
      for (const statement of conversion.statements) await pool.query(statement);
      const typed = typedTable(createPgPool(url), conversion.spec);
      for (const [id, json] of Object.entries(rows)) assert.deepEqual(await typed.get(id), json);
    } finally {
      await pool.end();
    }
  });
