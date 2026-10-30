import type { FinnyDigest } from "./golden-loop.ts";
import type { ScopeId } from "../types.ts";
import type { FinnyVerificationPolicy } from "./accounting-validator.ts";

export const FINANCE_RESOURCE_NAME = "finance" as const;

export interface FinanceExecutionContext {
  runId: string;
  actorId: string;
  scopeId: ScopeId;
  credentialHandles: readonly string[];
  requestText?: string;
  verificationPolicy?: FinnyVerificationPolicy;
  approvedQueryDigest?: FinnyDigest;
}

export interface FinanceActionInputMap {
  clarify: {
    request: string;
  };
  preflight: {
    request: string;
    clarificationDigest: FinnyDigest;
    query: string;
  };
  plan: {
    planDigest: FinnyDigest;
  };
  source: {
    planDigest: FinnyDigest;
    query?: string;
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
  preflight: {
    planSummary: string;
    preflightDigest: FinnyDigest;
    planDigest: FinnyDigest;
    queryDigest?: FinnyDigest;
    verificationPolicyDigest?: FinnyDigest;
    approvalRequired?: boolean;
    approvalPolicyDigest?: FinnyDigest;
    verificationPolicy?: FinnyVerificationPolicy;
  };
  plan: {
    decision: "approved" | "exempt" | "rejected";
    approvalDigest?: FinnyDigest;
    approvalPolicyDigest?: FinnyDigest;
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
  preflight(
    input: FinanceActionInputMap["preflight"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["preflight"]>;
  plan(input: FinanceActionInputMap["plan"], context: FinanceExecutionContext): Promise<FinanceActionOutputMap["plan"]>;
  source(
    input: FinanceActionInputMap["source"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["source"]>;
  artifact(
    input: FinanceActionInputMap["artifact"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["artifact"]>;
  verify(
    input: FinanceActionInputMap["verify"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["verify"]>;
  recoverSource?(
    input: Pick<FinanceActionInputMap["artifact"], "sourceDigest">,
    context: FinanceExecutionContext,
  ): Promise<Pick<FinanceActionOutputMap["source"], "records">>;
}
