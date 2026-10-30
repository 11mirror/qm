import assert from "node:assert/strict";
import { test } from "node:test";

import { compileFinnyFinanceIntent, FINNY_REVIEWED_SCHEMA_REGISTRY } from "../src/finny/capability-registry.ts";
import { normalizeFinnyFinanceIntent } from "../src/finny/finance-ir.ts";
import { FINNY_AP_GL_CONTROL_BALANCE_QUERY } from "../src/finny/reviewed-query.ts";

test("compiles reviewed current aggregate AP using only the reviewed query", () => {
  const result = compileFinnyFinanceIntent(normalizeFinnyFinanceIntent("What is our AP balance?"));
  assert.equal(result.status, "compiled");
  if (result.status !== "compiled") return;
  assert.equal(result.query, FINNY_AP_GL_CONTROL_BALANCE_QUERY);
  assert.equal(result.capabilityId, "ap_gl_control_balance.v1");
  assert.equal(result.schemaAuthorityId, "netsuite.ap_gl_control_balance.v1");
  assert.equal(result.ir.verification, "single_numeric_total");
});

test("blocks unsupported measures without returning SQL", () => {
  const result = compileFinnyFinanceIntent(normalizeFinnyFinanceIntent("Give me revenue"));
  assert.equal(result.status, "unsupported_template");
  assert.equal(Object.hasOwn(result, "query"), false);
});

test("requires reviewed authority before compiling even a supported measure", () => {
  const ir = normalizeFinnyFinanceIntent("AP balance");
  for (const schemas of [
    [],
    FINNY_REVIEWED_SCHEMA_REGISTRY.map((schema) => ({ ...schema, status: "unreviewed" as const })),
  ]) {
    const result = compileFinnyFinanceIntent(ir, { schemas });
    assert.equal(result.status, "schema_mapping_required");
    assert.equal(Object.hasOwn(result, "query"), false);
  }
});

test("does not silently drop unsupported finance dimensions", () => {
  const intents = [
    { request: "AP balance", entity: { kind: "named" as const, name: "Example Manufacturing" } },
    { request: "AP balance", period: { kind: "as_of" as const, date: "2026-03-31" } },
    { request: "AP balance", currency: { kind: "specified" as const, code: "USD" } },
    { request: "AP balance", grain: "vendor" as const },
    { request: "AP balance", sources: ["legacy" as const] },
    { request: "AP balance", migrationMarkers: ["opening balance"] },
  ];
  for (const intent of intents) {
    const result = compileFinnyFinanceIntent(normalizeFinnyFinanceIntent(intent));
    assert.equal(result.status, "schema_mapping_required", JSON.stringify(intent));
    assert.equal(Object.hasOwn(result, "query"), false);
  }
});

test("rejects incomplete schema mappings instead of trusting only the review label", () => {
  const result = compileFinnyFinanceIntent(normalizeFinnyFinanceIntent("AP balance"), {
    schemas: FINNY_REVIEWED_SCHEMA_REGISTRY.map((schema) => ({ ...schema, fields: {} })),
  });
  assert.equal(result.status, "schema_mapping_required");
  assert.equal(Object.hasOwn(result, "query"), false);
});

test("blocks unrecognized AP qualifiers instead of treating any AP text as a reviewed template", () => {
  for (const request of [
    "AP balance excluding intercompany",
    "AP balance in CHF",
    "AP aged balance",
    "AP balance for Example Manufacturing",
    "AP balance in dollars",
    "AP balance at March end",
  ]) {
    const result = compileFinnyFinanceIntent(normalizeFinnyFinanceIntent(request));
    assert.equal(result.status, "schema_mapping_required", request);
    assert.equal(Object.hasOwn(result, "query"), false);
  }
});

test("cannot weaken a reviewed capability's accounting verification", () => {
  const result = compileFinnyFinanceIntent(
    normalizeFinnyFinanceIntent({ request: "AP balance", verification: "repeatable_read" }),
  );
  assert.equal(result.status, "schema_mapping_required");
  assert.equal(Object.hasOwn(result, "query"), false);
});

test("supports artifact output without changing the reviewed accounting query", () => {
  const result = compileFinnyFinanceIntent(
    normalizeFinnyFinanceIntent("Can you show our AP balance as an Excel file?"),
  );
  assert.equal(result.status, "compiled");
  if (result.status !== "compiled") return;
  assert.equal(result.ir.artifact, "required");
  assert.equal(result.query, FINNY_AP_GL_CONTROL_BALANCE_QUERY);
});
