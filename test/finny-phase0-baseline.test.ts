import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFinnyBaseline } from "../evals/finny-high-performance-v1/baseline.mts";

const sessions = {
  parent: "parent-session",
  producer: "producer-session",
  auditor: "auditor-session",
} as const;

test("Phase 0 reports worker turns, certified delivery latency, and complete role token usage", () => {
  const result = analyzeFinnyBaseline({
    queryAt: 1_000,
    artifactReadyAt: 4_000,
    certifiedDeliveredAt: 9_500,
    sessions,
    runs: [
      { id: "producer-run", sessionId: sessions.producer, startedAt: 2_000, finishedAt: 4_000 },
      { id: "auditor-run", sessionId: sessions.auditor, startedAt: 4_001, finishedAt: 8_000 },
    ],
    llmRequests: [
      { id: "parent-call", sessionId: sessions.parent, turnSeq: 1, step: 0, usage: { totalTokens: 100 } },
      { id: "producer-call-1", sessionId: sessions.producer, turnSeq: 1, step: 0, usage: { totalTokens: 200 } },
      { id: "producer-call-2", sessionId: sessions.producer, turnSeq: 1, step: 1, usage: { totalTokens: 50 } },
      { id: "auditor-call", sessionId: sessions.auditor, turnSeq: 1, step: 0, usage: { totalTokens: 75 } },
    ],
  });

  assert.deepEqual(result.turns, {
    producerRunCount: 1,
    auditorRunCount: 1,
    auditorRunsBeforeArtifact: [],
  });
  assert.equal(result.queryToCertifiedDeliveryMs, 8_500);
  assert.deepEqual(result.tokens, {
    complete: true,
    parent: 100,
    producer: 250,
    auditor: 75,
    total: 425,
    missingUsageRequestIds: [],
    missingUsageRoles: [],
  });
  assert.equal(result.phase1GatePassed, true);
});

test("Phase 0 fails closed when Auditor starts before artifact or any role usage is missing", () => {
  const result = analyzeFinnyBaseline({
    queryAt: 1_000,
    artifactReadyAt: 5_000,
    certifiedDeliveredAt: 10_000,
    sessions,
    runs: [
      { id: "producer-run", sessionId: sessions.producer, startedAt: 2_000, finishedAt: 6_000 },
      { id: "premature-auditor-run", sessionId: sessions.auditor, startedAt: 2_100, finishedAt: 2_500 },
      { id: "artifact-auditor-run", sessionId: sessions.auditor, startedAt: 5_001, finishedAt: 9_000 },
    ],
    llmRequests: [
      { id: "parent-call", sessionId: sessions.parent, turnSeq: 1, step: 0, usage: { totalTokens: 100 } },
      { id: "producer-call", sessionId: sessions.producer, turnSeq: 1, step: 0, usage: null },
      { id: "auditor-call", sessionId: sessions.auditor, turnSeq: 1, step: 0, usage: { totalTokens: 75 } },
    ],
  });

  assert.deepEqual(result.turns, {
    producerRunCount: 1,
    auditorRunCount: 2,
    auditorRunsBeforeArtifact: ["premature-auditor-run"],
  });
  assert.deepEqual(result.tokens, {
    complete: false,
    parent: 100,
    producer: null,
    auditor: 75,
    total: null,
    missingUsageRequestIds: ["producer-call"],
    missingUsageRoles: [],
  });
  assert.equal(result.phase1GatePassed, false);
});

test("Phase 0 marks a role with no durable LLM usage as incomplete", () => {
  const result = analyzeFinnyBaseline({
    queryAt: 1_000,
    artifactReadyAt: 5_000,
    certifiedDeliveredAt: 10_000,
    sessions,
    runs: [
      { id: "producer-run", sessionId: sessions.producer, startedAt: 2_000, finishedAt: 5_000 },
      { id: "auditor-run", sessionId: sessions.auditor, startedAt: 5_001, finishedAt: 9_000 },
    ],
    llmRequests: [
      { id: "parent-call", sessionId: sessions.parent, turnSeq: 1, step: 0, usage: { totalTokens: 100 } },
      { id: "producer-call", sessionId: sessions.producer, turnSeq: 1, step: 0, usage: { totalTokens: 200 } },
    ],
  });

  assert.equal(result.tokens.complete, false);
  assert.equal(result.tokens.auditor, null);
  assert.equal(result.tokens.total, null);
  assert.deepEqual(result.tokens.missingUsageRoles, ["auditor"]);
});

test("Phase 0 counts role-attributed runs when run and usage session identities differ", () => {
  const result = analyzeFinnyBaseline({
    queryAt: 1_000,
    artifactReadyAt: 5_000,
    certifiedDeliveredAt: 10_000,
    sessions,
    runs: [
      {
        id: "producer-run",
        role: "producer",
        sessionId: "agent:main:subagent:producer",
        startedAt: 2_000,
        finishedAt: 5_000,
      },
      {
        id: "auditor-run",
        role: "auditor",
        sessionId: "agent:main:subagent:auditor",
        startedAt: 5_001,
        finishedAt: 9_000,
      },
    ],
    llmRequests: [
      {
        id: "parent-call",
        role: "parent",
        sessionId: sessions.parent,
        turnSeq: 1,
        step: 0,
        usage: { totalTokens: 100 },
      },
      {
        id: "producer-call",
        role: "producer",
        sessionId: sessions.producer,
        turnSeq: 1,
        step: 0,
        usage: { totalTokens: 200 },
      },
      {
        id: "auditor-call",
        role: "auditor",
        sessionId: sessions.auditor,
        turnSeq: 1,
        step: 0,
        usage: { totalTokens: 75 },
      },
    ],
  });

  assert.equal(result.turns.producerRunCount, 1);
  assert.equal(result.turns.auditorRunCount, 1);
  assert.equal(result.phase1GatePassed, true);
});
