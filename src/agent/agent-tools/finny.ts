import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  type FinnyAuditJudgmentAnswer,
  type FinnyMaterialClarification,
  type FinnySopVersion,
} from "../../finny/types.ts";
import { FINNY_SOP_SCHEMA, FINNY_SOP_VALUES_SCHEMA } from "../../finny/sop-schema.ts";
import { FINNY_CERTIFIED_SUMMARY_SCHEMA, type FinnyCertifiedResult } from "../../finny/certified-result.ts";
import { text, type ToolKit } from "./kit.ts";

export interface FinnyToolService {
  readonly role?: "parent" | "producer" | "auditor";
  createPlan(
    sop: FinnySopVersion,
    values: Record<string, string | boolean>,
    materialClarification?: FinnyMaterialClarification,
  ): Promise<FinnyPlanCreation>;
  amendPlan(
    jobId: string,
    sop: FinnySopVersion,
    values: Record<string, string | boolean>,
    materialClarification?: FinnyMaterialClarification,
    operationId?: string,
  ): Promise<FinnyPlanCreation>;
  status(jobId: string): Promise<string>;
  artifactReady(input: {
    artifactDigest: string;
    provisionalRevision: string;
    idempotencyKey: string;
  }): Promise<string>;
  completeJudgment(input: { idempotencyKey: string; judgmentAnswers: FinnyAuditJudgmentAnswer[] }): Promise<string>;
  finalize(input: { jobId: string; summary: FinnyCertifiedResult["summary"]; idempotencyKey: string }): Promise<string>;
}

export interface FinnyPlanCreation {
  message: string;
  jobId: string;
  requestId?: string;
  awaiting: "approval" | "clarification" | "none";
}

const string = () => Type.String({ minLength: 1 });
const clarificationOption = Type.Object(
  { id: string(), label: string(), description: Type.Optional(string()) },
  { additionalProperties: false },
);
const materialClarification = Type.Object(
  {
    question: string(),
    options: Type.Array(clarificationOption, { minItems: 2, maxItems: 5 }),
    recommendedOptionId: string(),
  },
  { additionalProperties: false },
);

const sop = FINNY_SOP_SCHEMA;
const values = FINNY_SOP_VALUES_SCHEMA;
const certifiedSummary = FINNY_CERTIFIED_SUMMARY_SCHEMA;
const evidenceRefs = Type.Array(string());
const judgmentAnswers = Type.Array(
  Type.Object(
    {
      controlId: string(),
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("block")]),
      evidenceRefs,
      rationale: string(),
    },
    { additionalProperties: false },
  ),
);

export function finnyTools(kit: ToolKit) {
  const { ref, opts, recordCall, recordResult, resourceTool, blockOnApproval } = kit;
  const role = ref.current?.finny?.role ?? "parent";
  const authoring = role === "parent";
  const producing = role === "producer";
  const auditing = role === "auditor";
  const run = async (
    callId: string,
    action: string,
    summary: Record<string, unknown>,
    invoke: () => Promise<string>,
  ) => {
    await recordCall(callId, { tool: "finny", action, ...summary });
    const result = await invoke();
    return recordResult(callId, { tool: "finny", action, ...summary }, text(result), false, undefined, true);
  };
  const createPlan = defineTool({
    name: "finny_create_plan",
    label: "Create Finny plan",
    description: "Create a plan from presentation content. Core supplies its identity, policy, origin, and approval.",
    parameters: Type.Object(
      { sop, values, materialClarification: Type.Optional(materialClarification) },
      { additionalProperties: false },
    ),
    execute: async (callId, params) => {
      await recordCall(callId, { tool: "finny", action: "create_plan", title: params.sop.title });
      const result = await ref.current!.finny!.createPlan(params.sop, params.values, params.materialClarification);
      if (opts?.surfaceName === "web") {
        const clarification = result.awaiting === "clarification" ? params.materialClarification : undefined;
        if (result.awaiting === "clarification" && !clarification)
          throw new Error("Finny clarification response is missing its question");
        const recommended = clarification?.options.find((option) => option.id === clarification.recommendedOptionId);
        const detail = JSON.stringify({
          sop: params.sop,
          values: params.values,
          ...(clarification ? { materialClarification: clarification } : {}),
        });
        return blockOnApproval(
          callId,
          {
            name: "NeedsApproval",
            message: result.message,
            command: clarification?.question ?? params.sop.title,
            approvalReason: clarification ? "Finny Governance Clarification" : "Finny Governance Plan Approval",
            approvalKey: `${clarification ? "finny-clarification" : "finny-plan"}:${result.requestId}`,
            kind: "approval",
            grantModes: { session: false, always: false },
            summaryDetail: detail,
            summary: recommended ? `Recommended: ${recommended.label}` : params.sop.intent.description,
          },
          recommended ? `Recommended: ${recommended.label}` : params.sop.intent.description,
          { tool: "finny", action: "create_plan", title: params.sop.title },
        );
      }
      return recordResult(
        callId,
        { tool: "finny", action: "create_plan", title: params.sop.title },
        text(result.message),
        false,
        undefined,
        true,
      );
    },
  });
  const amendPlan = defineTool({
    name: "finny_amend_plan",
    label: "Amend Finny plan",
    description:
      "Amend an in-flight Finny plan. Material execution changes require human approval; non-material value changes retain the existing approval.",
    parameters: Type.Object(
      { jobId: string(), sop, values, materialClarification: Type.Optional(materialClarification) },
      { additionalProperties: false },
    ),
    execute: async (callId, params) => {
      await recordCall(callId, {
        tool: "finny",
        action: "amend_plan",
        jobId: params.jobId,
        title: params.sop.title,
      });
      const result = await ref.current!.finny!.amendPlan(
        params.jobId,
        params.sop,
        params.values,
        params.materialClarification,
        callId,
      );
      if (opts?.surfaceName === "web" && result.awaiting !== "none")
        return blockOnApproval(
          callId,
          {
            name: "NeedsApproval",
            message: result.message,
            command: params.sop.title,
            approvalReason: "Finny Governance Plan Approval",
            approvalKey: `finny-plan:${result.requestId!}`,
            kind: "approval",
            grantModes: { session: false, always: false },
            summaryDetail: JSON.stringify({ sop: params.sop, values: params.values }),
            summary: params.sop.intent.description,
          },
          params.sop.intent.description,
          { tool: "finny", action: "amend_plan", jobId: params.jobId, title: params.sop.title },
        );
      return recordResult(
        callId,
        { tool: "finny", action: "amend_plan", jobId: params.jobId, title: params.sop.title },
        text(result.message),
        false,
        undefined,
        true,
      );
    },
  });
  const status = defineTool({
    name: "finny_status",
    label: "Finny status",
    description: "Read the current authoritative state of a Finny job.",
    parameters: Type.Object({ jobId: string() }, { additionalProperties: false }),
    execute: (callId, params) =>
      run(callId, "status", { jobId: params.jobId }, () => ref.current!.finny!.status(params.jobId)),
  });
  const artifactReady = defineTool({
    name: "finny_artifact_ready",
    label: "Finny artifact ready",
    description:
      "Bind the actual workbook already published to durable Files. artifactDigest is the Files sha256 and provisionalRevision is the Files record ID returned by the completed upload; neither value is an SOP revision, local path, or locally invented identifier.",
    parameters: Type.Object(
      { artifactDigest: string(), provisionalRevision: string(), idempotencyKey: string() },
      { additionalProperties: false },
    ),
    execute: (callId, params) =>
      run(callId, "artifact_ready", { artifactDigest: params.artifactDigest }, () =>
        ref.current!.finny!.artifactReady({
          artifactDigest: params.artifactDigest,
          provisionalRevision: params.provisionalRevision,
          idempotencyKey: params.idempotencyKey,
        }),
      ),
  });
  const completeJudgment = defineTool({
    name: "finny_judgment",
    label: "Complete Finny judgment",
    description: "Answer every pending judgment question for the current Core-owned audit attempt.",
    parameters: Type.Object(
      {
        idempotencyKey: string(),
        judgmentAnswers,
      },
      { additionalProperties: false },
    ),
    execute: (callId, params) => run(callId, "judgment", {}, () => ref.current!.finny!.completeJudgment(params)),
  });
  const finalize = defineTool({
    name: "finny_finalize",
    label: "Finalize Finny job",
    description: "Ask Core to certify the current audited workbook with its typed business summary.",
    parameters: Type.Object(
      { jobId: string(), summary: certifiedSummary, idempotencyKey: string() },
      { additionalProperties: false },
    ),
    execute: (callId, params) =>
      run(callId, "finalize", { jobId: params.jobId }, () =>
        ref.current!.finny!.finalize({
          jobId: params.jobId,
          summary: params.summary,
          idempotencyKey: params.idempotencyKey,
        }),
      ),
  });
  const tool = resourceTool("finny", {
    ...(authoring ? { create_plan: createPlan, amend_plan: amendPlan } : {}),
    status,
    ...(producing ? { artifact_ready: artifactReady } : {}),
    ...(auditing ? { judgment: completeJudgment } : {}),
    ...(authoring ? { finalize } : {}),
  });
  const properties = Object.fromEntries(
    Object.entries({
      ...(authoring ? { sop, values, materialClarification } : {}),
      jobId: string(),
      idempotencyKey: string(),
      ...(producing ? { artifactDigest: string(), provisionalRevision: string() } : {}),
      ...(auditing ? { judgmentAnswers } : {}),
      ...(authoring ? { summary: certifiedSummary } : {}),
    }).map(([key, schema]) => [key, Type.Optional(schema as TSchema)]),
  );
  const actionFields: Record<string, readonly string[]> = {
    ...(authoring ? { create_plan: ["sop", "values"], amend_plan: ["jobId", "sop", "values"] } : {}),
    status: ["jobId"],
    ...(producing ? { artifact_ready: ["artifactDigest", "provisionalRevision", "idempotencyKey"] } : {}),
    ...(auditing ? { judgment: ["idempotencyKey", "judgmentAnswers"] } : {}),
    ...(authoring ? { finalize: ["jobId", "summary", "idempotencyKey"] } : {}),
  } as const;
  const contentFields = Object.keys(properties);
  const parameters = Type.Object(
    {
      action: Type.Union(Object.keys(actionFields).map((action) => Type.Literal(action))),
      ...properties,
    },
    { additionalProperties: false },
  );
  Object.assign(parameters, {
    anyOf: Object.entries(actionFields).map(([action, required]) => ({
      properties: {
        action: { const: action },
        ...(action === "create_plan" ? { retrySafe: { const: false } } : {}),
      },
      required: ["action", ...required],
      not: {
        anyOf: contentFields
          .filter(
            (field) =>
              !required.includes(field) &&
              !((action === "create_plan" || action === "amend_plan") && field === "materialClarification"),
          )
          .map((field) => ({ required: [field] })),
      },
    })),
  });
  return { ...tool, parameters };
}
