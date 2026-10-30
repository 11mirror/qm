import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FINANCE_RESOURCE_NAME,
  applyFinnyHostEvent,
  createFinnyGoldenLoop,
  digestFinnyEvidence,
  replayFinnyLedger,
  type FinnyHostEvent,
} from "../src/finny/golden-loop.ts";

const at = (second: number) => `2026-10-30T10:00:${String(second).padStart(2, "0")}.000Z`;
const evidence = (label: string) => digestFinnyEvidence(label);

const flow: FinnyHostEvent[] = [
  {
    authority: "qm-host",
    eventId: "event-clarify",
    kind: "clarify_completed",
    occurredAt: at(1),
    evidenceDigest: evidence("raw-sensitive-clarification"),
  },
  {
    authority: "qm-host",
    eventId: "event-preflight",
    kind: "preflight_completed",
    occurredAt: at(2),
    preflightDigest: evidence("preflight"),
    planDigest: evidence("plan"),
    queryDigest: evidence("query"),
    verificationPolicy: "repeatable_read",
    verificationPolicyDigest: evidence("finny-verification-policy:v1:repeatable_read"),
  },
  {
    authority: "qm-host",
    eventId: "event-approval",
    kind: "plan_approved",
    occurredAt: at(3),
    planDigest: evidence("plan"),
    approvalDigest: evidence("raw-sensitive-approval"),
  },
  {
    authority: "qm-host",
    eventId: "event-source",
    kind: "source_collected",
    occurredAt: at(4),
    sourceDigest: evidence("source"),
  },
  {
    authority: "qm-host",
    eventId: "event-artifact-policy",
    kind: "artifact_classified",
    occurredAt: at(5),
    requirement: "required",
    policyDigest: evidence("raw-sensitive-policy-payload"),
  },
  {
    authority: "qm-host",
    eventId: "event-artifact",
    kind: "artifact_produced",
    occurredAt: at(6),
    artifactDigest: evidence("artifact"),
  },
  {
    authority: "qm-host",
    eventId: "event-verification",
    kind: "verification_passed",
    occurredAt: at(7),
    verificationDigest: evidence("verification"),
  },
  {
    authority: "qm-host",
    eventId: "event-delivery",
    kind: "delivery_authorized",
    occurredAt: at(8),
    deliveryDigest: evidence("delivery"),
  },
];

test("the host-owned reducer completes the required-artifact Golden Loop", () => {
  let state = createFinnyGoldenLoop("run-1");
  const stages = [state.stage];
  for (const event of flow) {
    state = applyFinnyHostEvent(state, event);
    stages.push(state.stage);
  }

  assert.deepEqual(stages, [
    "CLARIFY",
    "PREFLIGHT",
    "PREFLIGHT",
    "PLAN_APPROVED",
    "SOURCE",
    "ARTIFACT_REQUIRED",
    "ARTIFACT_REQUIRED",
    "VERIFIED",
    "DELIVERY_ELIGIBLE",
  ]);
  assert.equal(state.profile, "finny");
  assert.equal(state.harness, "pi");
  assert.equal(state.ledger.length, flow.length);
});

test("an optional artifact can advance to verification without an artifact payload", () => {
  const optionalFlow: FinnyHostEvent[] = flow
    .filter((event) => event.kind !== "artifact_produced")
    .map((event) => (event.kind === "artifact_classified" ? { ...event, requirement: "optional" } : event));

  const state = optionalFlow.reduce(applyFinnyHostEvent, createFinnyGoldenLoop("run-2"));
  assert.equal(state.stage, "DELIVERY_ELIGIBLE");
  assert.equal(state.artifactDigest, undefined);
});

test("model assertions and invalid host authority cannot advance state", () => {
  const initial = createFinnyGoldenLoop("run-3");
  assert.throws(
    () =>
      applyFinnyHostEvent(initial, {
        authority: "model",
        eventId: "claim-1",
        kind: "verification_passed",
        occurredAt: at(1),
        verificationDigest: evidence("model-claim"),
      }),
    /host authority/i,
  );
  assert.equal(initial.stage, "CLARIFY");
});

test("out-of-order and replayed events are rejected", () => {
  const initial = createFinnyGoldenLoop("run-4");
  assert.throws(() => applyFinnyHostEvent(initial, flow[2]), /invalid transition/i);

  const clarified = applyFinnyHostEvent(initial, flow[0]);
  assert.throws(() => applyFinnyHostEvent(clarified, flow[0]), /replayed event/i);
});

test("approval must bind to the exact preflight plan digest", () => {
  const preflight = flow.slice(0, 2).reduce(applyFinnyHostEvent, createFinnyGoldenLoop("run-5"));
  assert.throws(
    () =>
      applyFinnyHostEvent(preflight, {
        ...flow[2],
        planDigest: evidence("different-plan"),
      }),
    /plan digest/i,
  );
});

test("required artifacts must exist before verification", () => {
  const artifactRequired = flow.slice(0, 5).reduce(applyFinnyHostEvent, createFinnyGoldenLoop("run-6"));
  assert.throws(() => applyFinnyHostEvent(artifactRequired, flow[6]), /artifact/i);
});

test("ledger metadata is redacted and deterministically replayable", () => {
  const completed = flow.reduce(applyFinnyHostEvent, createFinnyGoldenLoop("run-7"));
  const serialized = JSON.stringify(completed.ledger);
  assert.equal(serialized.includes("raw-sensitive-clarification"), false);
  assert.equal(serialized.includes("raw-sensitive-approval"), false);
  assert.equal(serialized.includes("raw-sensitive-policy-payload"), false);

  const replayed = replayFinnyLedger("run-7", completed.ledger);
  assert.deepEqual(replayed, completed);
  assert.throws(() => replayFinnyLedger("run-7", [...completed.ledger, completed.ledger[0]!]), /replayed event/i);
});

test("the native integration contract exposes one built-in-style finance resource", () => {
  assert.equal(FINANCE_RESOURCE_NAME, "finance");
});

test("a host policy exemption advances a read-only plan without fabricating human approval", () => {
  let state = createFinnyGoldenLoop("run-read-only");
  state = applyFinnyHostEvent(state, {
    authority: "qm-host",
    eventId: "clarify",
    occurredAt: "2026-10-30T10:00:00.000Z",
    kind: "clarify_completed",
    evidenceDigest: evidence("clarify"),
  });
  state = applyFinnyHostEvent(state, {
    authority: "qm-host",
    eventId: "preflight",
    occurredAt: "2026-10-30T10:00:01.000Z",
    kind: "preflight_completed",
    preflightDigest: evidence("preflight"),
    planDigest: evidence("read-only-plan"),
    queryDigest: evidence("query"),
    verificationPolicy: "repeatable_read",
    verificationPolicyDigest: evidence("finny-verification-policy:v1:repeatable_read"),
    approvalRequired: false,
    approvalPolicyDigest: evidence("read-only-policy"),
  });
  state = applyFinnyHostEvent(state, {
    authority: "qm-host",
    eventId: "policy-exemption",
    occurredAt: "2026-10-30T10:00:02.000Z",
    kind: "plan_exempted",
    planDigest: evidence("read-only-plan"),
    approvalPolicyDigest: evidence("read-only-policy"),
  });

  assert.equal(state.stage, "PLAN_APPROVED");
  assert.equal(state.approvalDigest, undefined);
  assert.equal(state.approvalRequired, false);
  assert.equal(replayFinnyLedger("run-read-only", state.ledger).stage, "PLAN_APPROVED");
});

test("operation completions checkpoint inside the approved plan stage and replay deterministically", () => {
  let state = flow.slice(0, 3).reduce(applyFinnyHostEvent, createFinnyGoldenLoop("run-operations"));
  const operationDigest = evidence("operation-source");
  const resultDigest = evidence("operation-result");
  state = applyFinnyHostEvent(state, {
    authority: "qm-host",
    eventId: "run-operations:operation:source",
    occurredAt: at(4),
    kind: "operation_completed",
    operationId: "source",
    primitive: "suiteql_select",
    operationDigest,
    resultDigest,
  });

  assert.equal(state.stage, "PLAN_APPROVED");
  assert.deepEqual(state.completedOperations, {
    source: { primitive: "suiteql_select", operationDigest, resultDigest },
  });
  assert.deepEqual(replayFinnyLedger("run-operations", state.ledger), state);
  assert.throws(
    () =>
      applyFinnyHostEvent(state, {
        authority: "qm-host",
        eventId: "run-operations:operation:other",
        occurredAt: at(5),
        kind: "operation_completed",
        operationId: "source",
        primitive: "suiteql_select",
        operationDigest,
        resultDigest: evidence("changed-result"),
      }),
    /already completed/i,
  );
});

test("plan-native preflight binds reviewed capability and policy authority without a query", () => {
  let state = applyFinnyHostEvent(createFinnyGoldenLoop("run-plan-native"), flow[0]!);
  const catalogDigest = evidence("catalog");
  const manifestDigest = evidence("manifest");
  const operationGraphDigest = evidence("operation-graph");
  const planDigest = evidence("operation-plan");
  const artifactPolicyDigest = evidence("artifact-policy");
  const approvalPolicyDigest = evidence("approval-policy");
  const verificationPolicyDigest = evidence("verification-policy");
  state = applyFinnyHostEvent(state, {
    authority: "qm-host",
    eventId: "run-plan-native:preflight",
    occurredAt: at(2),
    kind: "operation_plan_preflight_completed",
    preflightDigest: evidence("preflight"),
    planDigest,
    catalogDigest,
    manifestDigest,
    capabilityId: "synthetic_inventory_velocity",
    revisionId: "synthetic_inventory_velocity.2026-10-30",
    operationGraphDigest,
    artifactPolicyDigest,
    approvalPolicyDigest,
    verificationPolicyDigest,
    approvalRequired: false,
  });
  state = applyFinnyHostEvent(state, {
    authority: "qm-host",
    eventId: "run-plan-native:exemption",
    occurredAt: at(3),
    kind: "plan_exempted",
    planDigest,
    approvalPolicyDigest,
  });

  assert.equal(state.queryDigest, undefined);
  assert.equal(state.catalogDigest, catalogDigest);
  assert.equal(state.manifestDigest, manifestDigest);
  assert.equal(state.capabilityId, "synthetic_inventory_velocity");
  assert.equal(state.revisionId, "synthetic_inventory_velocity.2026-10-30");
  assert.equal(state.operationGraphDigest, operationGraphDigest);
  assert.equal(state.artifactPolicyDigest, artifactPolicyDigest);
  assert.equal(state.verificationPolicyDigest, verificationPolicyDigest);
  assert.deepEqual(replayFinnyLedger("run-plan-native", state.ledger), state);
});
