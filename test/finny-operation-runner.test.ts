import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { FinnyCompiledOperation, FinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import {
  digestFinnyOperationRows,
  runFinnyOperationPlan,
  type FinnyVerifiedOperationResultSet,
} from "../src/finny/operation-runner.ts";

function plan(
  operations: readonly FinnyCompiledOperation[],
  parameterValues: FinnyOperationPlan["parameterValues"] = {},
): Pick<FinnyOperationPlan, "operations" | "parameterValues"> {
  return { operations, parameterValues };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function verified(rows: readonly Readonly<Record<string, unknown>>[]): FinnyVerifiedOperationResultSet {
  return {
    rows,
    digest: `sha256:${createHash("sha256").update(canonical(rows)).digest("hex")}`,
  };
}

const source: FinnyCompiledOperation = {
  id: "source",
  primitive: "suiteql_select",
  dependsOn: [],
  sql: "SELECT entity, amount FROM transactions",
  parameters: [],
};
const selected: FinnyCompiledOperation = {
  id: "selected",
  primitive: "project",
  dependsOn: ["source"],
  fields: ["entity", "amount"],
};
const totals: FinnyCompiledOperation = {
  id: "totals",
  primitive: "aggregate",
  dependsOn: ["selected"],
  groupBy: ["entity"],
  metrics: [{ id: "amount", operator: "sum", field: "amount" }],
};

test("runs only the requested target dependency closure in plan order", async () => {
  const externalIds: string[] = [];
  const completedIds: string[] = [];
  const result = await runFinnyOperationPlan({
    plan: plan([
      source,
      selected,
      totals,
      {
        id: "unrelated",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT amount FROM unrelated",
        parameters: [],
      },
    ]),
    targetOperationIds: ["selected"],
    executeExternal: async ({ operation }) => {
      externalIds.push(operation.id);
      return [{ entity: "MTPL", amount: "10", ignored: true }];
    },
    onCompleted: async ({ operation }) => {
      completedIds.push(operation.id);
    },
  });

  assert.deepEqual(externalIds, ["source"]);
  assert.deepEqual(completedIds, ["source", "selected"]);
  assert.deepEqual(Object.keys(result), ["source", "selected"]);
  assert.deepEqual(result.selected?.rows, [{ entity: "MTPL", amount: "10" }]);
});

test("reuses a verified derived dependency without requiring its source", async () => {
  const selectedRows = verified([
    { entity: "MTPL", amount: "10" },
    { entity: "MTPL", amount: "20" },
  ]);
  const completedIds: string[] = [];
  const result = await runFinnyOperationPlan({
    plan: plan([source, selected, totals]),
    targetOperationIds: ["totals"],
    restoredResultSets: { selected: selectedRows },
    executeExternal: async () => {
      throw new Error("source must not execute");
    },
    onCompleted: async ({ operation }) => {
      completedIds.push(operation.id);
    },
  });

  assert.deepEqual(completedIds, ["totals"]);
  assert.deepEqual(result.totals?.rows, [{ entity: "MTPL", amount: "30" }]);
  assert.equal(result.selected?.digest, selectedRows.digest);
});

test("forces a repeat pull and its downstream verification fresh while retaining its source", async () => {
  const repeat: FinnyCompiledOperation = {
    id: "repeat",
    primitive: "repeat_pull",
    dependsOn: ["source"],
    operationId: "source",
  };
  const check: FinnyCompiledOperation = {
    id: "check",
    primitive: "reconcile",
    dependsOn: ["source", "repeat"],
    leftField: "amount",
    rightField: "amount",
    tolerance: "0",
  };
  const sourceRows = verified([{ entity: "MTPL", amount: "30" }]);
  const oldRepeat = verified([{ entity: "MTPL", amount: "29" }]);
  const oldCheck = verified([{ reconciled: false }]);
  const completedIds: string[] = [];
  const result = await runFinnyOperationPlan({
    plan: plan([source, repeat, check]),
    targetOperationIds: ["check"],
    restoredResultSets: { source: sourceRows, repeat: oldRepeat, check: oldCheck },
    forceFreshOperationIds: ["repeat"],
    executeExternal: async ({ operation, dependencyResultSets, dependencyDigests }) => {
      assert.equal(operation.id, "repeat");
      assert.deepEqual(dependencyResultSets.source, sourceRows.rows);
      assert.equal(dependencyDigests.source, sourceRows.digest);
      return [{ entity: "MTPL", amount: "30" }];
    },
    onCompleted: async ({ operation, dependencyResultSets, dependencyDigests, rows, digest }) => {
      completedIds.push(operation.id);
      assert.equal(digest, digestFinnyOperationRows(rows));
      if (operation.id === "check") {
        assert.deepEqual(dependencyResultSets.repeat, [{ entity: "MTPL", amount: "30" }]);
        assert.equal(dependencyDigests.source, sourceRows.digest);
      }
    },
  });

  assert.deepEqual(completedIds, ["repeat", "check"]);
  assert.deepEqual(result.check?.rows, [
    { left: "30", right: "30", difference: "0", tolerance: "0", reconciled: true },
  ]);
  assert.equal(result.source?.digest, sourceRows.digest);
  assert.notEqual(result.repeat?.digest, oldRepeat.digest);
});

test("rejects a corrupt restored result before executing any operation", async () => {
  let invoked = false;
  await assert.rejects(
    runFinnyOperationPlan({
      plan: plan([source, selected]),
      targetOperationIds: ["selected"],
      restoredResultSets: {
        source: { rows: [{ entity: "MTPL", amount: "10" }], digest: `sha256:${"0".repeat(64)}` },
      },
      executeExternal: async () => {
        invoked = true;
        return [];
      },
    }),
    /source.*digest/i,
  );
  assert.equal(invoked, false);
});

test("fails closed for invalid targets, forced nodes, and unresolved dependencies", async () => {
  const executeExternal = async () => [];
  await assert.rejects(
    runFinnyOperationPlan({ plan: plan([source]), targetOperationIds: ["missing"], executeExternal }),
    /target.*missing/i,
  );
  await assert.rejects(
    runFinnyOperationPlan({
      plan: plan([source, selected]),
      targetOperationIds: ["source"],
      forceFreshOperationIds: ["selected"],
      executeExternal,
    }),
    /forced.*selected.*closure/i,
  );
  await assert.rejects(
    runFinnyOperationPlan({
      plan: plan([{ ...selected, dependsOn: ["missing"] }]),
      targetOperationIds: ["selected"],
      executeExternal,
    }),
    /dependency missing/i,
  );
});

test("rejects malformed external rows without recording completion", async () => {
  let completed = false;
  await assert.rejects(
    runFinnyOperationPlan({
      plan: plan([source]),
      targetOperationIds: ["source"],
      executeExternal: async () => [null as unknown as Record<string, unknown>],
      onCompleted: async () => {
        completed = true;
      },
    }),
    /source.*row.*object/i,
  );
  assert.equal(completed, false);
});
