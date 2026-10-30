import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadFinnyCapabilityPack } from "../src/finny/capability-pack.ts";
import { compileFinnyControllerRequest } from "../src/finny/controller-compiler.ts";

const catalog = loadFinnyCapabilityPack(resolve("finny-skills/capabilities"));

test("an AP typed candidate compiles through the reviewed capability pack", async () => {
  const result = compileFinnyControllerRequest(
    {
      capabilityId: "ap_gl_control_balance",
      dimensions: { entity: "all", period: "current", currency: "source_base", grain: "total", artifact: "optional" },
    },
    await catalog,
  );

  assert.equal(result.status, "compiled");
  if (result.status !== "compiled") return;
  assert.equal(result.plan.capabilityId, "ap_gl_control_balance");
  assert.equal(result.plan.resultOperationId, "ap_control_source");
  assert.deepEqual(result.plan.dimensions, {
    artifact: "optional",
    currency: "source_base",
    entity: "all",
    grain: "total",
    period: "current",
    sources: ["netsuite"],
  });
  assert.equal(result.plan.operations[0]?.primitive, "suiteql_select");
  if (result.plan.operations[0]?.primitive !== "suiteql_select") return;
  assert.equal(
    result.plan.operations[0].sql,
    "SELECT COALESCE(SUM(NVL(tal.credit, 0) - NVL(tal.debit, 0)), 0) AS total FROM TransactionAccountingLine tal WHERE tal.accounttype = 'AcctPay' AND tal.accountingbook = 1",
  );
});

test("an unrelated typed candidate compiles without a measure-specific code path", async () => {
  const result = compileFinnyControllerRequest(
    {
      capabilityId: "synthetic_inventory_velocity",
      dimensions: {
        entity: "Example Manufacturing",
        period: "2026-10-19",
        currency: "source_base",
        grain: "total",
        artifact: "optional",
      },
    },
    await catalog,
  );

  assert.equal(result.status, "compiled");
  if (result.status !== "compiled") return;
  assert.equal(result.plan.capabilityId, "synthetic_inventory_velocity");
  assert.equal(result.plan.parameterValues.entity_name, "Example Manufacturing");
  assert.equal(result.plan.parameterValues.cutoff_date, "2026-10-19");
  assert.equal(result.plan.parameterValues.accounting_book, "primary");
});

test("a reviewed requested artifact format becomes the effective plan format", async () => {
  const result = compileFinnyControllerRequest(
    {
      capabilityId: "ap_gl_control_balance",
      dimensions: { entity: "all", period: "current", currency: "source_base", grain: "total", artifact: "required" },
      artifactFormat: "csv",
    },
    await catalog,
  );

  assert.equal(result.status, "compiled");
  if (result.status !== "compiled") return;
  assert.equal(result.plan.artifactPolicy.defaultFormat, "csv");
  assert.equal(result.plan.dimensions.artifact, "required");
});

test("invalid candidates remain typed failures", async () => {
  const result = compileFinnyControllerRequest(
    { capabilityId: "ap_balance", dimensions: { entity: "all" } },
    await catalog,
  );
  assert.equal(result.status, "invalid_candidate");
});
