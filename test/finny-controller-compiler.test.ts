import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadFinnyCapabilityPack } from "../src/finny/capability-pack.ts";
import { compileFinnyControllerRequest } from "../src/finny/controller-compiler.ts";
import { FINNY_AP_GL_CONTROL_BALANCE_QUERY } from "../src/finny/reviewed-query.ts";

const catalog = loadFinnyCapabilityPack(resolve("finny-skills/capabilities"));

test("AP compatibility compiles through the reviewed capability pack", async () => {
  const result = compileFinnyControllerRequest("What is our AP balance?", await catalog);

  assert.equal(result.status, "compiled");
  if (result.status !== "compiled") return;
  assert.equal(result.plan.capabilityId, "ap_gl_control_balance");
  assert.match(result.plan.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.plan.resultOperationId, "ap_control_source");
  assert.deepEqual(result.plan.dimensions, {
    artifact: "optional",
    currency: { kind: "source_base" },
    entity: { kind: "all" },
    grain: "total",
    period: { kind: "current" },
    sources: ["netsuite"],
  });
  assert.equal(result.plan.operations[0]?.primitive, "suiteql_select");
  if (result.plan.operations[0]?.primitive !== "suiteql_select") return;
  assert.equal(result.plan.operations[0].sql, FINNY_AP_GL_CONTROL_BALANCE_QUERY);
});

test("an unrelated reviewed measure compiles without a measure-specific code path", async () => {
  const result = compileFinnyControllerRequest(
    "Inventory velocity for Example Manufacturing as at 19-Oct-2026",
    await catalog,
  );

  assert.equal(result.status, "compiled");
  if (result.status !== "compiled") return;
  assert.equal(result.plan.capabilityId, "synthetic_inventory_velocity");
  assert.equal(result.plan.parameterValues.entity_name, "Example Manufacturing");
  assert.equal(result.plan.parameterValues.cutoff_date, "2026-10-19");
  assert.equal(result.plan.parameterValues.accounting_book, "primary");
});

test("unsupported and unresolved requests remain typed failures", async () => {
  const financeCatalog = await catalog;

  assert.equal(compileFinnyControllerRequest("show cash position", financeCatalog).status, "unsupported_template");
  const unresolved = compileFinnyControllerRequest(
    "Compare AP balance with inventory velocity for Example Manufacturing as at 19-Oct-2026",
    financeCatalog,
  );
  assert.equal(unresolved.status, "unsupported_template");
});
