import assert from "node:assert/strict";
import { test } from "node:test";
import { decideFinnyWebApproval, FINNY_PLAN_APPROVAL_REASON } from "../src/finny/web-approval.ts";
import type { FinnyApprovalBridge } from "../src/slack/finny-approvals.ts";

test("Finny web decisions require their typed durable approval binding", async () => {
  let decisions = 0;
  const bridge: FinnyApprovalBridge = {
    async pending() {
      return null;
    },
    async decide() {
      decisions++;
      return { kind: "gone" };
    },
  };

  await assert.rejects(
    decideFinnyWebApproval({
      bridge,
      reason: FINNY_PLAN_APPROVAL_REASON,
      approvalKey: undefined,
      approved: true,
      actor: { externalId: "U1" },
      surface: "web",
    }),
    /binding is unavailable/,
  );
  assert.equal(decisions, 0);
});
