import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecentDmPosts, recentPrincipalDeliveryNote } from "../../src/surfaces/recent-dm-posts.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { FIRE_RETENTION_MS } from "../../src/cron/cron-store.ts";

const store = createRecentDmPosts(testDatabaseUrl());

test("every delivery since the user's last message is kept and reported, however many", async () => {
  const thread = "dm:D-many";
  for (let i = 1; i <= 12; i++) await store.remember(thread, { key: `k${i}`, text: `delivery ${i}`, at: i * 1000 });
  await store.remember(thread, { key: "k12", text: "replayed", at: 99_000 });
  assert.equal((await store.posts(thread)).length, 12, "a replayed key does not duplicate its delivery");
  const note = await recentPrincipalDeliveryNote(store, thread, 0);
  for (let i = 1; i <= 12; i++) assert.match(note, new RegExp(`: delivery ${i}$`, "m"));
});

test("deliveries before the user's last message are forgotten once the note has moved past them", async () => {
  const thread = "dm:D-cutoff";
  await store.remember(thread, { key: "a", text: "older", at: 1000 });
  await store.remember(thread, { key: "b", text: "newer", at: 3000 });
  const note = await recentPrincipalDeliveryNote(store, thread, 2000);
  assert.match(note, /: newer$/m);
  assert.doesNotMatch(note, /older/);
  assert.deepEqual(
    (await store.posts(thread)).map((p) => p.key),
    ["b"],
  );
  assert.equal(await recentPrincipalDeliveryNote(store, thread, 3000), "");
  assert.deepEqual(await store.posts(thread), []);
});

test("a delivery is remembered only as long as the fire that produced it is retained", async () => {
  const thread = "dm:D-stale";
  const now = Date.now();
  await store.remember(thread, { key: "old", text: "ancient", at: now - FIRE_RETENTION_MS - 1 });
  await store.remember(thread, { key: "mid", text: "kept", at: now - 1000 });
  await store.remember(thread, { key: "new", text: "fresh", at: now });
  assert.deepEqual(
    (await store.posts(thread)).map((p) => p.key),
    ["mid", "new"],
  );
});

test("a delivery is listed in full, multi-line posts indented under their header", async () => {
  const thread = "dm:D-lines";
  await store.remember(thread, {
    key: "x",
    text: "Deploy digest\n\n- api: green\n- web: green",
    at: 500,
    trigger: "cron",
  });
  await store.remember(thread, { key: "y", text: "  one liner  ", at: 600, onBehalfOf: "U-carol" });
  const note = await recentPrincipalDeliveryNote(store, thread);
  assert.match(note, /\[cron\]:\n {2}Deploy digest\n {2}\n {2}- api: green\n {2}- web: green$/m);
  assert.match(note, / from U-carol: one liner$/m);
});
