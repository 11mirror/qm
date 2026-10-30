import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFinnyHostEvent,
  createFinnyGoldenLoop,
  digestFinnyEvidence,
  type FinnyHostEvent,
  type FinnyLedgerMetadata,
} from "../src/finny/golden-loop.ts";
import { createFinnyRunStore, type FinnyRunCheckpoint } from "../src/finny/run-store.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const binding = {
  runId: "run-1",
  requestDigest: digestFinnyEvidence("request"),
  sessionId: "session-1",
  scopeId: "scope-1",
  artifactRequest: "optional" as const,
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

function ledgerFor(events: readonly FinnyHostEvent[]): readonly FinnyLedgerMetadata[] {
  let state = createFinnyGoldenLoop(binding.runId);
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
  const backing = createMemoryMap<FinnyRunCheckpoint>();
  const first = createFinnyRunStore(backing, () => "2026-10-30T11:00:00.000Z");
  const second = createFinnyRunStore(backing, () => "2026-10-30T12:00:00.000Z");

  const initialized = await first.initialize(binding);
  const repeated = await second.initialize(binding);

  assert.deepEqual(repeated, initialized);
  assert.deepEqual(await second.load(binding.runId), initialized);
  assert.deepEqual(Object.keys((await backing.get(binding.runId))!).sort(), [
    "artifactRequest",
    "ledger",
    "requestDigest",
    "runId",
    "scopeId",
    "sessionId",
    "updatedAt",
  ]);
});

test("initialization rejects a conflicting request or session binding", async () => {
  const store = createFinnyRunStore(createMemoryMap(), () => "2026-10-30T11:00:00.000Z");
  await store.initialize(binding);

  await assert.rejects(store.initialize({ ...binding, requestDigest: digestFinnyEvidence("other") }), /binding/i);
  await assert.rejects(store.initialize({ ...binding, sessionId: "session-2" }), /binding/i);
  await assert.rejects(store.initialize({ ...binding, scopeId: "scope-2" }), /binding/i);
  await assert.rejects(store.initialize({ ...binding, artifactRequest: "required" }), /artifact request/i);
});

test("initialization rejects a checkpoint without its canonical artifact request", async () => {
  const backing = createMemoryMap<FinnyRunCheckpoint>();
  await backing.put(binding.runId, {
    runId: binding.runId,
    requestDigest: binding.requestDigest,
    sessionId: binding.sessionId,
    scopeId: binding.scopeId,
    ledger: [],
    updatedAt: "2026-10-30T10:00:00.000Z",
  } as unknown as FinnyRunCheckpoint);
  const store = createFinnyRunStore(backing);

  await assert.rejects(store.initialize(binding), /artifact request/i);
});

test("checkpoint atomically appends valid ledger metadata and preserves the artifact reference", async () => {
  const backing = createMemoryMap<FinnyRunCheckpoint>();
  const first = createFinnyRunStore(backing, () => "2026-10-30T11:00:00.000Z");
  const second = createFinnyRunStore(backing, () => "2026-10-30T12:00:00.000Z");
  await first.initialize(binding);
  const ledger = ledgerFor([clarify, preflight, approval, source, artifactPolicy, artifact]);

  for (const metadata of ledger.slice(0, -1)) await first.checkpoint(binding.runId, metadata);
  const saved = await second.checkpoint(binding.runId, ledger.at(-1)!, "file:artifact-1");

  assert.deepEqual(saved.ledger, ledger);
  assert.equal(saved.artifactReference, "file:artifact-1");
  assert.equal(saved.updatedAt, "2026-10-30T12:00:00.000Z");
  assert.deepEqual(await first.load(binding.runId), saved);
});

test("checkpoint deduplicates an already persisted event", async () => {
  const times = ["2026-10-30T11:00:00.000Z", "2026-10-30T11:01:00.000Z", "2026-10-30T11:02:00.000Z"];
  const store = createFinnyRunStore(createMemoryMap(), () => times.shift()!);
  await store.initialize(binding);
  const metadata = ledgerFor([clarify])[0]!;
  const first = await store.checkpoint(binding.runId, metadata);

  const duplicate = await store.checkpoint(binding.runId, metadata);

  assert.deepEqual(duplicate, first);
  assert.equal(duplicate.ledger.length, 1);
  assert.equal(duplicate.updatedAt, "2026-10-30T11:01:00.000Z");
});

test("checkpoint rejects a reused event ID with different evidence", async () => {
  const store = createFinnyRunStore(createMemoryMap(), () => "2026-10-30T11:00:00.000Z");
  await store.initialize(binding);
  const metadata = ledgerFor([clarify])[0]!;
  await store.checkpoint(binding.runId, metadata);

  await assert.rejects(
    store.checkpoint(binding.runId, {
      ...metadata,
      evidence: [{ role: "clarification", digest: digestFinnyEvidence("different") }],
    }),
    /conflicting event/i,
  );
});

test("checkpoint rejects an out-of-order ledger entry without changing the run", async () => {
  const store = createFinnyRunStore(createMemoryMap(), () => "2026-10-30T11:00:00.000Z");
  const initial = await store.initialize(binding);
  const outOfOrder = ledgerFor([clarify, preflight, approval])[2]!;

  await assert.rejects(store.checkpoint(binding.runId, outOfOrder), /stage|transition/i);
  assert.deepEqual(await store.load(binding.runId), initial);
});

test("run work is serialized across store instances sharing the distributed lock", async () => {
  const backing = createMemoryMap<FinnyRunCheckpoint>();
  const lock = createMemoryAdvisoryLock();
  const first = createFinnyRunStore(backing, undefined, lock);
  const second = createFinnyRunStore(backing, undefined, lock);
  let active = 0;
  let maximum = 0;

  const work = (store: typeof first) =>
    store.withRunLock(binding.runId, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    });

  await Promise.all([work(first), work(second)]);

  assert.equal(maximum, 1);
});
