import { createHash } from "node:crypto";

import type { FinnyCompiledOperation, FinnyOperationPlan } from "./operation-compiler.ts";
import {
  executeFinnyDerivedOperation,
  type FinnyDerivedOperation,
  type FinnyOperationResultSets,
  type FinnyOperationRow,
} from "./operation-executor.ts";

export type FinnyOperationResultDigest = `sha256:${string}`;

export interface FinnyVerifiedOperationResultSet {
  readonly rows: readonly FinnyOperationRow[];
  readonly digest: FinnyOperationResultDigest;
}

export type FinnyVerifiedOperationResultSets = Readonly<Record<string, FinnyVerifiedOperationResultSet>>;

export interface FinnyOperationRunnerContext {
  readonly operation: FinnyCompiledOperation;
  readonly dependencyResultSets: FinnyOperationResultSets;
  readonly dependencyDigests: Readonly<Record<string, FinnyOperationResultDigest>>;
}

export interface FinnyOperationCompletedContext extends FinnyOperationRunnerContext {
  readonly rows: readonly FinnyOperationRow[];
  readonly digest: FinnyOperationResultDigest;
}

export interface FinnyOperationRunnerInput {
  readonly plan: Pick<FinnyOperationPlan, "operations" | "parameterValues">;
  readonly targetOperationIds: readonly string[];
  readonly restoredResultSets?: FinnyVerifiedOperationResultSets;
  readonly forceFreshOperationIds?: readonly string[];
  readonly executeExternal: (context: FinnyOperationRunnerContext) => Promise<readonly FinnyOperationRow[]>;
  readonly onCompleted?: (context: FinnyOperationCompletedContext) => Promise<void>;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function normalizedValue(value: unknown, ancestors: Set<object>, operationId: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0))
      throw new Error(`Finny operation ${operationId} result contains an invalid number`);
    return value;
  }
  if (!Array.isArray(value) && !plainRecord(value))
    throw new Error(`Finny operation ${operationId} result contains unsupported data`);
  if (ancestors.has(value)) throw new Error(`Finny operation ${operationId} result contains a cycle`);
  ancestors.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length)
      throw new Error(`Finny operation ${operationId} result contains a sparse array`);
    normalized = value.map((nested) => normalizedValue(nested, ancestors, operationId));
  } else {
    normalized = Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalizedValue(nested, ancestors, operationId)]),
    );
  }
  ancestors.delete(value);
  return normalized;
}

function freezeValue(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) freezeValue(nested);
  Object.freeze(value);
}

function normalizeRows(operationId: string, rows: unknown): readonly FinnyOperationRow[] {
  if (!Array.isArray(rows)) throw new Error(`Finny operation ${operationId} result set must be an array`);
  const normalized = rows.map((row) => {
    if (!plainRecord(row)) throw new Error(`Finny operation ${operationId} result row must be an object`);
    return normalizedValue(row, new Set(), operationId) as FinnyOperationRow;
  });
  freezeValue(normalized);
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainRecord(value))
    return `{${Object.entries(value)
      .sort(([left], [right]) => {
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
      })
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function digestFinnyOperationRows(rows: readonly FinnyOperationRow[]): FinnyOperationResultDigest {
  const normalized = normalizeRows("result_digest", rows);
  return `sha256:${createHash("sha256").update(canonicalJson(normalized)).digest("hex")}`;
}

function operationsById(operations: readonly FinnyCompiledOperation[]): ReadonlyMap<string, FinnyCompiledOperation> {
  const result = new Map<string, FinnyCompiledOperation>();
  for (const operation of operations) {
    if (result.has(operation.id)) throw new Error(`Finny operation plan contains duplicate operation ${operation.id}`);
    for (const dependency of operation.dependsOn)
      if (!result.has(dependency))
        throw new Error(`Finny operation ${operation.id} dependency ${dependency} is unresolved`);
    result.set(operation.id, operation);
  }
  return result;
}

function dependencyClosure(
  targetIds: readonly string[],
  operations: ReadonlyMap<string, FinnyCompiledOperation>,
): Set<string> {
  if (targetIds.length === 0) throw new Error("Finny operation targets are required");
  const closure = new Set<string>();
  const visit = (operationId: string): void => {
    if (closure.has(operationId)) return;
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`Finny operation target ${operationId} is invalid`);
    closure.add(operationId);
    for (const dependency of operation.dependsOn) visit(dependency);
  };
  for (const targetId of targetIds) visit(targetId);
  return closure;
}

function descendants(
  forcedIds: readonly string[],
  closure: ReadonlySet<string>,
  operations: readonly FinnyCompiledOperation[],
): Set<string> {
  const fresh = new Set(forcedIds);
  for (const operation of operations) {
    if (!closure.has(operation.id)) continue;
    if (operation.dependsOn.some((dependency) => fresh.has(dependency))) fresh.add(operation.id);
  }
  return fresh;
}

function requiredOperations(
  targetIds: readonly string[],
  operations: ReadonlyMap<string, FinnyCompiledOperation>,
  restored: FinnyVerifiedOperationResultSets,
  fresh: ReadonlySet<string>,
): Set<string> {
  const required = new Set<string>();
  const visit = (operationId: string): void => {
    if (required.has(operationId)) return;
    required.add(operationId);
    if (Object.hasOwn(restored, operationId) && !fresh.has(operationId)) return;
    for (const dependency of operations.get(operationId)!.dependsOn) visit(dependency);
  };
  for (const targetId of targetIds) visit(targetId);
  return required;
}

function verifiedRestoredSets(
  restored: FinnyVerifiedOperationResultSets,
  operations: ReadonlyMap<string, FinnyCompiledOperation>,
): FinnyVerifiedOperationResultSets {
  const verified: Record<string, FinnyVerifiedOperationResultSet> = {};
  for (const [operationId, result] of Object.entries(restored)) {
    if (!operations.has(operationId))
      throw new Error(`Finny restored result set ${operationId} does not belong to the operation plan`);
    if (!result || !DIGEST.test(result.digest))
      throw new Error(`Finny operation ${operationId} restored result digest is invalid`);
    const rows = normalizeRows(operationId, result.rows);
    const digest = digestFinnyOperationRows(rows);
    if (digest !== result.digest) throw new Error(`Finny operation ${operationId} restored result digest is corrupt`);
    verified[operationId] = Object.freeze({ rows, digest });
  }
  return Object.freeze(verified);
}

function dependencyContext(
  operation: FinnyCompiledOperation,
  results: FinnyVerifiedOperationResultSets,
): Pick<FinnyOperationRunnerContext, "dependencyResultSets" | "dependencyDigests"> {
  const dependencyResultSets: Record<string, readonly FinnyOperationRow[]> = {};
  const dependencyDigests: Record<string, FinnyOperationResultDigest> = {};
  for (const dependency of operation.dependsOn) {
    const result = results[dependency];
    if (!result) throw new Error(`Finny operation ${operation.id} dependency ${dependency} is unavailable`);
    dependencyResultSets[dependency] = result.rows;
    dependencyDigests[dependency] = result.digest;
  }
  return {
    dependencyResultSets: Object.freeze(dependencyResultSets),
    dependencyDigests: Object.freeze(dependencyDigests),
  };
}

function executeDerived(
  operation: FinnyDerivedOperation,
  dependencies: FinnyOperationResultSets,
  parameterValues: FinnyOperationPlan["parameterValues"],
): readonly FinnyOperationRow[] {
  return executeFinnyDerivedOperation({
    operation,
    parameterValues,
    resultSets: dependencies,
  });
}

export async function runFinnyOperationPlan(
  input: FinnyOperationRunnerInput,
): Promise<FinnyVerifiedOperationResultSets> {
  const operationMap = operationsById(input.plan.operations);
  const fullClosure = dependencyClosure(input.targetOperationIds, operationMap);
  const restored = verifiedRestoredSets(input.restoredResultSets ?? {}, operationMap);
  const forcedIds = input.forceFreshOperationIds ?? [];
  for (const operationId of forcedIds)
    if (!fullClosure.has(operationId))
      throw new Error(`Finny forced operation ${operationId} is outside the requested target closure`);
  const fresh = descendants(forcedIds, fullClosure, input.plan.operations);
  const required = requiredOperations(input.targetOperationIds, operationMap, restored, fresh);
  const results: Record<string, FinnyVerifiedOperationResultSet> = {};

  for (const operation of input.plan.operations) {
    if (!required.has(operation.id)) continue;
    if (Object.hasOwn(restored, operation.id) && !fresh.has(operation.id)) {
      results[operation.id] = restored[operation.id]!;
      continue;
    }
    const dependency = dependencyContext(operation, results);
    const context = Object.freeze({ operation, ...dependency });
    const produced =
      operation.primitive === "suiteql_select" || operation.primitive === "repeat_pull"
        ? await input.executeExternal(context)
        : executeDerived(operation, dependency.dependencyResultSets, input.plan.parameterValues);
    const rows = normalizeRows(operation.id, produced);
    const digest = digestFinnyOperationRows(rows);
    const completed = Object.freeze({ ...context, rows, digest });
    if (input.onCompleted) await input.onCompleted(completed);
    results[operation.id] = Object.freeze({ rows, digest });
  }

  for (const targetId of input.targetOperationIds)
    if (!results[targetId]) throw new Error(`Finny operation target ${targetId} did not produce a verified result set`);
  return Object.freeze(results);
}
