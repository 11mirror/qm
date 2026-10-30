import type { FinnyDigest } from "./golden-loop.ts";
import type { ScopeId } from "../types.ts";
import type { FinnyOperationPlan } from "./operation-compiler.ts";
import type { FinnyOperationRow } from "./operation-executor.ts";
import type { FinnyOperationRunnerContext } from "./operation-runner.ts";

export const FINANCE_RESOURCE_NAME = "finance" as const;

export function finnyApprovalPolicyDigest(plan: Pick<FinnyOperationPlan, "approvalPolicyDigest">): FinnyDigest {
  return plan.approvalPolicyDigest;
}

export interface FinanceExecutionContext {
  runId: string;
  actorId: string;
  scopeId: ScopeId;
  credentialHandles: readonly string[];
  requestText?: string;
}

export interface FinanceActionInputMap {
  clarify: {
    request: string;
  };
  artifact: {
    sourceDigest: FinnyDigest;
    requirement?: "required" | "optional";
  };
  verify: {
    sourceDigest: FinnyDigest;
    artifactDigest?: FinnyDigest;
    requirement: "required" | "optional";
  };
}

export interface FinanceActionOutputMap {
  clarify: {
    clarification: string;
    evidenceDigest: FinnyDigest;
  };
  source: {
    records: readonly unknown[];
    sourceDigest: FinnyDigest;
  };
  artifact: {
    requirement: "required" | "optional";
    reference?: string;
    policyDigest: FinnyDigest;
    artifactDigest?: FinnyDigest;
  };
  verify: {
    passed: boolean;
    verificationDigest: FinnyDigest;
  };
}

export interface FinancePlanPreflightInput {
  request: string;
  clarificationDigest: FinnyDigest;
  plan: FinnyOperationPlan;
}

export interface FinancePlanPreflightOutput {
  planSummary: string;
  preflightDigest: FinnyDigest;
  approvalRequired: boolean;
  approvalPolicyDigest: FinnyDigest;
}

export interface FinanceOperationInput {
  plan: FinnyOperationPlan;
  execution: FinnyOperationRunnerContext;
}

export interface FinanceOperationOutput {
  rows: readonly FinnyOperationRow[];
}

export interface FinancePlanSourceInput {
  plan: FinnyOperationPlan;
}

export const FINANCE_ACTIONS = ["clarify", "preflight", "plan", "source", "artifact", "verify"] as const;

export type FinanceAction = (typeof FINANCE_ACTIONS)[number];

export function isFinanceAction(value: string): value is FinanceAction {
  return FINANCE_ACTIONS.some((action) => action === value);
}

export interface FinanceService {
  clarify(
    input: FinanceActionInputMap["clarify"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["clarify"]>;
  artifact(
    input: FinanceActionInputMap["artifact"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["artifact"]>;
  verify(
    input: FinanceActionInputMap["verify"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["verify"]>;
  recoverSource(
    input: Pick<FinanceActionInputMap["artifact"], "sourceDigest">,
    context: FinanceExecutionContext,
  ): Promise<Pick<FinanceActionOutputMap["source"], "records">>;
  preflightPlan(
    input: FinancePlanPreflightInput,
    context: FinanceExecutionContext,
  ): Promise<FinancePlanPreflightOutput>;
  executeOperation(input: FinanceOperationInput, context: FinanceExecutionContext): Promise<FinanceOperationOutput>;
  sourcePlan(
    input: FinancePlanSourceInput,
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["source"]>;
}
