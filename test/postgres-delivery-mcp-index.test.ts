import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL to run the Postgres delivery index test";

test("MCP evidence lookup uses its partial GIN index", { skip }, async (t) => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => pool.end());
  await pool.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS deliveries CASCADE");

  const store = createPostgresDeliveryStore(databaseUrl!);
  const contextSha256 = "a".repeat(64);
  await store.enqueue({
    destination: { type: "slack", target: "C1" },
    text: "verified output",
    idempotencyKey: "mcp-index-proof",
    provenance: {
      trigger: "cron",
      surface: "slack",
      fireKey: "index-proof",
      sourceScopeId: "scope:index-proof",
      sourceThreadRef: "thread:index-proof",
      mcpEvidenceRefs: [
        {
          serverId: "finance",
          callId: "call-1",
          contextSha256,
          outputReceiptSha256: "b".repeat(64),
        },
      ],
    },
  });
  assert.equal((await store.listByMcpCall("finance", "call-1", contextSha256)).length, 1);

  await pool.query(
    `INSERT INTO deliveries (id, idempotency_key, destination, text, provenance, created_at)
     SELECT 'noise-' || value,
            'noise-key-' || value,
            '{"type":"slack","target":"C1"}'::jsonb,
            'unrelated delivery',
            '{"sourceThreadRef":"thread:noise"}'::jsonb,
            value
       FROM generate_series(1, 1000) AS value`,
  );
  await pool.query("ANALYZE deliveries");

  await pool.query("SET enable_seqscan = off");
  const plan = await pool.query(
    `EXPLAIN SELECT * FROM deliveries
      WHERE provenance ? 'mcpEvidenceRefs'
        AND provenance->'mcpEvidenceRefs' @> $1::jsonb`,
    [JSON.stringify([{ serverId: "finance", callId: "call-1", contextSha256 }])],
  );
  assert.match(plan.rows.map((row) => row["QUERY PLAN"]).join("\n"), /idx_deliveries_mcp_evidence/);
});
