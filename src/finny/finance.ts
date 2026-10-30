import { createHash } from "node:crypto";

import type { FinnyDigest } from "./golden-loop.ts";
import type { ScopeId } from "../types.ts";
import type { FinnyOperationPlan } from "./operation-compiler.ts";
import type { FinnyOperationRow } from "./operation-executor.ts";
import type { FinnyOperationRunnerContext } from "./operation-runner.ts";
import { canonicalFinnyJson } from "./canonical-json.ts";

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

const FINNY_APPROVAL_SUMMARY_MAX_BYTES = 3_000;

export function createFinnyPlanPreflight(input: FinancePlanPreflightInput): FinancePlanPreflightOutput {
  const operations = new Map(input.plan.operations.map((operation) => [operation.id, operation]));
  const providerScope = input.plan.operations.flatMap((operation) => {
    if (operation.primitive === "suiteql_select")
      return [`- ${operation.id}: NetSuite SuiteQL ${JSON.stringify(operation.sql)}`];
    if (operation.primitive !== "repeat_pull") return [];
    const source = operations.get(operation.operationId);
    if (!source || source.primitive !== "suiteql_select")
      throw new Error(`Finny repeat operation ${operation.id} has no reviewed provider source`);
    return [`- ${operation.id}: NetSuite repeat of ${source.id} ${JSON.stringify(source.sql)}`];
  });
  const summary = [
    `Capability: ${input.plan.capabilityId} @ ${input.plan.revisionId}`,
    `Dimensions: ${canonicalFinnyJson(input.plan.dimensions)}`,
    "Provider data scope:",
    ...providerScope,
    `Result operation: ${input.plan.resultOperationId}`,
    `Artifact: format ${input.plan.artifactPolicy.defaultFormat}; allowed ${input.plan.artifactPolicy.allowedFormats.join(", ")}; attachment ${input.plan.artifactPolicy.attachment}`,
    `Verification: required operations ${input.plan.verificationPolicy.requiredOperationIds.join(", ") || "none"}; release gate ${input.plan.verificationPolicy.releaseGate}`,
  ].join("\n");
  if (Buffer.byteLength(summary, "utf8") > FINNY_APPROVAL_SUMMARY_MAX_BYTES)
    throw new Error("Finny approval summary exceeds the host display limit");
  const preflightDigest = `sha256:${createHash("sha256")
    .update(
      canonicalFinnyJson({
        request: input.request,
        clarificationDigest: input.clarificationDigest,
        planDigest: input.plan.planDigest,
        summary,
      }),
    )
    .digest("hex")}` as FinnyDigest;
  return {
    planSummary: summary,
    preflightDigest,
    approvalRequired: input.plan.approvalPolicy.mode !== "none",
    approvalPolicyDigest: input.plan.approvalPolicyDigest,
  };
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
