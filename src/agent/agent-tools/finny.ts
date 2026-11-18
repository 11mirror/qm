import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  FINNY_CHECK_IDS,
  type FinnyAuditFinding,
  type FinnyCheckId,
  type FinnyMaterialClarification,
  type FinnySopVersion,
} from "../../finny/types.ts";
import { text, type ToolKit } from "./kit.ts";

export interface FinnyToolService {
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
  ): Promise<FinnyPlanCreation>;
  status(jobId: string): Promise<string>;
  artifactReady(input: {
    artifactDigest: string;
    provisionalRevision: string;
    idempotencyKey: string;
  }): Promise<string>;
  pass(input: {
    checkId: FinnyCheckId;
    generation: number;
    evidenceFileId: string;
    idempotencyKey: string;
  }): Promise<string>;
  deterministicAudit(input: { idempotencyKey: string }): Promise<string>;
  block(input: {
    checkId: FinnyCheckId;
    generation: number;
    evidenceFileId: string;
    findings: FinnyAuditFinding[];
    idempotencyKey: string;
  }): Promise<string>;
  finalize(input: { jobId: string; idempotencyKey: string }): Promise<string>;
}

export interface FinnyPlanCreation {
  message: string;
  jobId: string;
  requestId: string;
  awaiting: "approval" | "clarification";
}

const string = () => Type.String({ minLength: 1 });
const checkId = Type.Union(FINNY_CHECK_IDS.map((value) => Type.Literal(value)));
const finding = Type.Object({ code: string(), message: string() }, { additionalProperties: false });
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

const sopInput = Type.Object(
  {
    id: string(),
    label: string(),
    from: Type.Union([Type.Literal("human"), Type.Literal("system")]),
    type: Type.Union([
      Type.Literal("date"),
      Type.Literal("text"),
      Type.Literal("currency"),
      Type.Literal("entity"),
      Type.Literal("boolean"),
    ]),
    required: Type.Boolean(),
    material: Type.Boolean(),
  },
  { additionalProperties: false },
);
const sop = Type.Object(
  {
    schema: Type.Literal("finny.sop.v1"),
    id: string(),
    version: Type.Integer({ minimum: 1 }),
    scopeId: string(),
    title: string(),
    intent: Type.Object(
      {
        domain: Type.Union([Type.Literal("ap"), Type.Literal("ar"), Type.Literal("gl"), Type.Literal("close")]),
        description: string(),
        searchTerms: Type.Array(string()),
      },
      { additionalProperties: false },
    ),
    objective: string(),
    inputs: Type.Array(sopInput),
    sources: Type.Array(
      Type.Object(
        {
          id: string(),
          system: string(),
          object: string(),
          fields: Type.Array(string()),
          filter: string(),
          asOfInput: Type.Optional(string()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    steps: Type.Array(
      Type.Object(
        { id: string(), action: string(), reads: Type.Array(string()), writes: string() },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    controls: Type.Array(
      Type.Object(
        {
          id: string(),
          assertion: string(),
          tolerance: Type.Optional(string()),
          evidenceRefs: Type.Array(string()),
          judgment: Type.Optional(
            Type.Object({ question: string(), onlyWhen: string() }, { additionalProperties: false }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    outputs: Type.Array(
      Type.Object(
        {
          id: string(),
          kind: Type.Union([Type.Literal("xlsx"), Type.Literal("summary"), Type.Literal("app")]),
          contract: Type.Record(Type.String(), Type.Unknown()),
          rerun: Type.Optional(
            Type.Object({ inputIds: Type.Array(string()) }, { additionalProperties: false }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 2 },
    ),
    approval: Type.Object({ required: Type.Boolean(), destination: string() }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
const values = Type.Record(Type.String({ minLength: 1 }), Type.Union([string(), Type.Boolean()]));

export function finnyTools(kit: ToolKit) {
  const { ref, opts, recordCall, recordResult, resourceTool, blockOnApproval } = kit;
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
    description: "Amend an in-flight Finny plan when scope shifts. Requires human scope change approval.",
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
      );
      if (opts?.surfaceName === "web")
        return blockOnApproval(
          callId,
          {
            name: "NeedsApproval",
            message: result.message,
            command: params.sop.title,
            approvalReason: "Finny Governance Plan Approval",
            approvalKey: `finny-plan:${result.requestId}`,
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
    description: "Record the digest and provisional revision of the actual produced artifact.",
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
  const pass = defineTool({
    name: "finny_pass",
    label: "Finny audit pass",
    description: "Submit digest-bound PASS evidence for one current check generation.",
    parameters: Type.Object(
      { checkId, generation: Type.Integer({ minimum: 1 }), evidenceFileId: string(), idempotencyKey: string() },
      { additionalProperties: false },
    ),
    execute: (callId, params) =>
      run(callId, "pass", { checkId: params.checkId, generation: params.generation }, () =>
        ref.current!.finny!.pass({
          checkId: params.checkId,
          generation: params.generation,
          evidenceFileId: params.evidenceFileId,
          idempotencyKey: params.idempotencyKey,
        }),
      ),
  });
  const block = defineTool({
    name: "finny_block",
    label: "Finny audit block",
    description: "Submit bounded findings for one current check generation. Core selects rework or escalation.",
    parameters: Type.Object(
      {
        checkId,
        generation: Type.Integer({ minimum: 1 }),
        evidenceFileId: string(),
        findings: Type.Array(finding, { minItems: 1 }),
        idempotencyKey: string(),
      },
      { additionalProperties: false },
    ),
    execute: (callId, params) =>
      run(
        callId,
        "block",
        { checkId: params.checkId, generation: params.generation, findingCount: params.findings.length },
        () =>
          ref.current!.finny!.block({
            checkId: params.checkId,
            generation: params.generation,
            evidenceFileId: params.evidenceFileId,
            findings: params.findings,
            idempotencyKey: params.idempotencyKey,
          }),
      ),
  });
  const deterministicAudit = defineTool({
    name: "finny_deterministic_audit",
    label: "Finny deterministic audit",
    description: "Run Core-owned deterministic spreadsheet checks against the current bound artifact.",
    parameters: Type.Object({ idempotencyKey: string() }, { additionalProperties: false }),
    execute: (callId, params) =>
      run(callId, "deterministic_audit", {}, () =>
        ref.current!.finny!.deterministicAudit({ idempotencyKey: params.idempotencyKey }),
      ),
  });
  const finalize = defineTool({
    name: "finny_finalize",
    label: "Finalize Finny job",
    description: "Ask Core to finalize from authoritative job state using only the job and idempotency key.",
    parameters: Type.Object({ jobId: string(), idempotencyKey: string() }, { additionalProperties: false }),
    execute: (callId, params) =>
      run(callId, "finalize", { jobId: params.jobId }, () =>
        ref.current!.finny!.finalize({ jobId: params.jobId, idempotencyKey: params.idempotencyKey }),
      ),
  });
  const tool = resourceTool("finny", {
    create_plan: createPlan,
    amend_plan: amendPlan,
    status,
    artifact_ready: artifactReady,
    pass,
    block,
    deterministic_audit: deterministicAudit,
    finalize,
  });
  const properties = Object.fromEntries(
    Object.entries({
      sop,
      values,
      materialClarification,
      jobId: string(),
      artifactDigest: string(),
      provisionalRevision: string(),
      idempotencyKey: string(),
      checkId,
      generation: Type.Integer({ minimum: 1 }),
      evidenceFileId: string(),
      findings: Type.Array(finding, { minItems: 1 }),
    }).map(([key, schema]) => [key, Type.Optional(schema as TSchema)]),
  );
  const actionFields = {
    create_plan: ["sop", "values"],
    amend_plan: ["jobId", "sop", "values"],
    status: ["jobId"],
    artifact_ready: ["artifactDigest", "provisionalRevision", "idempotencyKey"],
    pass: ["checkId", "generation", "evidenceFileId", "idempotencyKey"],
    block: ["checkId", "generation", "evidenceFileId", "findings", "idempotencyKey"],
    deterministic_audit: ["idempotencyKey"],
    finalize: ["jobId", "idempotencyKey"],
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
              !required.includes(field as never) &&
              !((action === "create_plan" || action === "amend_plan") && field === "materialClarification"),
          )
          .map((field) => ({ required: [field] })),
      },
    })),
  });
  return { ...tool, parameters };
}
