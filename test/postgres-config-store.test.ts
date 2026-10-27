import { test } from "node:test";
import assert from "node:assert/strict";
import type { PersistedInstructions, PersistedInstructionsRevision } from "../src/resolution/config-store.ts";
import { CONFIG_TABLES } from "../src/resolution/config-tables.ts";
import { typedTable } from "../src/persistence/typed-table.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { defaultOrgPolicy } from "../src/policy/command-policy.ts";
import { scopeId } from "../src/types.ts";
import { testConfigStore, testDatabaseUrl } from "./support/test-database.ts";

function tables() {
  const databaseUrl = testDatabaseUrl();
  const db = createPgPool(databaseUrl);
  return {
    open: () => testConfigStore("default-org", { databaseUrl }),
    instructions: typedTable<PersistedInstructions>(db, CONFIG_TABLES.instructions),
    legacyHistory: typedTable<PersistedInstructionsRevision>(db, CONFIG_TABLES.instructionsHistory),
  };
}

test("SOUL compare-and-set permits only one writer and keeps current plus history in one durable row", async () => {
  const { open, instructions } = tables();
  const left = open();
  const right = open();
  const channel = scopeId("channel", "CAS");

  const results = await Promise.all([
    left.setInstructionsIfVersion(channel, 0, "left", "alice"),
    right.setInstructionsIfVersion(channel, 0, "right", "bob"),
  ]);
  assert.deepEqual(
    results.sort((a, b) => (a ?? 99) - (b ?? 99)),
    [1, null],
  );

  const durable = await instructions.get(channel);
  assert.equal(durable?.history?.length, 1);
  assert.equal(durable?.history?.[0]?.content, durable?.content);
  for (let version = 1; version < 30; version++) {
    assert.equal(
      await left.setInstructionsIfVersion(channel, version, `revision ${version + 1}`, "alice"),
      version + 1,
    );
  }
  assert.equal(
    (await instructions.get(channel))?.history?.length,
    30,
    "the canonical row retains the full durable history",
  );
  assert.equal(left.instructionsHistory(channel).length, 25, "the operator view remains bounded");
  const fresh = open();
  await fresh.hydrate?.();
  assert.equal(fresh.instructionsHistory(channel)[0]?.content, fresh.getInstructions(channel));
  await right.refreshScope(channel);
  assert.equal(
    right.instructionsHistory(channel)[0]?.content,
    right.getInstructions(channel),
    "a cross-instance refresh advances current SOUL and history together",
  );
});

test("SOUL snapshot restore preserves the canonical version and history byte-for-byte across cores", async () => {
  const { open } = tables();
  const left = open();
  const right = open();
  const channel = scopeId("channel", "snapshot");
  await left.setInstructions(channel, "one", "alice");
  await left.setInstructions(channel, "two", "bob");
  const snapshot = await left.captureInstructionsSnapshot(channel);

  await right.refreshScope(channel);
  await right.setInstructions(channel, "attempted import", "importer");
  assert.equal(await left.restoreInstructionsSnapshot(channel, snapshot), true);
  await right.refreshScope(channel);

  assert.deepEqual(await right.captureInstructionsSnapshot(channel), snapshot);
  assert.equal(right.getInstructions(channel), "two");
  assert.equal(right.instructionsVersion(channel), 2);
  assert.deepEqual(right.instructionsHistory(channel), snapshot?.history);
});

test("setInstructions advances the canonical row without trusting a stale instance cache", async () => {
  const { open, instructions } = tables();
  const left = open();
  const right = open();
  const channel = scopeId("channel", "latest");

  assert.equal(await left.setInstructions(channel, "left", "alice"), 1);
  assert.equal(right.instructionsVersion(channel), 0);
  assert.equal(await right.setInstructions(channel, "right", "bob"), 2);

  const durable = await instructions.get(channel);
  assert.equal(durable?.version, 2);
  assert.deepEqual(
    durable?.history?.map(({ version, content }) => ({ version, content })),
    [
      { version: 2, content: "right" },
      { version: 1, content: "left" },
    ],
  );
});

test("the first write after upgrade retains a canonical revision that predates embedded history", async () => {
  const { open, instructions } = tables();
  const channel = scopeId("channel", "pre-history-upgrade");
  await instructions.put(channel, { scopeId: channel, content: "pre-upgrade", version: 8 });
  const store = open();

  assert.equal(await store.setInstructions(channel, "post-upgrade", "alice"), 9);
  assert.deepEqual(
    (await instructions.get(channel))?.history?.map(({ version, content, updatedAt }) => ({
      version,
      content,
      updatedAt,
    })),
    [
      { version: 9, content: "post-upgrade", updatedAt: (await instructions.get(channel))!.updatedAt },
      { version: 8, content: "pre-upgrade", updatedAt: 0 },
    ],
  );
});

test("refreshScope merges legacy SOUL history into a canonical row and migrates it safely", async () => {
  const { open, instructions, legacyHistory } = tables();
  const channel = scopeId("channel", "legacy-refresh");
  const revision: PersistedInstructionsRevision = {
    scopeId: channel,
    content: "legacy current",
    version: 4,
    updatedAt: 40,
    updatedBy: "alice",
  };
  await instructions.put(channel, { ...revision });
  await legacyHistory.put(`${channel}:4`, revision);
  await legacyHistory.put(`${channel}:3`, {
    scopeId: channel,
    content: "legacy prior",
    version: 3,
    updatedAt: 30,
    updatedBy: "bob",
  });
  const store = open();

  await store.hydrate?.();
  await store.refreshScope(channel);
  await store.refreshScope(channel);

  assert.deepEqual(
    store.instructionsHistory(channel).map(({ version, content }) => ({ version, content })),
    [
      { version: 4, content: "legacy current" },
      { version: 3, content: "legacy prior" },
    ],
  );
  assert.deepEqual(
    (await instructions.get(channel))?.history,
    store.instructionsHistory(channel),
    "refresh atomically migrates legacy revisions into the canonical row",
  );
});

test("embedded history prevents a stale core from re-injecting legacy revisions after restore", async () => {
  const { open, instructions, legacyHistory } = tables();
  const restored = scopeId("channel", "legacy-restored");
  await instructions.put(restored, { scopeId: restored, content: "legacy current", version: 4, updatedAt: 40 });
  await legacyHistory.put(`${restored}:4`, { scopeId: restored, content: "legacy current", version: 4, updatedAt: 40 });
  await legacyHistory.put(`${restored}:3`, { scopeId: restored, content: "legacy prior", version: 3, updatedAt: 30 });
  const left = open();
  const stale = open();
  await Promise.all([left.hydrate?.(), stale.hydrate?.()]);

  const restoredSnapshot: PersistedInstructions = {
    scopeId: restored,
    content: "restored canonical",
    version: 1,
    updatedAt: 50,
    history: [],
  };
  assert.equal(await left.restoreInstructionsSnapshot(restored, restoredSnapshot), true);
  await stale.refreshScope(restored);
  assert.deepEqual((await instructions.get(restored))?.history, []);
  assert.equal(await stale.setInstructions(restored, "after restore", "bob"), 2);
  assert.deepEqual(
    (await instructions.get(restored))?.history?.map(({ version, content }) => ({ version, content })),
    [
      { version: 2, content: "after restore" },
      { version: 1, content: "restored canonical" },
    ],
  );
});

test("pg config store: scoped soul/policy/egress/flags survive a restart (write-through + hydrate)", async () => {
  const { open } = tables();
  const ch = scopeId("channel", "C1");
  const policy = defaultOrgPolicy();

  const a = open();
  const version = await a.setInstructions(ch, "a channel-specific soul");
  await a.setSetting("commandPolicy", policy, ch);
  await a.setApprovalGrantModes(ch, { session: false, always: true });
  await a.setSetting("egress", { allowedHosts: ["api.example.com"], deniedHosts: ["evil.example"] }, ch);
  await a.setRuntimeSelection(ch, { modelId: "claude-opus-4-8" });
  await a.setSetting("browseMaxSteps", 120, ch);
  await a.setSetting("browseModel", "claude-sonnet-4-6", ch);

  const b = open();
  assert.equal(b.getInstructions(ch), null, "a cold instance has no scoped soul until it hydrates");
  await b.hydrate?.();

  assert.equal(b.getInstructions(ch), "a channel-specific soul", "the scoped soul survived the restart");
  assert.equal(b.instructionsVersion(ch), version, "the soul version round-trips (monotonic across restart)");
  assert.equal(
    b.instructionsHistory(ch)[0]?.content,
    "a channel-specific soul",
    "the revision history survives a restart",
  );
  assert.deepEqual(b.setting("commandPolicy", ch), policy, "the command policy survived");
  assert.deepEqual(
    b.setting("egress", ch),
    { allowedHosts: ["api.example.com"], deniedHosts: ["evil.example"] },
    "the egress policy survived",
  );
  assert.equal(b.getRuntimeSelection(ch)?.modelId ?? null, "claude-opus-4-8", "the base model survived");
  assert.equal(b.setting("browseMaxSteps", ch), 120, "the browse step limit survived");
  assert.equal(b.setting("browseModel", ch), "claude-sonnet-4-6", "the browse model survived");
});

test("pg config store: rapid overlapping writes to one scope converge to the last value (serialized write-through)", async () => {
  const { open } = tables();
  const ch = scopeId("channel", "C2");
  const a = open();

  let lastVersion = 0;
  for (let i = 1; i <= 8; i++) {
    lastVersion = await a.setInstructions(ch, `soul v${i}`);
    await a.setSetting("egress", { allowedHosts: [`host${i}.example`], deniedHosts: [] }, ch);
  }
  await a.setRuntimeSelection(ch, { modelId: "claude-opus-4-8" });
  await a.setRuntimeSelection(ch, null);
  await a.setSetting("browseMaxSteps", 60, ch);
  await a.setSetting("browseMaxSteps", null, ch);
  await a.setSetting("browseModel", "claude-sonnet-4-6", ch);
  await a.setSetting("browseModel", null, ch);

  const b = open();
  await b.hydrate?.();
  assert.equal(
    b.getInstructions(ch),
    "soul v8",
    "the durable soul ends on the last write, not a reordered earlier one",
  );
  assert.equal(b.instructionsVersion(ch), lastVersion);
  assert.deepEqual(
    b.setting("egress", ch),
    { allowedHosts: ["host8.example"], deniedHosts: [] },
    "the durable egress ends on the last write",
  );
  assert.equal(b.getRuntimeSelection(ch)?.modelId ?? null, null, "a cleared base model stays cleared after restart");
  assert.equal(b.setting("browseMaxSteps", ch), null, "a cleared browse step limit stays cleared after restart");
  assert.equal(b.setting("browseModel", ch), null, "a cleared browse model stays cleared after restart");
});

test("pg config store: settings written on one core reach another core through refreshScope", async () => {
  const { open } = tables();
  const ch = scopeId("channel", "C4");
  const org = scopeId("org", "default-org");
  const a = open();
  const b = open();
  await a.hydrate?.();
  await b.hydrate?.();

  await a.setSetting("webuiModels", ["claude-opus-4-8"], ch);
  await a.setSetting("ackEmoji", ["eyes"], ch);
  await a.setSetting("browseMaxSteps", 77, ch);
  await a.setSetting("browseModel", "claude-sonnet-4-6", ch);
  await a.setSetting("branding", { accent: "#123456" }, ch);
  await a.setSetting("channelHeaderPin", true, ch);
  await a.setApprovalGrantModes(ch, { session: false, always: true });
  await a.setSetting("orgAmbient", false);
  await a.setSetting("autoFlagger", { modelId: "claude-opus-4-8", rubric: "flag it" });
  await b.refreshScope(ch);
  await b.refreshScope(org);

  assert.deepEqual(b.setting("webuiModels", ch), ["claude-opus-4-8"]);
  assert.deepEqual(b.setting("ackEmoji", ch), ["eyes"]);
  assert.equal(b.setting("browseMaxSteps", ch), 77);
  assert.equal(b.setting("browseModel", ch), "claude-sonnet-4-6");
  assert.deepEqual(b.setting("branding", ch), { accent: "#123456" });
  assert.equal(b.setting("channelHeaderPin", ch), true);
  assert.deepEqual(b.getApprovalGrantModes(ch), { session: false, always: true });
  assert.equal(b.setting("orgAmbient"), false);
  assert.equal(b.setting("autoFlagger")?.rubric, "flag it");

  await a.setSetting("webuiModels", null, ch);
  await a.setSetting("ackEmoji", null, ch);
  await a.setSetting("browseMaxSteps", null, ch);
  await a.setSetting("browseModel", null, ch);
  await b.refreshScope(ch);
  await b.refreshScope(org);

  assert.equal(b.setting("webuiModels", ch), null);
  assert.equal(b.setting("ackEmoji", ch), null);
  assert.equal(b.setting("browseMaxSteps", ch), null);
  assert.equal(b.setting("browseModel", ch), null);
});
