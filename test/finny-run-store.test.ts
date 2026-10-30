import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFinnyHostEvent,
  createFinnyGoldenLoop,
  digestFinnyEvidence,
  type FinnyHostEvent,
  type FinnyLedgerMetadata,
} from "../src/finny/golden-loop.ts";
import { createFinnyRunStore, type FinnyRunV2Binding, type FinnyRunV2Checkpoint } from "../src/finny/run-store.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const v2Binding: FinnyRunV2Binding = {
  schema: "finny.run.v2",
  runId: "run-v2",
  requestDigest: digestFinnyEvidence("request-v2"),
  sessionId: "session-v2",
  scopeId: "scope-v2",
  plan: {
    catalogDigest: digestFinnyEvidence("catalog"),
    capabilityId: "ap-gl-control-balance",
    revisionId: "2026-10-30",
    operationGraphDigest: digestFinnyEvidence("operation-graph"),
    planDigest: digestFinnyEvidence("plan-v2"),
  },
};

const event = (
  eventId: string,
  kind: FinnyHostEvent["kind"],
  second: number,
  fields: Record<string, unknown>,
): FinnyHostEvent =>
  ({
    authority: "qm-host",
    eventId,
    kind,
    occurredAt: `2026-10-30T10:00:${String(second).padStart(2, "0")}.000Z`,
    ...fields,
  }) as FinnyHostEvent;

function ledgerFor(events: readonly FinnyHostEvent[], runId: string = v2Binding.runId): readonly FinnyLedgerMetadata[] {
  let state = createFinnyGoldenLoop(runId);
  for (const item of events) state = applyFinnyHostEvent(state, item);
  return state.ledger;
}

const clarify = event("clarify", "clarify_completed", 1, {
  evidenceDigest: digestFinnyEvidence("clarification"),
});
const preflight = event("preflight", "preflight_completed", 2, {
  preflightDigest: digestFinnyEvidence("preflight"),
  planDigest: digestFinnyEvidence("plan"),
  queryDigest: digestFinnyEvidence("query"),
  verificationPolicy: "repeatable_read",
  verificationPolicyDigest: digestFinnyEvidence("finny-verification-policy:v1:repeatable_read"),
});
const approval = event("approval", "plan_approved", 3, {
  planDigest: digestFinnyEvidence("plan"),
  approvalDigest: digestFinnyEvidence("approval"),
});
const source = event("source", "source_collected", 4, {
  sourceDigest: digestFinnyEvidence("source"),
});
const artifactPolicy = event("artifact-policy", "artifact_classified", 5, {
  requirement: "required",
  policyDigest: digestFinnyEvidence("artifact-policy"),
});
const artifact = event("artifact", "artifact_produced", 6, {
  artifactDigest: digestFinnyEvidence("artifact"),
});

test("initialization binds a run once and is visible through another store instance", async () => {
  const backing = createMemoryMap<FinnyRunV2Checkpoint>();
  const first = createFinnyRunStore(backing, () => "2026-10-30T11:00:00.000Z");
  const second = createFinnyRunStore(backing, () => "2026-10-30T12:00:00.000Z");

  const initialized = await first.initialize(v2Binding);
  const repeated = await second.initialize(v2Binding);

  assert.deepEqual(repeated, initialized);
  assert.deepEqual(await second.load(v2Binding.runId), initialized);
  assert.deepEqual(Object.keys((await backing.get(v2Binding.runId))!).sort(), [
    "ledger",
    "plan",
    "requestDigest",
    "runId",
    "schema",
    "scopeId",
    "sessionId",
    "updatedAt",
  ]);
});

test("initialization rejects a conflicting request or session binding", async () => {
  const store = createFinnyRunStore(createMemoryMap(), () => "2026-10-30T11:00:00.000Z");
  await store.initialize(v2Binding);

  await assert.rejects(store.initialize({ ...v2Binding, requestDigest: digestFinnyEvidence("other") }), /binding/i);
  await assert.rejects(store.initialize({ ...v2Binding, sessionId: "session-2" }), /binding/i);
  await assert.rejects(store.initialize({ ...v2Binding, scopeId: "scope-2" }), /binding/i);
});

test("v2 initialization persists one canonical plan binding without an artifact request", async () => {
  const backing = createMemoryMap<FinnyRunV2Checkpoint>();
  const store = createFinnyRunStore(backing, () => "2026-10-30T11:00:00.000Z");

  const initialized = await store.initialize(v2Binding);

  assert.deepEqual(initialized, {
    ...v2Binding,
    ledger: [],
    updatedAt: "2026-10-30T11:00:00.000Z",
  });
  assert.equal("artifactRequest" in initialized, false);
  assert.deepEqual(Object.keys((await backing.get(v2Binding.runId))!).sort(), [
    "ledger",
    "plan",
    "requestDigest",
    "runId",
    "schema",
    "scopeId",
    "sessionId",
    "updatedAt",
  ]);
});

test("v2 initialization rejects conflicting plan identity", async () => {
  const store = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  await store.initialize(v2Binding);

  for (const [field, value] of [
    ["catalogDigest", digestFinnyEvidence("other-catalog")],
    ["capabilityId", "inventory-velocity"],
    ["revisionId", "2026-10-31"],
    ["operationGraphDigest", digestFinnyEvidence("other-operation-graph")],
    ["planDigest", digestFinnyEvidence("other-plan")],
  ] as const) {
    await assert.rejects(store.initialize({ ...v2Binding, plan: { ...v2Binding.plan, [field]: value } }), /binding/i);
  }
});

test("v2 initialization rejects malformed plan identity", async () => {
  const store = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  const malformed = [
    { ...v2Binding.plan, catalogDigest: "sha256:not-a-digest" },
    { ...v2Binding.plan, capabilityId: "" },
    { ...v2Binding.plan, revisionId: "" },
    { ...v2Binding.plan, operationGraphDigest: "not-a-digest" },
    { ...v2Binding.plan, planDigest: "not-a-digest" },
  ];

  for (const plan of malformed)
    await assert.rejects(store.initialize({ ...v2Binding, plan } as FinnyRunV2Binding), /plan identity/i);
});

test("v2 initialization rejects a duplicated artifact request", async () => {
  const store = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());

  await assert.rejects(
    store.initialize({ ...v2Binding, artifactRequest: "required" } as FinnyRunV2Binding),
    /artifact request/i,
  );
});

test("v2 initialization rejects an invalid persisted schema", async () => {
  const backing = createMemoryMap<FinnyRunV2Checkpoint>();
  await backing.put(v2Binding.runId, {
    ...v2Binding,
    schema: "finny.run.v3",
    ledger: [],
    updatedAt: "2026-10-30T10:00:00.000Z",
  } as unknown as FinnyRunV2Checkpoint);
  const store = createFinnyRunStore(backing);

  await assert.rejects(store.initialize(v2Binding), /schema/i);
  await assert.rejects(store.load(v2Binding.runId), /schema/i);
});

test("checkpoint preserves the exact v2 plan binding", async () => {
  const store = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  await store.initialize(v2Binding);
  const metadata = ledgerFor([clarify], v2Binding.runId)[0]!;

  const checkpoint = await store.checkpoint(v2Binding.runId, metadata);

  assert.equal(checkpoint.schema, "finny.run.v2");
  assert.deepEqual(checkpoint.plan, v2Binding.plan);
  assert.equal("artifactRequest" in checkpoint, false);
});

test("checkpoint atomically appends valid ledger metadata and preserves the artifact reference", async () => {
  const backing = createMemoryMap<FinnyRunV2Checkpoint>();
  const first = createFinnyRunStore(backing, () => "2026-10-30T11:00:00.000Z");
  const second = createFinnyRunStore(backing, () => "2026-10-30T12:00:00.000Z");
  await first.initialize(v2Binding);
  const ledger = ledgerFor([clarify, preflight, approval, source, artifactPolicy, artifact], v2Binding.runId);

  for (const metadata of ledger.slice(0, -1)) await first.checkpoint(v2Binding.runId, metadata);
  const saved = await second.checkpoint(v2Binding.runId, ledger.at(-1)!, "file:artifact-1");

  assert.deepEqual(saved.ledger, ledger);
  assert.equal(saved.artifactReference, "file:artifact-1");
  assert.equal(saved.updatedAt, "2026-10-30T12:00:00.000Z");
  assert.deepEqual(await first.load(v2Binding.runId), saved);
});

test("checkpoint deduplicates an already persisted event", async () => {
  const times = ["2026-10-30T11:00:00.000Z", "2026-10-30T11:01:00.000Z", "2026-10-30T11:02:00.000Z"];
  const store = createFinnyRunStore(createMemoryMap(), () => times.shift()!);
  await store.initialize(v2Binding);
  const metadata = ledgerFor([clarify])[0]!;
  const first = await store.checkpoint(v2Binding.runId, metadata);

  const duplicate = await store.checkpoint(v2Binding.runId, metadata);

  assert.deepEqual(duplicate, first);
  assert.equal(duplicate.ledger.length, 1);
  assert.equal(duplicate.updatedAt, "2026-10-30T11:01:00.000Z");
});

test("checkpoint rejects a reused event ID with different evidence", async () => {
  const store = createFinnyRunStore(createMemoryMap(), () => "2026-10-30T11:00:00.000Z");
  await store.initialize(v2Binding);
  const metadata = ledgerFor([clarify])[0]!;
  await store.checkpoint(v2Binding.runId, metadata);

  await assert.rejects(
    store.checkpoint(v2Binding.runId, {
      ...metadata,
      evidence: [{ role: "clarification", digest: digestFinnyEvidence("different") }],
    }),
    /conflicting event/i,
  );
});

test("checkpoint rejects an out-of-order ledger entry without changing the run", async () => {
  const store = createFinnyRunStore(createMemoryMap(), () => "2026-10-30T11:00:00.000Z");
  const initial = await store.initialize(v2Binding);
  const outOfOrder = ledgerFor([clarify, preflight, approval])[2]!;

  await assert.rejects(store.checkpoint(v2Binding.runId, outOfOrder), /stage|transition/i);
  assert.deepEqual(await store.load(v2Binding.runId), initial);
});

test("run work is serialized across store instances sharing the distributed lock", async () => {
  const backing = createMemoryMap<FinnyRunV2Checkpoint>();
  const lock = createMemoryAdvisoryLock();
  const first = createFinnyRunStore(backing, undefined, lock);
  const second = createFinnyRunStore(backing, undefined, lock);
  let active = 0;
  let maximum = 0;

  const work = (store: typeof first) =>
    store.withRunLock(v2Binding.runId, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    });

  await Promise.all([work(first), work(second)]);

  assert.equal(maximum, 1);
});
