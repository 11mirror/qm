import { createHash } from "node:crypto";

import type { DurableByteStore } from "../files/durable-byte-store.ts";
import { canonicalFinnyJson } from "./canonical-json.ts";
import { collectBytes } from "../util/bytes.ts";
import { decodeFinnyOperationPlan, encodeFinnyOperationPlan, type FinnyOperationPlan } from "./operation-compiler.ts";
import type { FinnyOperationRow } from "./operation-executor.ts";

export type FinnyCustodyDigest = `sha256:${string}`;

export interface FinnyOperationPlanReference {
  readonly blobKey: string;
  readonly planDigest: FinnyCustodyDigest;
}

export interface FinnyOperationDependencyResult {
  readonly operationId: string;
  readonly resultDigest: FinnyCustodyDigest;
}

export interface FinnyOperationResultInput {
  readonly runId: string;
  readonly planDigest: FinnyCustodyDigest;
  readonly operationId: string;
  readonly operationDigest: FinnyCustodyDigest;
  readonly dependencyResults: readonly FinnyOperationDependencyResult[];
  readonly output: readonly FinnyOperationRow[];
}

export interface FinnyOperationResultEnvelope extends FinnyOperationResultInput {
  readonly schema: "finny.operation_result.v1";
}

export interface EncodedFinnyOperationResult {
  readonly bytes: Buffer;
  readonly resultDigest: FinnyCustodyDigest;
}

export interface FinnyOperationResultReference {
  readonly blobKey: string;
  readonly resultDigest: FinnyCustodyDigest;
}

export interface ExpectedFinnyOperationResult extends Omit<FinnyOperationResultInput, "output"> {
  readonly resultDigest: FinnyCustodyDigest;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const RESULT_KEYS = new Set([
  "schema",
  "runId",
  "planDigest",
  "operationId",
  "operationDigest",
  "dependencyResults",
  "output",
]);
const DEPENDENCY_KEYS = new Set(["operationId", "resultDigest"]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function bytesDigest(bytes: Uint8Array): FinnyCustodyDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizedValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("Finny operation result output is invalid");
    return value;
  }
  if (!Array.isArray(value) && !plainRecord(value)) throw new Error("Finny operation result output is invalid");
  if (ancestors.has(value)) throw new Error("Finny operation result output is invalid");
  ancestors.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error("Finny operation result output is invalid");
    normalized = value.map((nested) => normalizedValue(nested, ancestors));
  } else {
    normalized = Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalizedValue(nested, ancestors)]),
    );
  }
  ancestors.delete(value);
  return normalized;
}

function normalizedOutput(value: unknown): readonly FinnyOperationRow[] {
  if (!Array.isArray(value)) throw new Error("Finny operation result output is invalid");
  return value.map((row) => {
    if (!plainRecord(row)) throw new Error("Finny operation result output is invalid");
    return normalizedValue(row, new Set()) as FinnyOperationRow;
  });
}

function normalizedDependencies(value: unknown): readonly FinnyOperationDependencyResult[] {
  if (!Array.isArray(value)) throw new Error("Finny operation result dependencies are invalid");
  const operationIds = new Set<string>();
  return value.map((candidate) => {
    if (!plainRecord(candidate)) throw new Error("Finny operation result dependency is invalid");
    const keys = Object.keys(candidate);
    if (keys.length !== DEPENDENCY_KEYS.size || keys.some((key) => !DEPENDENCY_KEYS.has(key)))
      throw new Error("Finny operation result dependency is invalid");
    const operationId = candidate.operationId;
    const resultDigest = candidate.resultDigest;
    if (
      typeof operationId !== "string" ||
      !IDENTIFIER.test(operationId) ||
      operationIds.has(operationId) ||
      typeof resultDigest !== "string" ||
      !DIGEST.test(resultDigest)
    )
      throw new Error("Finny operation result dependency is invalid");
    operationIds.add(operationId);
    return { operationId, resultDigest: resultDigest as FinnyCustodyDigest };
  });
}

function normalizedEnvelope(value: unknown): FinnyOperationResultEnvelope {
  if (!plainRecord(value)) throw new Error("Finny operation result is invalid");
  const keys = Object.keys(value);
  if (keys.length !== RESULT_KEYS.size || keys.some((key) => !RESULT_KEYS.has(key)))
    throw new Error("Finny operation result is invalid");
  if (
    value.schema !== "finny.operation_result.v1" ||
    typeof value.runId !== "string" ||
    value.runId.length === 0 ||
    typeof value.planDigest !== "string" ||
    !DIGEST.test(value.planDigest) ||
    typeof value.operationId !== "string" ||
    !IDENTIFIER.test(value.operationId) ||
    typeof value.operationDigest !== "string" ||
    !DIGEST.test(value.operationDigest)
  )
    throw new Error("Finny operation result is invalid");
  return {
    schema: value.schema,
    runId: value.runId,
    planDigest: value.planDigest as FinnyCustodyDigest,
    operationId: value.operationId,
    operationDigest: value.operationDigest as FinnyCustodyDigest,
    dependencyResults: normalizedDependencies(value.dependencyResults),
    output: normalizedOutput(value.output),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function sameDependencies(
  left: readonly FinnyOperationDependencyResult[],
  right: readonly FinnyOperationDependencyResult[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (dependency, index) =>
        dependency.operationId === right[index]?.operationId && dependency.resultDigest === right[index]?.resultDigest,
    )
  );
}

export async function storeFinnyOperationPlan(
  store: DurableByteStore,
  plan: FinnyOperationPlan,
): Promise<FinnyOperationPlanReference> {
  const bytes = encodeFinnyOperationPlan(plan);
  const stored = await store.put(bytes);
  if (`sha256:${stored.sha256}` !== plan.planDigest)
    throw new Error("Finny operation plan store returned a mismatched digest");
  return Object.freeze({ blobKey: stored.blobKey, planDigest: plan.planDigest });
}

export async function loadFinnyOperationPlan(
  store: DurableByteStore,
  reference: FinnyOperationPlanReference,
): Promise<FinnyOperationPlan> {
  const opened = await store.open(reference.blobKey);
  if (!opened) throw new Error("Finny operation plan bytes are unavailable");
  const collected = await collectBytes(opened.stream);
  if (collected.sizeBytes !== opened.sizeBytes) throw new Error("Finny operation plan byte size is invalid");
  return decodeFinnyOperationPlan(collected.data, reference.planDigest);
}

export function encodeFinnyOperationResult(input: FinnyOperationResultInput): EncodedFinnyOperationResult {
  const envelope = normalizedEnvelope({ schema: "finny.operation_result.v1", ...input });
  const bytes = Buffer.from(canonicalFinnyJson(envelope, "Finny operation result output is invalid"), "utf8");
  return Object.freeze({ bytes, resultDigest: bytesDigest(bytes) });
}

export function decodeFinnyOperationResult(
  bytes: Uint8Array,
  expected: ExpectedFinnyOperationResult,
): FinnyOperationResultEnvelope {
  if (!DIGEST.test(expected.resultDigest) || bytesDigest(bytes) !== expected.resultDigest)
    throw new Error("Finny operation result digest is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("Finny operation result is invalid");
  }
  const envelope = normalizedEnvelope(parsed);
  if (
    Buffer.from(canonicalFinnyJson(envelope, "Finny operation result output is invalid"), "utf8").compare(
      Buffer.from(bytes),
    ) !== 0
  )
    throw new Error("Finny operation result encoding is invalid");
  if (
    envelope.runId !== expected.runId ||
    envelope.planDigest !== expected.planDigest ||
    envelope.operationId !== expected.operationId ||
    envelope.operationDigest !== expected.operationDigest ||
    !sameDependencies(envelope.dependencyResults, expected.dependencyResults)
  )
    throw new Error("Finny operation result binding is invalid");
  return deepFreeze(envelope);
}

export async function storeFinnyOperationResult(
  store: DurableByteStore,
  input: FinnyOperationResultInput,
): Promise<FinnyOperationResultReference> {
  const encoded = encodeFinnyOperationResult(input);
  const stored = await store.put(encoded.bytes);
  if (`sha256:${stored.sha256}` !== encoded.resultDigest)
    throw new Error("Finny operation result store returned a mismatched digest");
  return Object.freeze({ blobKey: stored.blobKey, resultDigest: encoded.resultDigest });
}

export async function loadFinnyOperationResult(
  store: DurableByteStore,
  expected: ExpectedFinnyOperationResult,
): Promise<FinnyOperationResultEnvelope> {
  const blobKey = `files/${expected.resultDigest.slice("sha256:".length)}`;
  const opened = await store.open(blobKey);
  if (!opened) throw new Error("Finny operation result bytes are unavailable");
  const collected = await collectBytes(opened.stream);
  if (collected.sizeBytes !== opened.sizeBytes) throw new Error("Finny operation result byte size is invalid");
  return decodeFinnyOperationResult(collected.data, expected);
}
