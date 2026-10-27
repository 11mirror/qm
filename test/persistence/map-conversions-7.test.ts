import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { columnName, tableCodec, type MapConversion } from "../../src/persistence/typed-table.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { AMBIENT_CURSORS_MIGRATION } from "../../src/api/ambient-cursors.ts";
import { CONTEXT_REQUESTS_MIGRATION } from "../../src/api/context-requests.ts";
import { COMPOSIO_RETURNS_MIGRATION, SLACK_ACCOUNTS_MIGRATION } from "../../src/connectors/composio-links.ts";
import { APPROVALS_MIGRATION } from "../../src/core/approval-store.ts";
import { APPROVAL_GRANTS_MIGRATION } from "../../src/core/orchestrator/approvals.ts";
import { SESSION_SHARES_MIGRATION } from "../../src/sessions/session-share.ts";
import { STAGED_ENVELOPES_MIGRATION } from "../../src/slack/envelope-staging.ts";
import { HANDLED_EVENTS_MIGRATION } from "../../src/slack/message-gating.ts";
import { SESSION_STATUS_MIGRATION } from "../../src/slack/session-status.ts";
import { TASK_ACKS_MIGRATION } from "../../src/slack/task-ack.ts";
import { QUEUED_POSTS_MIGRATION } from "../../src/surfaces/queued-posts.ts";
import { RECENT_DM_POSTS_MIGRATION } from "../../src/surfaces/recent-dm-posts.ts";
import { SLACK_INSTALLATION_MIGRATION } from "../../src/surfaces/slack-installation.ts";
import { WEB_UI_STATE_MIGRATION } from "../../src/surfaces/ui-state.ts";
import { assertMapConversion } from "../support/map-conversion.ts";

const CONVERSIONS = [
  APPROVALS_MIGRATION,
  APPROVAL_GRANTS_MIGRATION,
  SLACK_INSTALLATION_MIGRATION,
  TASK_ACKS_MIGRATION,
  SESSION_STATUS_MIGRATION,
  STAGED_ENVELOPES_MIGRATION,
  HANDLED_EVENTS_MIGRATION,
  AMBIENT_CURSORS_MIGRATION,
  CONTEXT_REQUESTS_MIGRATION,
  RECENT_DM_POSTS_MIGRATION,
  QUEUED_POSTS_MIGRATION,
  WEB_UI_STATE_MIGRATION,
  SESSION_SHARES_MIGRATION,
  SLACK_ACCOUNTS_MIGRATION,
  COMPOSIO_RETURNS_MIGRATION,
];

for (const conversion of CONVERSIONS)
  test(`${conversion.spec.table} converts in place for one tenant and for two`, () => assertMapConversion(conversion));

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
    const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
    const table = conversion.spec.table;
    const codec = tableCodec<Record<string, unknown>>(conversion.spec);
    try {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.query(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
      for (const [id, json] of Object.entries(rows))
        await pool.query(`INSERT INTO ${table} (id, json) VALUES ($1, $2)`, [id, JSON.stringify(json)]);
      for (const statement of conversion.statements) await pool.query(statement);
      for (const [id, json] of Object.entries(rows)) {
        const key = conversion.spec.keyIsField ? columnName(conversion.spec.key) : "id";
        const found = await pool.query(`SELECT ${codec.columns} FROM ${table} WHERE ${key} = $1`, [id]);
        assert.deepEqual(codec.row(found.rows[0]), json);
      }
    } finally {
      await pool.end();
    }
  });
