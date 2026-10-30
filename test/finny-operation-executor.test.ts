import assert from "node:assert/strict";
import test from "node:test";

import type { FinnyCompiledOperation, FinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import {
  executeFinnyDerivedOperation,
  executeFinnyOperationPlan,
  type FinnyDerivedOperation,
} from "../src/finny/operation-executor.ts";

function plan(
  operations: readonly FinnyCompiledOperation[],
  parameterValues: FinnyOperationPlan["parameterValues"] = {},
): Pick<FinnyOperationPlan, "operations" | "parameterValues"> {
  return { operations, parameterValues };
}

test("project, filter, and aggregate produce exact grouped finance totals", () => {
  const result = executeFinnyOperationPlan({
    plan: plan(
      [
        {
          id: "source",
          primitive: "suiteql_select",
          dependsOn: [],
          sql: "SELECT entity, status, amount FROM transactions",
          parameters: [],
        },
        {
          id: "selected",
          primitive: "project",
          dependsOn: ["source"],
          fields: ["entity", "status", "amount"],
        },
        {
          id: "reviewed",
          primitive: "filter",
          dependsOn: ["selected"],
          predicates: [
            { field: "status", operator: "eq", parameter: "status" },
            { field: "amount", operator: "gte", parameter: "minimum" },
          ],
        },
        {
          id: "totals",
          primitive: "aggregate",
          dependsOn: ["reviewed"],
          groupBy: ["entity"],
          metrics: [
            { id: "amount", operator: "sum", field: "amount" },
            { id: "rows", operator: "count", field: "amount" },
            { id: "minimum", operator: "min", field: "amount" },
            { id: "maximum", operator: "max", field: "amount" },
          ],
        },
      ],
      { status: "reviewed", minimum: "0.1" },
    ),
    resultSets: {
      source: [
        { entity: "MTPL", status: "reviewed", amount: "0.10", ignored: "x" },
        { entity: "MTPL", status: "reviewed", amount: "0.20", ignored: "y" },
        { entity: "OTHER", status: "draft", amount: "999", ignored: "z" },
      ],
    },
  });

  assert.deepEqual(result.totals, [{ entity: "MTPL", amount: "0.3", rows: 2, minimum: "0.1", maximum: "0.2" }]);
  assert.deepEqual(result.selected, [
    { entity: "MTPL", status: "reviewed", amount: "0.10" },
    { entity: "MTPL", status: "reviewed", amount: "0.20" },
    { entity: "OTHER", status: "draft", amount: "999" },
  ]);
});

test("a derived operation executes directly from its immediate dependency result sets", () => {
  const operation: FinnyDerivedOperation = {
    id: "total",
    primitive: "aggregate",
    dependsOn: ["source"],
    groupBy: [],
    metrics: [{ id: "amount", operator: "sum", field: "amount" }],
  };

  assert.deepEqual(
    executeFinnyDerivedOperation({
      operation,
      parameterValues: {},
      resultSets: { source: [{ amount: "0.1" }, { amount: "0.2" }] },
    }),
    [{ amount: "0.3" }],
  );
});

test("the derived seam rejects provider operations and unrelated result sets", () => {
  const provider: FinnyCompiledOperation = {
    id: "source",
    primitive: "suiteql_select",
    dependsOn: [],
    sql: "SELECT amount FROM transactions",
    parameters: [],
  };
  const projection: FinnyDerivedOperation = {
    id: "projection",
    primitive: "project",
    dependsOn: ["source"],
    fields: ["amount"],
  };

  assert.throws(
    () =>
      executeFinnyDerivedOperation({
        operation: provider as unknown as FinnyDerivedOperation,
        parameterValues: {},
        resultSets: {},
      }),
    /source.*suiteql_select.*not derived/i,
  );
  assert.throws(
    () =>
      executeFinnyDerivedOperation({
        operation: projection,
        parameterValues: {},
        resultSets: { source: [{ amount: "1" }], unrelated: [{ amount: "2" }] },
      }),
    /projection.*unrelated.*unexpected/i,
  );
});

test("inner and left joins preserve left order and expand duplicate right matches", () => {
  const operations: readonly FinnyCompiledOperation[] = [
    {
      id: "vendors",
      primitive: "suiteql_select",
      dependsOn: [],
      sql: "SELECT vendor_id, vendor FROM vendors",
      parameters: [],
    },
    {
      id: "balances",
      primitive: "suiteql_select",
      dependsOn: [],
      sql: "SELECT vendor_id, balance FROM balances",
      parameters: [],
    },
    {
      id: "inner",
      primitive: "join",
      dependsOn: ["vendors", "balances"],
      kind: "inner",
      leftKey: "vendor_id",
      rightKey: "vendor_id",
    },
    {
      id: "left",
      primitive: "join",
      dependsOn: ["vendors", "balances"],
      kind: "left",
      leftKey: "vendor_id",
      rightKey: "vendor_id",
    },
  ];
  const result = executeFinnyOperationPlan({
    plan: plan(operations),
    resultSets: {
      vendors: [
        { vendor_id: "1", vendor: "A" },
        { vendor_id: "2", vendor: "B" },
      ],
      balances: [
        { vendor_id: "1", balance: "10" },
        { vendor_id: "1", balance: "20" },
      ],
    },
  });

  assert.deepEqual(result.inner, [
    { vendor_id: "1", vendor: "A", balance: "10" },
    { vendor_id: "1", vendor: "A", balance: "20" },
  ]);
  assert.deepEqual(result.left, [
    { vendor_id: "1", vendor: "A", balance: "10" },
    { vendor_id: "1", vendor: "A", balance: "20" },
    { vendor_id: "2", vendor: "B" },
  ]);
});

test("joins do not coerce numeric-looking identifiers", () => {
  const result = executeFinnyOperationPlan({
    plan: plan([
      {
        id: "left_source",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT id FROM left_source",
        parameters: [],
      },
      {
        id: "right_source",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT id, amount FROM right_source",
        parameters: [],
      },
      {
        id: "joined",
        primitive: "join",
        dependsOn: ["left_source", "right_source"],
        kind: "inner",
        leftKey: "id",
        rightKey: "id",
      },
    ]),
    resultSets: { left_source: [{ id: "01" }], right_source: [{ id: "1", amount: "10" }] },
  });

  assert.deepEqual(result.joined, []);
});

test("filter applies inequality and ordered predicates", () => {
  const result = executeFinnyOperationPlan({
    plan: plan(
      [
        {
          id: "source",
          primitive: "suiteql_select",
          dependsOn: [],
          sql: "SELECT id, date, statuses FROM transactions",
          parameters: [],
        },
        {
          id: "selected",
          primitive: "filter",
          dependsOn: ["source"],
          predicates: [
            { field: "id", operator: "neq", parameter: "excluded_id" },
            { field: "date", operator: "lte", parameter: "cutoff" },
          ],
        },
      ],
      { excluded_id: "2", cutoff: "2026-10-19" },
    ),
    resultSets: {
      source: [
        { id: "1", date: "2026-10-19", statuses: ["open", "approved"] },
        { id: "2", date: "2026-10-18", statuses: ["open"] },
        { id: "3", date: "2026-10-20", statuses: ["open"] },
        { id: "4", date: "2026-10-18", statuses: ["closed"] },
      ],
    },
  });

  assert.deepEqual(result.selected, [
    { id: "1", date: "2026-10-19", statuses: ["open", "approved"] },
    { id: "4", date: "2026-10-18", statuses: ["closed"] },
  ]);
});

test("filter in uses a reviewed non-empty array parameter", () => {
  const operations: readonly FinnyCompiledOperation[] = [
    {
      id: "source",
      primitive: "suiteql_select",
      dependsOn: [],
      sql: "SELECT status FROM transactions",
      parameters: [],
    },
    {
      id: "selected",
      primitive: "filter",
      dependsOn: ["source"],
      predicates: [{ field: "status", operator: "in", parameter: "statuses" }],
    },
  ];
  const result = executeFinnyOperationPlan({
    plan: plan(operations, { statuses: ["open", "approved"] }),
    resultSets: { source: [{ status: "open" }, { status: "closed" }] },
  });
  assert.deepEqual(result.selected, [{ status: "open" }]);
  assert.throws(
    () => executeFinnyOperationPlan({ plan: plan(operations, { statuses: [] }), resultSets: { source: [] } }),
    /selected.*non-empty array/i,
  );
});

test("reconcile compares exact decimal totals against an inclusive tolerance", () => {
  const result = executeFinnyOperationPlan({
    plan: plan([
      {
        id: "first",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT amount FROM first_pull",
        parameters: [],
      },
      {
        id: "second",
        primitive: "repeat_pull",
        dependsOn: ["first"],
        operationId: "first",
      },
      {
        id: "check",
        primitive: "reconcile",
        dependsOn: ["first", "second"],
        leftField: "amount",
        rightField: "amount",
        tolerance: "0.01",
      },
    ]),
    resultSets: {
      first: [{ amount: "0.10" }, { amount: "0.20" }],
      second: [{ amount: "0.31" }],
    },
  });

  assert.deepEqual(result.check, [
    { left: "0.3", right: "0.31", difference: "-0.01", tolerance: "0.01", reconciled: true },
  ]);
});

test("finance decimals preserve grouped separators and accounting negatives", () => {
  const result = executeFinnyOperationPlan({
    plan: plan([
      {
        id: "source",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT amount FROM transactions",
        parameters: [],
      },
      {
        id: "total",
        primitive: "aggregate",
        dependsOn: ["source"],
        groupBy: [],
        metrics: [{ id: "amount", operator: "sum", field: "amount" }],
      },
    ]),
    resultSets: { source: [{ amount: "1,200.50" }, { amount: "(200.25)" }] },
  });

  assert.deepEqual(result.total, [{ amount: "1000.25" }]);
});

test("provider and repeat-pull result sets must be supplied while derived sets cannot be injected", () => {
  const operations: readonly FinnyCompiledOperation[] = [
    {
      id: "source",
      primitive: "suiteql_select",
      dependsOn: [],
      sql: "SELECT amount FROM transactions",
      parameters: [],
    },
    { id: "repeat", primitive: "repeat_pull", dependsOn: ["source"], operationId: "source" },
    { id: "projection", primitive: "project", dependsOn: ["repeat"], fields: ["amount"] },
  ];

  assert.throws(
    () => executeFinnyOperationPlan({ plan: plan(operations), resultSets: { source: [{ amount: "1" }] } }),
    /repeat.*externally supplied/i,
  );
  assert.throws(
    () =>
      executeFinnyOperationPlan({
        plan: plan(operations),
        resultSets: {
          source: [{ amount: "1" }],
          repeat: [{ amount: "1" }],
          projection: [{ amount: "forged" }],
        },
      }),
    /projection.*derived.*cannot be supplied/i,
  );
  assert.throws(
    () =>
      executeFinnyOperationPlan({
        plan: plan([operations[0]!, { ...operations[1]!, dependsOn: ["missing"] }]),
        resultSets: { source: [{ amount: "1" }], repeat: [{ amount: "1" }] },
      }),
    /repeat.*dependency missing.*unavailable/i,
  );
});

test("execution fails closed on absent fields, dependencies, ambiguous joins, and non-decimal finance values", () => {
  const cases: Array<{
    name: string;
    operations: readonly FinnyCompiledOperation[];
    resultSets: Record<string, readonly Record<string, unknown>[]>;
    error: RegExp;
  }> = [
    {
      name: "project field",
      operations: [
        {
          id: "source",
          primitive: "suiteql_select",
          dependsOn: [],
          sql: "SELECT amount FROM transactions",
          parameters: [],
        },
        { id: "projection", primitive: "project", dependsOn: ["source"], fields: ["currency"] },
      ],
      resultSets: { source: [{ amount: "1" }] },
      error: /projection.*currency.*missing/i,
    },
    {
      name: "dependency",
      operations: [{ id: "projection", primitive: "project", dependsOn: ["missing"], fields: ["amount"] }],
      resultSets: {},
      error: /projection.*dependency missing.*unavailable/i,
    },
    {
      name: "join collision",
      operations: [
        {
          id: "left_source",
          primitive: "suiteql_select",
          dependsOn: [],
          sql: "SELECT id, currency FROM left_source",
          parameters: [],
        },
        {
          id: "right_source",
          primitive: "suiteql_select",
          dependsOn: [],
          sql: "SELECT id, currency FROM right_source",
          parameters: [],
        },
        {
          id: "joined",
          primitive: "join",
          dependsOn: ["left_source", "right_source"],
          kind: "inner",
          leftKey: "id",
          rightKey: "id",
        },
      ],
      resultSets: {
        left_source: [{ id: "1", currency: "INR" }],
        right_source: [{ id: "1", currency: "INR" }],
      },
      error: /joined.*conflicting.*currency/i,
    },
    {
      name: "aggregate decimal",
      operations: [
        {
          id: "source",
          primitive: "suiteql_select",
          dependsOn: [],
          sql: "SELECT amount FROM transactions",
          parameters: [],
        },
        {
          id: "total",
          primitive: "aggregate",
          dependsOn: ["source"],
          groupBy: [],
          metrics: [{ id: "amount", operator: "sum", field: "amount" }],
        },
      ],
      resultSets: { source: [{ amount: "unknown" }] },
      error: /total.*amount.*decimal/i,
    },
  ];

  for (const fixture of cases)
    assert.throws(
      () => executeFinnyOperationPlan({ plan: plan(fixture.operations), resultSets: fixture.resultSets }),
      fixture.error,
      fixture.name,
    );
});
