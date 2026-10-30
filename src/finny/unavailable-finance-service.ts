import { finnyApprovalPolicyDigest, type FinanceService } from "./finance.ts";
import { digestFinnyEvidence } from "./golden-loop.ts";

const blocked = (capability: string): never => {
  throw new Error(`blocked_external: no reviewed ${capability} adapter is registered`);
};

export function createUnavailableFinanceService(): FinanceService {
  return {
    async clarify(input, context) {
      return {
        clarification: "The host recorded the requested finance scope; no source data has been fetched.",
        evidenceDigest: digestFinnyEvidence(
          JSON.stringify({ runId: context.runId, actorId: context.actorId, request: input.request }),
        ),
      };
    },
    async preflightPlan(input, context) {
      const approvalPolicyDigest = finnyApprovalPolicyDigest(input.plan);
      const evidence = JSON.stringify({
        runId: context.runId,
        actorId: context.actorId,
        request: input.request,
        clarificationDigest: input.clarificationDigest,
        plan: input.plan,
        approvalPolicyDigest,
        access: "read-only",
      });
      return {
        planSummary: "Reviewed operation plan; an approved native source adapter is required for external execution.",
        preflightDigest: digestFinnyEvidence(`operation-plan-preflight:${evidence}`),
        approvalRequired: input.plan.approvalPolicy.mode !== "none",
        approvalPolicyDigest,
      };
    },
    async executeOperation() {
      return blocked("operation execution");
    },
    async sourcePlan() {
      return blocked("operation plan source");
    },
    async recoverSource() {
      return blocked("operation plan source recovery");
    },
    async artifact() {
      return blocked("finance artifact");
    },
    async verify() {
      return blocked("independent finance verifier");
    },
  };
}
