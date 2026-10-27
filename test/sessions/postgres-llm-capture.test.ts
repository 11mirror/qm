import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { SECURITY_SCREEN_STEP } from "../../src/security/security-screen.ts";
import { scopeId } from "../../src/types.ts";

const URL = process.env.DATABASE_URL!;

test("pg session store: replay windows count usable payloads, not metadata-only screens", async () => {
  let now = Date.now();
  const store = createPostgresSessionStore(URL, { now: () => now });
  const scope = scopeId("personal", "screen-window");
  const session = await store.getOrCreateByThread("screen-window", "dm", scope);
  const record = (promptEnvelope: unknown, step = SECURITY_SCREEN_STEP) =>
    store.recordLlmRequest(session.id, {
      turnSeq: step === SECURITY_SCREEN_STEP ? null : 1,
      step,
      model: "screen-test",
      scopeLabel: scope,
      promptEnvelope,
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, costUsd: 0.01 },
    });
  const envelope = (content: unknown) => ({ messages: [{ role: "user", content }] });

  const unusable = [
    undefined,
    null,
    { system: "Claude configuration only" },
    { threadStart: { model: "Codex" } },
    { system: "OpenCode configuration without messages" },
    { messages: [] },
    { messages: { role: "user", content: "not an array" } },
    { messages: [null] },
    { messages: [{ role: "assistant", content: "not a user payload" }] },
    { messages: [...envelope("one").messages, ...envelope("two").messages] },
    envelope(42),
    envelope(null),
    envelope(["not string content"]),
    envelope(""),
    envelope(" \t\r\n\u00a0\u2003\ufeff "),
  ];
  for (const payload of unusable) await record(payload);
  for (let i = 0; i < 205; i++) await record({ system: "metadata only" });
  assert.deepEqual(await store.listScreenSamples(2), []);
  now -= 2;
  const oldest = await record(envelope("  older usable payload  "));
  now++;
  const newest = await record(envelope("newer usable payload"));
  now += 2;
  await record(envelope("ordinary turn, not a screening"), 0);
  const before = await store.listLlmRequests(session.id);

  assert.deepEqual(
    (await store.listScreenSamples(2)).map((sample) => sample.id),
    [newest.id, oldest.id],
  );
  assert.deepEqual(
    (await store.listScreenSamples(1)).map((sample) => sample.id),
    [newest.id],
  );
  assert.deepEqual(
    (await store.listScreenSamples(1000)).map((sample) => sample.payload),
    ["newer usable payload", "older usable payload"],
  );
  assert.deepEqual(await store.listScreenSamples(0), []);
  assert.deepEqual(await store.listScreenSamples(-1), []);
  assert.equal((await store.listScreenSamples(1.9)).length, 1);
  assert.deepEqual(await store.listLlmRequests(session.id), before);
  assert.equal(before.length, unusable.length + 208);

  const tied = [await record(envelope("tied A")), await record(envelope("tied B"))];
  assert.deepEqual(
    (await store.listScreenSamples(2)).map((sample) => sample.id),
    tied
      .map((row) => row.id)
      .sort()
      .reverse(),
  );
});

test("pg LLM capture retention drops old prompt envelopes and keeps request rows", async () => {
  const day = 86_400_000;
  let at = Date.UTC(2025, 0, 1);
  const store = createPostgresSessionStore(URL, { now: () => at });
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const tag = randomUUID();
  const scope = scopeId("personal", `retention-${tag}`);
  const session = await store.getOrCreateByThread(`retention-${tag}`, "dm", scope);
  const record = (text: string) =>
    store.recordLlmRequest(session.id, {
      turnSeq: 1,
      step: 0,
      model: "retention",
      scopeLabel: scope,
      promptEnvelope: { messages: [{ role: "user", content: `${tag} ${text}` }] },
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, costUsd: 0.5 },
    });
  try {
    const old = await record("old");
    const reused = await record("reused");
    for (let i = 0; i < 250; i++) await record(`bulk ${i}`);
    at += 40 * day;
    const kept = await record("recent");
    await record("reused");
    const range = { from: Date.UTC(2025, 0, 1), to: Date.UTC(2025, 0, 1) + 41 * day };
    await store.refreshSpendRollup();
    const spendBefore = (await store.spendReport(range)).rows;
    const dirtyBefore = Number((await raw.query("SELECT count(*) AS n FROM session_spend_dirty")).rows[0].n);

    assert.equal(await store.purgeLlmCaptures(at - 30 * day, { stop: () => true }), 0);
    assert.equal(await store.purgeLlmCaptures(at - 30 * day), 251);
    assert.equal(await store.purgeLlmCaptures(at - 30 * day), 0);

    const rows = new Map((await store.listLlmRequests(session.id)).map((r) => [r.id, r]));
    assert.equal(rows.size, 254);
    assert.equal(rows.get(old.id)!.promptEnvelope, undefined);
    assert.ok(rows.get(old.id)!.usage, "usage survives the purge");
    assert.ok(rows.get(reused.id)!.promptEnvelope, "an envelope reused within retention survives");
    assert.ok(rows.get(kept.id)!.promptEnvelope);
    assert.equal(
      Number((await raw.query("SELECT count(*) AS n FROM session_spend_dirty")).rows[0].n),
      dirtyBefore,
      "purging prompts does not dirty spend days",
    );
    assert.deepEqual((await store.spendReport(range)).rows, spendBefore);
    assert.deepEqual(await store.spendRollup(range), spendBefore);
    assert.equal(
      (
        await raw.query(
          "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'session_llm_requests' AND column_name = 'request'",
        )
      ).rows[0].n,
      "0",
    );
  } finally {
    await raw.end();
  }
});
