import type { ActorAssertion } from "../types.ts";
import type {
  FinnyApprovalBridge,
  FinnyApprovalOutcome,
  FinnyPendingApproval,
  FinnySlackDecision,
} from "../slack/finny-approvals.ts";

export const FINNY_PLAN_APPROVAL_REASON = "Finny Governance Plan Approval";
export const FINNY_CLARIFICATION_REASON = "Finny Governance Clarification";

export interface FinnyPlanApprovalProjection {
  requestId: string;
  command: string;
  reason: typeof FINNY_PLAN_APPROVAL_REASON;
  summary?: string;
  summaryDetail: string;
  approvalKey: string;
  grantModes: { session: false; always: false };
}

export type FinnyWebApprovalResolution =
  | { kind: "plan"; outcome: Exclude<FinnyApprovalOutcome, { kind: "gone" }> }
  | {
      kind: "clarification";
      outcome: Extract<FinnyApprovalOutcome, { kind: "result" }>;
      reply: string;
      next?: FinnyPlanApprovalProjection;
    };

function requestIdFromApprovalKey(approvalKey: string | undefined, prefix: string): string {
  if (!approvalKey?.startsWith(prefix)) throw new Error("Finny approval binding is unavailable");
  const requestId = approvalKey.slice(prefix.length);
  if (!requestId) throw new Error("Finny approval binding is unavailable");
  return requestId;
}

export function finnyPlanApprovalProjection(
  pending: Extract<FinnyPendingApproval, { kind: "plan" }>,
): FinnyPlanApprovalProjection {
  const approvalKey = `finny-plan:${pending.requestId}`;
  return {
    requestId: pending.requestId,
    command: pending.card.title,
    reason: FINNY_PLAN_APPROVAL_REASON,
    ...(pending.card.summary ? { summary: pending.card.summary } : {}),
    summaryDetail: JSON.stringify({ plan: pending.card }),
    approvalKey,
    grantModes: { session: false, always: false },
  };
}

export async function decideFinnyWebApproval(input: {
  bridge: FinnyApprovalBridge;
  reason: string | undefined;
  approvalKey: string | undefined;
  approved: boolean;
  optionId?: string;
  actor: ActorAssertion;
  surface?: string;
}): Promise<FinnyWebApprovalResolution | null> {
  const clarification = input.reason === FINNY_CLARIFICATION_REASON;
  const plan = input.reason === FINNY_PLAN_APPROVAL_REASON;
  if (!clarification && !plan) return null;
  const requestId = requestIdFromApprovalKey(
    input.approvalKey,
    clarification ? "finny-clarification:" : "finny-plan:",
  );
  let decision: FinnySlackDecision;
  if (clarification) {
    if (input.approved && !input.optionId) throw new Error("Finny clarification option is required");
    decision = input.approved
      ? { kind: "clarification", action: "select", optionId: input.optionId! }
      : { kind: "clarification", action: "other" };
  } else {
    decision = { kind: "plan", action: input.approved ? "approve" : "reject" };
  }
  const outcome = await input.bridge.decide({
    requestId,
    decision,
    actor: input.actor,
    surface: input.surface,
  });
  if (outcome.kind === "gone") throw new Error("Finny approval request is unavailable");
  if (!clarification) return { kind: "plan", outcome };
  if (outcome.kind !== "result") throw new Error("Finny clarification returned an invalid outcome");
  return {
    kind: "clarification",
    outcome,
    reply: outcome.card.summary,
    ...(outcome.next ? { next: finnyPlanApprovalProjection(outcome.next) } : {}),
  };
}
