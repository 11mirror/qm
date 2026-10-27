import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeApprovalDecision, loadApprovalLedger } from "../src/core/orchestrator/approvals.ts";
import type { PendingApprovalRecord } from "../src/types.ts";

function harness(records: Array<[string, PendingApprovalRecord]>, history: Array<Record<string, unknown>> = []) {
  const pending = new Map(records);
  const grants = new Map<string, unknown>();
  const appended: Array<Record<string, unknown>> = [];
  const deps = {
    approvals: {
      get: async (id: string) => pending.get(id) ?? null,
      delete: async (id: string) => void pending.delete(id),
      take: async (id: string) => {
        const value = pending.get(id) ?? null;
        pending.delete(id);
        return value;
      },
    },
    approvalGrants: { put: async (id: string, grant: unknown) => void grants.set(id, grant) },
    auditLog: { record: () => {} },
    sessions: {
      getItems: async (_sessionId: string, opts: { turnId?: string }) =>
        history.filter((item) => item.turnId === opts.turnId),
      appendMany: async (_lease: unknown, items: Array<Record<string, unknown>>) => {
        appended.push(...items);
        return items;
      },
    },
  };
  const ledger = loadApprovalLedger([], "S1", { session: true, always: true });
  const decide = (
    decision: { requestId: string; approved: boolean; scope?: "once" | "session" | "always" },
    runId?: string,
  ) =>
    consumeApprovalDecision({
      deps: deps as never,
      decision,
      sessionId: "S1",
      ...(runId ? { runId } : {}),
      lease: {} as never,
      actorId: "U1",
      scopeId: "org" as never,
      resolution: { approvalGrantModes: { session: true, always: true } },
      ledger,
      withRosterVersion: (fn) => fn(),
      mirror: async () => {},
    });
  return { pending, grants, appended, ledger, decide };
}

const request = { sessionId: "S1", command: "git push --force", request: { actor: { externalId: "U1" } } as never };

test("two simultaneous approvals of one request credit the command once", async () => {
  const h = harness([["R1", request]]);
  const outcomes = await Promise.all([
    h.decide({ requestId: "R1", approved: true }),
    h.decide({ requestId: "R1", approved: true }),
  ]);
  assert.deepEqual(outcomes.map((o) => o.kind).sort(), ["approved", "settled"]);
  assert.equal(h.ledger.consume("git push --force"), true);
  assert.equal(h.ledger.consume("git push --force"), false);
});

test("a retried run recovers an approval its first attempt recorded before crashing", async () => {
  const h = harness(
    [],
    [
      {
        kind: "ElicitationResponse",
        turnId: "run-1",
        elicitId: "R1",
        approved: true,
        body: { command: "git push --force", scope: "session" },
      },
    ],
  );
  const outcome = await h.decide({ requestId: "R1", approved: true, scope: "session" }, "run-1");
  assert.equal(outcome.kind, "approved");
  assert.equal(h.appended.length, 0);
  assert.equal(h.ledger.consume("git push --force"), true);
  assert.equal(h.grants.size, 1);
});

test("a recorded denial stays a denial on retry", async () => {
  const h = harness(
    [["R1", request]],
    [
      {
        kind: "ElicitationResponse",
        turnId: "run-1",
        elicitId: "R1",
        approved: false,
        body: { command: "git push --force" },
      },
    ],
  );
  const outcome = await h.decide({ requestId: "R1", approved: false }, "run-1");
  assert.equal(outcome.kind, "settled");
  assert.equal(h.pending.size, 0);
  assert.equal(h.ledger.consume("git push --force"), false);
});
