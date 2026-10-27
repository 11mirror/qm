import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdempotencyStore, type IdempotencyRecord } from "../../src/idempotency/idempotency-store.ts";
import { testMap } from "../support/test-database.ts";

test("once runs fn the first time and skips on replay", async () => {
  const store = createIdempotencyStore(testMap());
  let runs = 0;
  assert.equal(await store.once("k", async () => void runs++), true);
  assert.equal(await store.once("k", async () => void runs++), false);
  assert.equal(runs, 1);
  assert.equal(await store.committed("k"), true);
});

test("a failed fn stays retryable (not committed)", async () => {
  const store = createIdempotencyStore(testMap());
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

test("durable backing: a committed key survives a restart (new store over the same map)", async () => {
  const backing = testMap<IdempotencyRecord>();
  const before = createIdempotencyStore(backing);
  let runs = 0;
  await before.once("webhook:w1:d1", async () => void runs++);
  assert.equal(runs, 1);

  const after = createIdempotencyStore(backing);
  assert.equal(await after.committed("webhook:w1:d1"), true);
  assert.equal(await after.once("webhook:w1:d1", async () => void runs++), false);
  assert.equal(runs, 1);
});

test("lookups are point reads — committed() never scans the whole table into RAM", async () => {
  const inner = testMap<IdempotencyRecord>();
  let allCalls = 0;
  const backing = {
    ...inner,
    all: async () => {
      allCalls++;
      return inner.all();
    },
  };
  await inner.put("k1", { key: "k1", at: Date.now() });
  const store = createIdempotencyStore(backing);
  assert.equal(await store.committed("k1"), true);
  assert.equal(await store.committed("nope"), false);
  let ran = 0;
  await store.once("k2", async () => void ran++);
  assert.equal(ran, 1);
  assert.equal(allCalls, 0, "no full-table seed on boot or lookup");
});

test("retention: records older than retentionMs are pruned from memory and the backing", async () => {
  const backing = testMap<IdempotencyRecord>();
  let t = 0;
  const store = createIdempotencyStore(backing, { retentionMs: 100, pruneIntervalMs: 1, now: () => t });
  t = 10;
  await store.once("old", async () => {});
  t = 500;
  await store.once("fresh", async () => {});
  for (let i = 0; i < 50 && (await backing.get("old")) != null; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(await backing.get("old"), null, "the stale record is swept from the backing");
  assert.ok(await backing.get("fresh"), "records inside the retention window are kept");
  assert.equal(await store.committed("old"), false);
  assert.equal(await store.committed("fresh"), true);
});

test("retention: an expired record stops deduping even before the sweep runs", async () => {
  const backing = testMap<IdempotencyRecord>();
  let t = 0;
  const store = createIdempotencyStore(backing, { retentionMs: 100, pruneIntervalMs: 10_000, now: () => t });
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
  const backing = testMap<IdempotencyRecord>();
  const a = createIdempotencyStore(backing);
  const b = createIdempotencyStore(backing);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let runs = 0;
  const first = a.once("k", async () => {
    runs++;
    await gate;
  });
  while (!(await backing.get("k"))) await new Promise((r) => setImmediate(r));
  assert.equal(await b.once("k", async () => void runs++), false, "the other process sees the live claim");
  assert.equal(await b.committed("k"), false, "a claim is not a commit");
  release();
  assert.equal(await first, true);
  assert.equal(await b.committed("k"), true);
  assert.equal(runs, 1);
});

test("a failed run releases its claim; a crashed holder's claim expires after the lease", async () => {
  const backing = testMap<IdempotencyRecord>();
  let t = 1_000;
  const store = createIdempotencyStore(backing, { claimLeaseMs: 100, now: () => t });
  await assert.rejects(store.once("k", async () => Promise.reject(new Error("boom"))));
  assert.equal(await backing.get("k"), null, "the failed claim is gone");

  await backing.put("crashed", { key: "crashed", at: t, claim: "dead-holder" });
  assert.equal(await store.once("crashed", async () => {}), false, "a fresh foreign claim blocks");
  t += 101;
  let ran = false;
  assert.equal(await store.once("crashed", async () => void (ran = true)), true, "an expired claim is taken over");
  assert.equal(ran, true);
  assert.equal((await backing.get("crashed"))?.claim, undefined);
});
