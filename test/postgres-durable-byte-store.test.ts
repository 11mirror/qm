import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresDurableByteStore } from "../src/files/durable-byte-store.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL to run the Postgres durable-byte-store test";
const table = `test_finny_evidence_${process.pid}`;

test("Postgres durable bytes are shared across store instances", { skip }, async (t) => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query("DELETE FROM qm_schema_migrations WHERE id = $1", [`durable-byte/${table}/0001`]);
    await pool.end();
  });
  const writer = createPostgresDurableByteStore(databaseUrl!, table);
  const reader = createPostgresDurableByteStore(databaseUrl!, table);
  const written = await writer.put(Buffer.from("shared finance evidence"));

  const opened = await reader.open(written.blobKey);
  assert.ok(opened);
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString("utf8"), "shared finance evidence");

  await reader.delete(written.blobKey);
  assert.equal(await writer.open(written.blobKey), null);
});
