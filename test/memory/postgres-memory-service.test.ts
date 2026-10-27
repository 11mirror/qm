import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, beforeEach } from "node:test";
import pg from "pg";
import { MemoryFactsMissing } from "../../src/memory/facts.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPostgresVectorStore } from "../../src/memory/postgres-vector-store.ts";
import { scopeId } from "../../src/types.ts";
import { truncateTables } from "../support/test-database.ts";

const URL = process.env.DATABASE_URL!;
const at = Date.UTC(2026, 4, 31);

async function sql(text: string, params: unknown[] = []) {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  try {
    return (await pool.query(text, params)).rows;
  } finally {
    await pool.end();
  }
}

beforeEach(async () => {
  await truncateTables(URL, ["memory_facts"]);
});

test("pg memory: add, edit and delete by id; a bad id rolls back the whole call", async () => {
  const memory = createPostgresMemoryService(URL);
  const sid = scopeId("personal", "U1");
  assert.equal(await memory.capture(sid, ["Prefers terse replies", "Owns billing"], at, "U1"), 2);
  assert.equal(await memory.capture(sid, ["prefers terse replies"], at, "U1"), 0);
  const [terse, billing] = await memory.facts!(sid);

  await assert.rejects(
    memory.edit!(sid, [
      { id: terse!.id, text: "Prefers short replies" },
      { id: "999999", text: "x" },
    ]),
    (e: unknown) => e instanceof MemoryFactsMissing && e.ids.join() === "999999",
  );
  await assert.rejects(memory.delete!(scopeId("personal", "U2"), [billing!.id]), MemoryFactsMissing);
  assert.equal(await memory.read(sid), "- (2026-05-31) Prefers terse replies\n- (2026-05-31) Owns billing");

  await memory.edit!(sid, [{ id: `#${terse!.id}`, text: "- (2020-01-01) Prefers short replies" }]);
  await memory.delete!(sid, [billing!.id]);
  const second = createPostgresMemoryService(URL);
  assert.deepEqual(await second.query(sid, "short", 5), [`#${terse!.id} (2026-05-31) Prefers short replies`]);
  assert.equal(await second.read(sid), "- (2026-05-31) Prefers short replies");
  const [row] = await sql("SELECT deleted_at FROM memory_facts WHERE id = $1", [billing!.id]);
  assert.ok(row?.deleted_at, "delete keeps the row, marked deleted");
});

const url = process.env.DATABASE_URL!;

test("a 4500-fact scope fully drains 3072-dimensional recall in under one second", async (t) => {
  const scope = `personal:large-${randomUUID()}`;
  const model = `large-${randomUUID()}`;
  const base = createPostgresMemoryService(url);
  const index = createPostgresVectorStore(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  t.after(async () => {
    await client.end();
    await index.close();
  });
  await base.facts!(scope);
  await index.missing(model, 1);
  await client.query(
    `INSERT INTO memory_facts(scope_id, text, sensitivity, source_unknown, created_at, updated_at)
    SELECT $1, 'Large notebook fact ' || g, 'ordinary', false, g, g FROM generate_series(1,4500) g`,
    [scope],
  );
  const vector = Array.from({ length: 3072 }, (_, i) => Math.sin(i * 123.4567));
  await client.query(
    `INSERT INTO memory_fact_vectors(scope_id, model, fact_id, fact_hash, dimensions, embedding)
    SELECT scope_id, $2, id, encode(sha256(convert_to(text,'UTF8')),'hex'), 3072, $3::vector
    FROM memory_facts WHERE scope_id = $1 AND created_at <= 4490`,
    [scope, model, JSON.stringify(vector)],
  );
  await client.query("ANALYZE memory_facts; ANALYZE memory_fact_vectors");
  const facts = await base.facts!(scope);
  const start = performance.now();
  const matches = await index.search({ scope, model, vector, ids: facts.map((fact) => fact.id) });
  const elapsed = performance.now() - start;
  assert.equal(matches.length, 4500);
  assert.ok(matches.slice(0, 4490).every((row) => row.score > 0.99));
  assert.ok(matches.slice(4490).every((row) => Math.abs(row.score - 0.2) < 1e-9));
  assert.equal(matches[0]!.factId, facts[4489]!.id);
  assert.ok(elapsed < 1000, `4500-fact full drain took ${elapsed.toFixed(1)}ms`);
  t.diagnostic(`4500 facts / 3072 dimensions / full drain: ${elapsed.toFixed(1)}ms`);
});
