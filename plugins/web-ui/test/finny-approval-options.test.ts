import test from "node:test";
import assert from "node:assert/strict";
import { finnyClarificationChoices, type PendingApproval } from "../src/core-bridge.ts";

test("Finny clarification choices expose every persisted option plus Other", () => {
  const approval = {
    requestId: "approval-1",
    command: "Which cutoff?",
    reason: "Finny Governance Clarification",
    summaryDetail: JSON.stringify({
      plan: { title: "AP aging", phases: [] },
      materialClarification: {
        question: "Which cutoff?",
        options: [
          { id: "today", label: "Today" },
          { id: "month-end", label: "Month end" },
        ],
        recommendedOptionId: "today",
      },
    }),
  } satisfies PendingApproval;

  assert.deepEqual(finnyClarificationChoices(approval), [
    { label: "Today", recommended: true, decision: { requestId: "approval-1", approved: true, optionId: "today" } },
    {
      label: "Month end",
      recommended: false,
      decision: { requestId: "approval-1", approved: true, optionId: "month-end" },
    },
    { label: "Other", recommended: false, decision: { requestId: "approval-1", approved: false } },
  ]);
});
