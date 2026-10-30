import { createFinnyPlanPreflight, type FinanceService } from "./finance.ts";
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
    async preflightPlan(input) {
      return createFinnyPlanPreflight(input);
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
