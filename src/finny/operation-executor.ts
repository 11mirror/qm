import type { FinnyCompiledOperation, FinnyOperationPlan } from "./operation-compiler.ts";
import {
  absoluteFinnyDecimal,
  addFinnyDecimal,
  compareFinnyDecimal,
  parseFinnyDecimal,
  renderFinnyDecimal,
  subtractFinnyDecimal,
  type FinnyDecimal,
} from "./decimal.ts";

export type FinnyOperationRow = Readonly<Record<string, unknown>>;
export type FinnyOperationResultSets = Readonly<Record<string, readonly FinnyOperationRow[]>>;

export interface FinnyOperationExecutionInput {
  readonly plan: Pick<FinnyOperationPlan, "operations" | "parameterValues">;
  readonly resultSets: FinnyOperationResultSets;
}

export type FinnyDerivedOperation = Extract<FinnyCompiledOperation, { primitive: "reconcile" }>;

export interface FinnyDerivedOperationExecutionInput {
  readonly operation: FinnyDerivedOperation;
  readonly parameterValues: FinnyOperationPlan["parameterValues"];
  readonly resultSets: FinnyOperationResultSets;
}

function requireDecimal(operationId: string, field: string, value: unknown): FinnyDecimal {
  const parsed = parseFinnyDecimal(value);
  if (!parsed) throw new Error(`Finny operation ${operationId} field ${field} must be an exact decimal`);
  return parsed;
}

function field(operationId: string, row: FinnyOperationRow, name: string): unknown {
  if (!Object.hasOwn(row, name)) throw new Error(`Finny operation ${operationId} field ${name} is missing`);
  return row[name];
}

function dependencyRows(
  operation: FinnyDerivedOperation,
  resultSets: ReadonlyMap<string, readonly FinnyOperationRow[]>,
): readonly [readonly FinnyOperationRow[], readonly FinnyOperationRow[]] {
  if (operation.dependsOn.length !== 2) throw new Error(`Finny operation ${operation.id} requires two dependencies`);
  const leftId = operation.dependsOn[0]!;
  const rightId = operation.dependsOn[1]!;
  const left = resultSets.get(leftId);
  const right = resultSets.get(rightId);
  if (!left) throw new Error(`Finny operation ${operation.id} dependency ${leftId} is unavailable`);
  if (!right) throw new Error(`Finny operation ${operation.id} dependency ${rightId} is unavailable`);
  return [left, right];
}

function total(operationId: string, rows: readonly FinnyOperationRow[], name: string): FinnyDecimal {
  return rows.reduce<FinnyDecimal>(
    (sum, row) => addFinnyDecimal(sum, requireDecimal(operationId, name, field(operationId, row, name))),
    parseFinnyDecimal(0)!,
  );
}

function reconcile(
  operation: FinnyDerivedOperation,
  leftRows: readonly FinnyOperationRow[],
  rightRows: readonly FinnyOperationRow[],
): readonly FinnyOperationRow[] {
  const left = total(operation.id, leftRows, operation.leftField);
  const right = total(operation.id, rightRows, operation.rightField);
  const difference = subtractFinnyDecimal(left, right);
  const tolerance = requireDecimal(operation.id, "tolerance", operation.tolerance);
  return [
    {
      left: renderFinnyDecimal(left),
      right: renderFinnyDecimal(right),
      difference: renderFinnyDecimal(difference),
      tolerance: renderFinnyDecimal(tolerance),
      reconciled: compareFinnyDecimal(absoluteFinnyDecimal(difference), tolerance) <= 0,
    },
  ];
}

function validateRows(operationId: string, rows: readonly FinnyOperationRow[]): readonly FinnyOperationRow[] {
  if (!Array.isArray(rows)) throw new Error(`Finny operation ${operationId} result set must be an array`);
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error(`Finny operation ${operationId} result row must be an object`);
    return { ...row };
  });
}

export function executeFinnyDerivedOperation(input: FinnyDerivedOperationExecutionInput): readonly FinnyOperationRow[] {
  const operation = input.operation as unknown as FinnyCompiledOperation;
  if (operation.primitive !== "reconcile")
    throw new Error(`Finny operation ${operation.id} primitive ${operation.primitive} is not derived`);
  for (const operationId of Object.keys(input.resultSets))
    if (!operation.dependsOn.includes(operationId))
      throw new Error(`Finny operation ${operation.id} result set ${operationId} is unexpected`);
  const resultSets = new Map<string, readonly FinnyOperationRow[]>();
  for (const dependency of operation.dependsOn) {
    const rows = input.resultSets[dependency];
    if (!rows) throw new Error(`Finny operation ${operation.id} dependency ${dependency} is unavailable`);
    resultSets.set(dependency, validateRows(dependency, rows));
  }
  return reconcile(input.operation, ...dependencyRows(input.operation, resultSets));
}

export function executeFinnyOperationPlan(input: FinnyOperationExecutionInput): FinnyOperationResultSets {
  const operations = new Map(input.plan.operations.map((operation) => [operation.id, operation]));
  for (const operationId of Object.keys(input.resultSets)) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`Finny result set ${operationId} does not belong to the operation plan`);
    if (operation.primitive === "reconcile")
      throw new Error(`Finny operation ${operationId} is derived and cannot be supplied`);
  }

  const resultSets = new Map<string, readonly FinnyOperationRow[]>();
  for (const operation of input.plan.operations) {
    if (operation.primitive !== "reconcile") {
      for (const dependency of operation.dependsOn)
        if (!resultSets.has(dependency))
          throw new Error(`Finny operation ${operation.id} dependency ${dependency} is unavailable`);
      const supplied = input.resultSets[operation.id];
      if (!supplied) throw new Error(`Finny operation ${operation.id} must be externally supplied`);
      resultSets.set(operation.id, validateRows(operation.id, supplied));
      continue;
    }
    resultSets.set(
      operation.id,
      executeFinnyDerivedOperation({
        operation,
        parameterValues: input.plan.parameterValues,
        resultSets: Object.fromEntries(
          operation.dependsOn.map((dependency) => [dependency, resultSets.get(dependency)!]),
        ),
      }),
    );
  }
  return Object.fromEntries(resultSets);
}
