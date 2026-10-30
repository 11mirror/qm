import assert from "node:assert/strict";
import test from "node:test";

import type { FinnyCompiledOperation, FinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import { executeFinnyDerivedOperation, executeFinnyOperationPlan } from "../src/finny/operation-executor.ts";

function plan(
  operations: readonly FinnyCompiledOperation[],
): Pick<FinnyOperationPlan, "operations" | "parameterValues"> {
  return { operations, parameterValues: {} };
}

const operations: readonly FinnyCompiledOperation[] = [
  {
    id: "first",
    primitive: "suiteql_select",
    dependsOn: [],
    sql: "SELECT total FROM reviewed_balance",
    parameters: [],
  },
  { id: "second", primitive: "repeat_pull", dependsOn: ["first"], operationId: "first" },
  {
    id: "check",
    primitive: "reconcile",
    dependsOn: ["first", "second"],
    leftField: "total",
    rightField: "total",
    tolerance: "0.01",
  },
];

test("reconcile compares reviewed pull totals using exact decimals and an inclusive tolerance", () => {
  const result = executeFinnyOperationPlan({
    plan: plan(operations),
    resultSets: {
      first: [{ total: "1,200.50" }, { total: "(200.25)" }],
      second: [{ total: "1000.26" }],
    },
  });

  assert.deepEqual(result.check, [
    { left: "1000.25", right: "1000.26", difference: "-0.01", tolerance: "0.01", reconciled: true },
  ]);
});

test("reconcile accepts combined accounting, grouping, and exponent notation", () => {
  const result = executeFinnyOperationPlan({
    plan: plan(operations),
    resultSets: {
      first: [{ total: "(1,234.50e2)" }],
      second: [{ total: "-123450" }],
    },
  });

  assert.deepEqual(result.check, [
    { left: "-123450", right: "-123450", difference: "0", tolerance: "0.01", reconciled: true },
  ]);
});

test("reconcile rejects exponents beyond the exact-decimal bound", () => {
  assert.throws(
    () =>
      executeFinnyOperationPlan({
        plan: plan(operations),
        resultSets: {
          first: [{ total: "1e1001" }],
          second: [{ total: "1" }],
        },
      }),
    /check.*total.*decimal/i,
  );
});

test("the derived seam executes only reconciliation from its exact dependencies", () => {
  const operation = operations[2]!;
  if (operation.primitive !== "reconcile") assert.fail("expected reconciliation");

  assert.deepEqual(
    executeFinnyDerivedOperation({
      operation,
      parameterValues: {},
      resultSets: { first: [{ total: "10" }], second: [{ total: "10" }] },
    }),
    [{ left: "10", right: "10", difference: "0", tolerance: "0.01", reconciled: true }],
  );
  assert.throws(
    () =>
      executeFinnyDerivedOperation({
        operation,
        parameterValues: {},
        resultSets: { first: [{ total: "10" }], second: [{ total: "10" }], unrelated: [] },
      }),
    /check.*unrelated.*unexpected/i,
  );
});

test("provider pulls are externally supplied and reconciliation cannot be injected", () => {
  assert.throws(
    () => executeFinnyOperationPlan({ plan: plan(operations), resultSets: { first: [{ total: "1" }] } }),
    /second.*externally supplied/i,
  );
  assert.throws(
    () =>
      executeFinnyOperationPlan({
        plan: plan(operations),
        resultSets: { first: [{ total: "1" }], second: [{ total: "1" }], check: [{ reconciled: true }] },
      }),
    /check.*derived.*cannot be supplied/i,
  );
  assert.throws(
    () =>
      executeFinnyOperationPlan({
        plan: plan(operations),
        resultSets: { first: [{ total: "unknown" }], second: [{ total: "1" }] },
      }),
    /check.*total.*decimal/i,
  );
});
