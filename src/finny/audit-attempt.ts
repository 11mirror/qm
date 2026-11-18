import { Type } from "typebox";
import { Errors } from "typebox/value";
import type { RecordFinnyAuditAttemptInput } from "./store.ts";
import type { SpreadsheetWorkerResult } from "./deterministic-spreadsheet-worker.ts";
import type { FinnyAuditControlResult, FinnyEvaluatorRef } from "./types.ts";

const nonempty = () => Type.String({ minLength: 1, pattern: "\\S" });
const evaluator = Type.Object(
  {
    id: nonempty(),
    revision: nonempty(),
    buildDigest: nonempty(),
    contractVersion: nonempty(),
    configurationDigest: nonempty(),
  },
  { additionalProperties: false },
);
const evidenceRefs = Type.Array(nonempty());
const deterministicAuthority = Type.Object(
  {
    evaluator,
    reasonSchemaVersion: Type.Literal("finny.spreadsheet-worker.v2"),
    reasonCode: nonempty(),
  },
  { additionalProperties: false },
);

export const FINNY_AUDIT_ATTEMPT_INPUT_SCHEMA = Type.Object(
  {
    id: nonempty(),
    scopeId: nonempty(),
    jobId: nonempty(),
    sopVersionId: nonempty(),
    executionDigest: nonempty(),
    artifactFileId: nonempty(),
    artifactSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    artifactMime: Type.Literal("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    artifactSizeBytes: Type.Integer({ minimum: 1 }),
    evaluator,
    controls: Type.Array(
      Type.Object(
        {
          id: nonempty(),
          verdict: Type.Union([Type.Literal("pass"), Type.Literal("block")]),
          evidenceRefs,
          repairActions: Type.Array(
            Type.Object({ message: nonempty(), workbookRefs: evidenceRefs }, { additionalProperties: false }),
          ),
          deterministicAuthority: Type.Optional(deterministicAuthority),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    judgmentQuestions: Type.Array(Type.Unknown()),
    judgmentAddendum: Type.Optional(
      Type.Object(
        {
          issuerPrincipalId: nonempty(),
          issuerRunId: nonempty(),
          answers: Type.Array(
            Type.Object(
              {
                controlId: nonempty(),
                verdict: Type.Union([Type.Literal("pass"), Type.Literal("block")]),
                evidenceRefs,
                rationale: nonempty(),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("block"), Type.Literal("pending_judgment")]),
    issuerPrincipalId: nonempty(),
    issuerRunId: nonempty(),
    idempotencyKey: nonempty(),
    requestDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    completedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export function validateFinnyAuditAttemptInput(value: unknown): RecordFinnyAuditAttemptInput {
  const [error] = Errors(FINNY_AUDIT_ATTEMPT_INPUT_SCHEMA, value);
  if (error) {
    throw new Error(`Finny audit attempt is invalid at ${error.instancePath || "/"}: ${error.message}`);
  }
  const input = value as RecordFinnyAuditAttemptInput;
  const controlIds = new Set<string>();
  for (const control of input.controls) {
    if (controlIds.has(control.id)) throw new Error("Finny audit control ID is duplicated");
    controlIds.add(control.id);
  }
  if (input.verdict === "pending_judgment") {
    if (input.judgmentQuestions.length === 0 || input.judgmentAddendum || input.completedAt !== undefined) {
      throw new Error("Finny pending audit judgment state is invalid");
    }
  }
  return input;
}

export function finnyAuditAttemptFromSpreadsheetResults(
  results: readonly SpreadsheetWorkerResult[],
  evidenceFileId: string,
  evaluator: FinnyEvaluatorRef,
): { controls: FinnyAuditControlResult[]; verdict: "pass" | "block"; blockedControlId?: string } {
  const evaluatorError = results.find((check) => check.verdict === "error");
  if (evaluatorError?.verdict === "error") {
    throw new Error(
      `Deterministic spreadsheet evaluator error for ${evaluatorError.checkId}: ${evaluatorError.reason.code}; evidence ${evidenceFileId}`,
    );
  }
  const controls = results.map((check): FinnyAuditControlResult => {
    if (check.verdict === "error") throw new Error("Deterministic spreadsheet evaluator returned an error");
    return {
      id: check.checkId,
      verdict: check.verdict,
      evidenceRefs: check.verdict === "pass" ? [evidenceFileId] : [evidenceFileId, ...check.reason.references],
      repairActions:
        check.verdict === "block"
          ? [
              {
                message: `${check.checkId} blocked by deterministic evaluator: ${check.reason.code}`,
                workbookRefs: [...check.reason.references],
              },
            ]
          : [],
      deterministicAuthority: {
        evaluator,
        reasonSchemaVersion: "finny.spreadsheet-worker.v2",
        reasonCode: check.verdict === "pass" ? "PASS" : check.reason.code,
      },
    };
  });
  const blockedControlId = controls.find((control) => control.verdict === "block")?.id;
  return {
    controls,
    verdict: blockedControlId ? "block" : "pass",
    ...(blockedControlId ? { blockedControlId } : {}),
  };
}
