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

export type FinnyDerivedOperation = Extract<
  FinnyCompiledOperation,
  { primitive: "project" | "filter" | "aggregate" | "join" | "reconcile" }
>;

export interface FinnyDerivedOperationExecutionInput {
  readonly operation: FinnyDerivedOperation;
  readonly parameterValues: FinnyOperationPlan["parameterValues"];
  readonly resultSets: FinnyOperationResultSets;
}

type AggregateOperation = Extract<FinnyCompiledOperation, { primitive: "aggregate" }>;
type FilterOperation = Extract<FinnyCompiledOperation, { primitive: "filter" }>;
type JoinOperation = Extract<FinnyCompiledOperation, { primitive: "join" }>;
type ProjectOperation = Extract<FinnyCompiledOperation, { primitive: "project" }>;
type ReconcileOperation = Extract<FinnyCompiledOperation, { primitive: "reconcile" }>;

function requireDecimal(operationId: string, field: string, value: unknown): FinnyDecimal {
  const parsed = parseFinnyDecimal(value);
  if (!parsed) throw new Error(`Finny operation ${operationId} field ${field} must be an exact decimal`);
  return parsed;
}

function field(operationId: string, row: FinnyOperationRow, name: string): unknown {
  if (!Object.hasOwn(row, name)) throw new Error(`Finny operation ${operationId} field ${name} is missing`);
  return row[name];
}

function unaryDependency(
  operation: FinnyCompiledOperation,
  resultSets: ReadonlyMap<string, readonly FinnyOperationRow[]>,
): readonly FinnyOperationRow[] {
  if (operation.dependsOn.length !== 1) throw new Error(`Finny operation ${operation.id} requires one dependency`);
  const dependency = operation.dependsOn[0]!;
  const rows = resultSets.get(dependency);
  if (!rows) throw new Error(`Finny operation ${operation.id} dependency ${dependency} is unavailable`);
  return rows;
}

function binaryDependencies(
  operation: FinnyCompiledOperation,
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

function project(operation: ProjectOperation, rows: readonly FinnyOperationRow[]): readonly FinnyOperationRow[] {
  return rows.map((row) => Object.fromEntries(operation.fields.map((name) => [name, field(operation.id, row, name)])));
}

function equal(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

function ordered(operationId: string, name: string, left: unknown, right: unknown): number {
  const leftDecimal = parseFinnyDecimal(left);
  const rightDecimal = parseFinnyDecimal(right);
  if (leftDecimal && rightDecimal) return compareFinnyDecimal(leftDecimal, rightDecimal);
  if (typeof left === "string" && typeof right === "string") {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  throw new Error(`Finny operation ${operationId} field ${name} values are not comparable`);
}

function matches(
  operation: FilterOperation,
  row: FinnyOperationRow,
  parameters: FinnyOperationPlan["parameterValues"],
): boolean {
  return operation.predicates.every((predicate) => {
    const value = field(operation.id, row, predicate.field);
    const parameter = predicateParameter(operation, predicate, parameters);
    switch (predicate.operator) {
      case "eq":
        return equal(value, parameter);
      case "neq":
        return !equal(value, parameter);
      case "lte":
        return ordered(operation.id, predicate.field, value, parameter) <= 0;
      case "gte":
        return ordered(operation.id, predicate.field, value, parameter) >= 0;
      case "in": {
        if (!Array.isArray(parameter) || parameter.length === 0)
          throw new Error(`Finny operation ${operation.id} in requires a reviewed non-empty array parameter`);
        return parameter.some((candidate) => equal(value, candidate));
      }
    }
  });
}

function predicateParameter(
  operation: FilterOperation,
  predicate: FilterOperation["predicates"][number],
  parameters: FinnyOperationPlan["parameterValues"],
): FinnyOperationPlan["parameterValues"][string] {
  if (!Object.hasOwn(parameters, predicate.parameter))
    throw new Error(`Finny operation ${operation.id} parameter ${predicate.parameter} is unavailable`);
  const parameter = parameters[predicate.parameter]!;
  if (predicate.operator === "in" && (!Array.isArray(parameter) || parameter.length === 0))
    throw new Error(`Finny operation ${operation.id} in requires a reviewed non-empty array parameter`);
  return parameter;
}

function filter(
  operation: FilterOperation,
  rows: readonly FinnyOperationRow[],
  parameters: FinnyOperationPlan["parameterValues"],
): readonly FinnyOperationRow[] {
  for (const predicate of operation.predicates) predicateParameter(operation, predicate, parameters);
  return rows.filter((row) => matches(operation, row, parameters)).map((row) => ({ ...row }));
}

function groupKey(operation: AggregateOperation, row: FinnyOperationRow): string {
  return JSON.stringify(operation.groupBy.map((name) => field(operation.id, row, name)));
}

function numericValues(
  operationId: string,
  metric: AggregateOperation["metrics"][number],
  rows: readonly FinnyOperationRow[],
): FinnyDecimal[] {
  return rows.map((row) => requireDecimal(operationId, metric.field, field(operationId, row, metric.field)));
}

function metricValue(
  operationId: string,
  metric: AggregateOperation["metrics"][number],
  rows: readonly FinnyOperationRow[],
): string | number {
  if (metric.operator === "count") {
    return rows.reduce((count, row) => count + (field(operationId, row, metric.field) === null ? 0 : 1), 0);
  }
  const values = numericValues(operationId, metric, rows);
  if (metric.operator === "sum")
    return renderFinnyDecimal(values.reduce(addFinnyDecimal, { coefficient: 0n, scale: 0 }));
  if (values.length === 0) throw new Error(`Finny operation ${operationId} metric ${metric.id} has no values`);
  const selected = values.slice(1).reduce((current, value) => {
    const ordering = compareFinnyDecimal(value, current);
    if (metric.operator === "min") return ordering < 0 ? value : current;
    return ordering > 0 ? value : current;
  }, values[0]!);
  return renderFinnyDecimal(selected);
}

function aggregate(operation: AggregateOperation, rows: readonly FinnyOperationRow[]): readonly FinnyOperationRow[] {
  const groups = new Map<string, FinnyOperationRow[]>();
  for (const row of rows) {
    const key = groupKey(operation, row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  if (groups.size === 0 && operation.groupBy.length === 0) groups.set("[]", []);
  return [...groups.values()].map((group) => {
    const grouped = Object.fromEntries(operation.groupBy.map((name) => [name, field(operation.id, group[0]!, name)]));
    return {
      ...grouped,
      ...Object.fromEntries(operation.metrics.map((metric) => [metric.id, metricValue(operation.id, metric, group)])),
    };
  });
}

function joinRows(operation: JoinOperation, left: FinnyOperationRow, right: FinnyOperationRow): FinnyOperationRow {
  const joined: Record<string, unknown> = { ...left };
  for (const [name, value] of Object.entries(right)) {
    if (Object.hasOwn(joined, name)) {
      if (name === operation.leftKey && name === operation.rightKey && equal(joined[name], value)) continue;
      throw new Error(`Finny operation ${operation.id} has conflicting field ${name}`);
    }
    joined[name] = value;
  }
  return joined;
}

function join(
  operation: JoinOperation,
  leftRows: readonly FinnyOperationRow[],
  rightRows: readonly FinnyOperationRow[],
): readonly FinnyOperationRow[] {
  return leftRows.flatMap((left) => {
    const leftKey = field(operation.id, left, operation.leftKey);
    const matches = rightRows.filter((right) => equal(leftKey, field(operation.id, right, operation.rightKey)));
    if (matches.length === 0) return operation.kind === "left" ? [{ ...left }] : [];
    return matches.map((right) => joinRows(operation, left, right));
  });
}

function total(operationId: string, rows: readonly FinnyOperationRow[], name: string): FinnyDecimal {
  return rows.reduce<FinnyDecimal>(
    (sum, row) => addFinnyDecimal(sum, requireDecimal(operationId, name, field(operationId, row, name))),
    { coefficient: 0n, scale: 0 },
  );
}

function reconcile(
  operation: ReconcileOperation,
  leftRows: readonly FinnyOperationRow[],
  rightRows: readonly FinnyOperationRow[],
): readonly FinnyOperationRow[] {
  const left = total(operation.id, leftRows, operation.leftField);
  const right = total(operation.id, rightRows, operation.rightField);
  const difference = subtractFinnyDecimal(left, right);
  const tolerance = requireDecimal(operation.id, "tolerance", operation.tolerance);
  const absoluteDifference = absoluteFinnyDecimal(difference);
  return [
    {
      left: renderFinnyDecimal(left),
      right: renderFinnyDecimal(right),
      difference: renderFinnyDecimal(difference),
      tolerance: renderFinnyDecimal(tolerance),
      reconciled: compareFinnyDecimal(absoluteDifference, tolerance) <= 0,
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

function executeDerived(
  operation: FinnyDerivedOperation,
  parameterValues: FinnyOperationPlan["parameterValues"],
  resultSets: ReadonlyMap<string, readonly FinnyOperationRow[]>,
): readonly FinnyOperationRow[] {
  if (operation.primitive === "project") return project(operation, unaryDependency(operation, resultSets));
  if (operation.primitive === "filter")
    return filter(operation, unaryDependency(operation, resultSets), parameterValues);
  if (operation.primitive === "aggregate") return aggregate(operation, unaryDependency(operation, resultSets));
  const [left, right] = binaryDependencies(operation, resultSets);
  return operation.primitive === "join" ? join(operation, left, right) : reconcile(operation, left, right);
}

export function executeFinnyDerivedOperation(input: FinnyDerivedOperationExecutionInput): readonly FinnyOperationRow[] {
  const operation = input.operation as unknown as FinnyCompiledOperation;
  if (operation.primitive === "suiteql_select" || operation.primitive === "repeat_pull")
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
  return executeDerived(operation, input.parameterValues, resultSets);
}

export function executeFinnyOperationPlan(input: FinnyOperationExecutionInput): FinnyOperationResultSets {
  const operations = new Map(input.plan.operations.map((operation) => [operation.id, operation]));
  for (const operationId of Object.keys(input.resultSets)) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`Finny result set ${operationId} does not belong to the operation plan`);
    if (operation.primitive !== "suiteql_select" && operation.primitive !== "repeat_pull")
      throw new Error(`Finny operation ${operationId} is derived and cannot be supplied`);
  }

  const resultSets = new Map<string, readonly FinnyOperationRow[]>();
  for (const operation of input.plan.operations) {
    if (operation.primitive === "suiteql_select" || operation.primitive === "repeat_pull") {
      for (const dependency of operation.dependsOn)
        if (!resultSets.has(dependency))
          throw new Error(`Finny operation ${operation.id} dependency ${dependency} is unavailable`);
      const supplied = input.resultSets[operation.id];
      if (!supplied) throw new Error(`Finny operation ${operation.id} must be externally supplied`);
      resultSets.set(operation.id, validateRows(operation.id, supplied));
      continue;
    }
    resultSets.set(operation.id, executeDerived(operation, input.plan.parameterValues, resultSets));
  }
  return Object.fromEntries(resultSets);
}
