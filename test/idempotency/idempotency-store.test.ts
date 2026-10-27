import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const row = async (url: string, key: string) =>
  (await createPgPool(url).q("SELECT key, at, claim FROM idempotency WHERE key = $1", [key]))[0] ?? null;

test("once runs fn the first time and skips on replay", async () => {
  const store = createIdempotencyStore(testDatabaseUrl());
  let runs = 0;
  assert.equal(await store.once("k", async () => void runs++), true);
  assert.equal(await store.once("k", async () => void runs++), false);
  assert.equal(runs, 1);
  assert.equal(await store.committed("k"), true);
});

test("a failed fn stays retryable (not committed)", async () => {
  const store = createIdempotencyStore(testDatabaseUrl());
  await assert.rejects(
    store.once("k", async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(await store.committed("k"), false);
  let ran = false;
  assert.equal(await store.once("k", async () => void (ran = true)), true);
  assert.equal(ran, true);
});

test("a committed key survives a restart (new store over the same table)", async () => {
  const url = testDatabaseUrl();
  const before = createIdempotencyStore(url);
  let runs = 0;
  await before.once("webhook:w1:d1", async () => void runs++);
  assert.equal(runs, 1);

  const after = createIdempotencyStore(url);
  assert.equal(await after.committed("webhook:w1:d1"), true);
  assert.equal(await after.once("webhook:w1:d1", async () => void runs++), false);
  assert.equal(runs, 1);
});

test("retention: records older than retentionMs are pruned from memory and the backing", async () => {
  const url = testDatabaseUrl();
  let t = 0;
  const store = createIdempotencyStore(url, { retentionMs: 100, pruneIntervalMs: 1, now: () => t });
  t = 10;
  await store.once("old", async () => {});
  t = 500;
  await store.once("fresh", async () => {});
  for (let i = 0; i < 50 && (await row(url, "old")) != null; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(await row(url, "old"), null, "the stale record is swept from the backing");
  assert.ok(await row(url, "fresh"), "records inside the retention window are kept");
  assert.equal(await store.committed("old"), false);
  assert.equal(await store.committed("fresh"), true);
});

test("retention: an expired record stops deduping even before the sweep runs", async () => {
  const url = testDatabaseUrl();
  let t = 0;
  const store = createIdempotencyStore(url, { retentionMs: 100, pruneIntervalMs: 10_000, now: () => t });
  t = 10;
  await store.once("k", async () => {});
  t = 50;
  assert.equal(await store.committed("k"), true);
  t = 200;
  assert.equal(await store.committed("k"), false, "lookups honor the cutoff, not the sweep schedule");
  let ran = 0;
  assert.equal(await store.once("k", async () => void ran++), true, "an expired key is replayable again");
  assert.equal(ran, 1);
});

test("an in-flight claim is shared across processes: a second store skips while the first runs", async () => {
  const url = testDatabaseUrl();
  const a = createIdempotencyStore(url);
  const b = createIdempotencyStore(url);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let runs = 0;
  const first = a.once("k", async () => {
    runs++;
    await gate;
  });
  while (!(await row(url, "k"))) await new Promise((r) => setImmediate(r));
  assert.equal(await b.once("k", async () => void runs++), false, "the other process sees the live claim");
  assert.equal(await b.committed("k"), false, "a claim is not a commit");
  release();
  assert.equal(await first, true);
  assert.equal(await b.committed("k"), true);
  assert.equal(runs, 1);
});

test("a failed run releases its claim; a crashed holder's claim expires after the lease", async () => {
  const url = testDatabaseUrl();
  let t = 1_000;
  const store = createIdempotencyStore(url, { claimLeaseMs: 100, now: () => t });
  await assert.rejects(store.once("k", async () => Promise.reject(new Error("boom"))));
  assert.equal(await row(url, "k"), null, "the failed claim is gone");

  await createPgPool(url).q("INSERT INTO idempotency (key, at, claim) VALUES ($1, $2, $3)", [
    "crashed",
    t,
    "dead-holder",
  ]);
  assert.equal(await store.once("crashed", async () => {}), false, "a fresh foreign claim blocks");
  t += 101;
  let ran = false;
  assert.equal(await store.once("crashed", async () => void (ran = true)), true, "an expired claim is taken over");
  assert.equal(ran, true);
  assert.equal((await row(url, "crashed"))?.claim, null);
});
