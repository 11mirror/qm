import { Type } from "typebox";
import { Errors } from "typebox/value";
import type { FinnyAuditAttempt } from "./types.ts";

export const FINNY_CERTIFIED_RESULT_SCHEMA = "finny.result.v1" as const;
export const FINNY_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const nonempty = () => Type.String({ minLength: 1, pattern: "\\S" });
const detailRefs = Type.Array(Type.String({ pattern: "^(xlsx|evidence|app):\\S+$" }));

export const FINNY_CERTIFIED_SUMMARY_SCHEMA = Type.Object(
  {
    period: nonempty(),
    currency: nonempty(),
    metrics: Type.Array(
      Type.Object(
        { id: nonempty(), label: nonempty(), value: nonempty(), detailRefs },
        { additionalProperties: false },
      ),
    ),
    exceptions: Type.Array(
      Type.Object({ text: nonempty(), material: Type.Boolean(), detailRefs }, { additionalProperties: false }),
    ),
    caveats: Type.Array(Type.Object({ text: nonempty(), detailRefs }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

export const FINNY_CERTIFIED_RESULT_TYPEBOX = Type.Object(
  {
    schema: Type.Literal(FINNY_CERTIFIED_RESULT_SCHEMA),
    jobId: nonempty(),
    sopVersionId: nonempty(),
    executionDigest: nonempty(),
    artifact: Type.Object(
      {
        fileId: nonempty(),
        sha256: Type.String({ pattern: "^[A-Fa-f0-9]{64}$" }),
        mime: Type.Literal(FINNY_XLSX_MIME),
      },
      { additionalProperties: false },
    ),
    summary: FINNY_CERTIFIED_SUMMARY_SCHEMA,
    auditAttemptId: nonempty(),
  },
  { additionalProperties: false },
);

export interface FinnyCertifiedResultMetric {
  id: string;
  label: string;
  value: string;
  detailRefs: string[];
}

export interface FinnyCertifiedResultException {
  text: string;
  material: boolean;
  detailRefs: string[];
}

export interface FinnyCertifiedResultCaveat {
  text: string;
  detailRefs: string[];
}

export interface FinnyCertifiedResult {
  schema: typeof FINNY_CERTIFIED_RESULT_SCHEMA;
  jobId: string;
  sopVersionId: string;
  executionDigest: string;
  artifact: {
    fileId: string;
    sha256: string;
    mime: typeof FINNY_XLSX_MIME;
  };
  summary: {
    period: string;
    currency: string;
    metrics: FinnyCertifiedResultMetric[];
    exceptions: FinnyCertifiedResultException[];
    caveats: FinnyCertifiedResultCaveat[];
  };
  auditAttemptId: string;
}

export interface FinnyCertifiedResultReceiptPayload {
  aud: "finny.final.delivery";
  resultId: string;
  jobId: string;
  scopeId: string;
  sopVersionId: string;
  executionDigest: string;
  artifactFileId: string;
  artifactSha256: string;
  auditAttemptId: string;
  approvalRequestId: string;
  approvalActorId: string;
  originThreadRef: string;
  issuedAt: number;
}

export interface FinnyCertifiedResultReceipt {
  payload: FinnyCertifiedResultReceiptPayload;
  token: string;
}

export interface FinnyCertifiedResultRecord extends FinnyCertifiedResult {
  id: string;
  scopeId: string;
  receipt: FinnyCertifiedResultReceipt;
  destination: Record<string, unknown>;
  deliveryId?: string;
  idempotencyKey: string;
  createdAt: number;
}

export function validateFinnyCertifiedResult(value: unknown): FinnyCertifiedResult {
  const [error] = Errors(FINNY_CERTIFIED_RESULT_TYPEBOX, value);
  if (error) {
    const label = error.instancePath.includes("/detailRefs/") ? " detail reference" : " shape";
    throw new Error(`Finny certified result${label} is invalid at ${error.instancePath || "/"}: ${error.message}`);
  }
  const result = structuredClone(value) as FinnyCertifiedResult;
  const metrics = result.summary.metrics;
  const metricIds = new Set<string>();
  for (const entry of metrics) {
    if (metricIds.has(entry.id)) throw new Error(`Finny certified result has duplicate metric id ${entry.id}`);
    metricIds.add(entry.id);
  }
  return result;
}

export function validateFinnyCertifiedResultDestination(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error("Finny certified result destination must be a nonempty object");
  }
  return structuredClone(value) as Record<string, unknown>;
}

function evidenceAuthority(ref: string): string | undefined {
  const value = ref.startsWith("evidence:") ? ref.slice("evidence:".length) : ref;
  const authority = value.split(/[?#]/, 1)[0];
  return authority || undefined;
}

export function assertFinnyCertifiedResultReferences(
  result: FinnyCertifiedResult,
  attempt: Pick<FinnyAuditAttempt, "controls">,
): void {
  const evidence = new Set(
    attempt.controls
      .flatMap((control) => control.evidenceRefs)
      .map(evidenceAuthority)
      .filter((ref) => ref !== undefined),
  );
  const refs = [
    ...result.summary.metrics.flatMap((entry) => entry.detailRefs),
    ...result.summary.exceptions.flatMap((entry) => entry.detailRefs),
    ...result.summary.caveats.flatMap((entry) => entry.detailRefs),
  ];
  for (const ref of refs) {
    if (ref.startsWith("xlsx:")) {
      const [fileId] = ref.slice("xlsx:".length).split("#", 1);
      if (!ref.includes("#") || fileId === result.artifact.fileId) continue;
    }
    const authority = evidenceAuthority(ref);
    if (ref.startsWith("evidence:") && authority && evidence.has(authority)) continue;
    throw new Error(`Finny certified result detail reference is not bound to current result authority: ${ref}`);
  }
}

function searchLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function finnyCertifiedResultSearchText(value: unknown): string {
  const result = validateFinnyCertifiedResult(value);
  return [
    result.summary.period,
    result.summary.currency,
    ...result.summary.metrics.flatMap((entry) => [entry.id, entry.label, entry.value]),
    ...result.summary.exceptions.map((entry) => entry.text),
    ...result.summary.caveats.map((entry) => entry.text),
  ]
    .map(searchLine)
    .join("\n");
}
