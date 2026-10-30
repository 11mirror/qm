import assert from "node:assert/strict";
import { test } from "node:test";

import type { FinnyCapabilityCatalog, FinnyCapabilityDescriptor } from "../src/finny/capability-pack.ts";
import { resolveFinnyIntent } from "../src/finny/intent-resolver.ts";

function descriptor(): FinnyCapabilityDescriptor {
  return {
    schemaVersion: 1,
    capabilityId: "working_capital_velocity",
    revisionId: "working_capital_velocity.2026-10-30",
    semanticCapability: "working_capital_velocity",
    semanticAliases: ["stock_efficiency"],
    intent: {
      dimensions: {
        entity: { type: "string" },
        period: { type: "date" },
        currency: { type: "enum", values: ["source_base", "USD"] },
        sources: { type: "string_list", values: ["netsuite", "legacy"] },
        artifact: { type: "enum", values: ["optional", "required"] },
      },
    },
    dimensions: {
      required: ["entity", "period", "currency", "artifact"],
      supported: {
        entity: ["named"],
        period: ["as_of"],
        currency: ["source_base", "specified"],
        sources: ["netsuite", "legacy"],
        artifact: ["optional", "required"],
      },
      defaults: { currency: "source_base", sources: ["netsuite"], artifact: "optional" },
    },
    operations: [
      {
        id: "source",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT amount FROM reviewed_source WHERE entity = :entity AND posted_at <= :period",
        parameters: ["entity", "period"],
      },
      { id: "repeat", primitive: "repeat_pull", dependsOn: ["source"], operationId: "source" },
      {
        id: "reconciliation",
        primitive: "reconcile",
        dependsOn: ["source", "repeat"],
        leftField: "amount",
        rightField: "amount",
        tolerance: "0",
      },
    ],
    resultOperationId: "source",
    parameterBindings: {
      entity: { source: "dimension", path: ["entity"] },
      period: { source: "dimension", path: ["period"] },
    },
    artifactPolicy: { allowedFormats: ["json", "csv"], defaultFormat: "json", attachment: "when_requested" },
    approvalPolicy: {
      mode: "before_source",
      binds: ["capability_revision", "dimensions", "operation_graph"],
    },
    verificationPolicy: {
      requiredOperationIds: ["repeat", "reconciliation"],
      releaseGate: "delivery_eligible",
    },
  };
}

function catalog(capability = descriptor()): FinnyCapabilityCatalog {
  return {
    manifestDigest: `sha256:${"1".repeat(64)}`,
    catalogDigest: `sha256:${"2".repeat(64)}`,
    capabilities: new Map([[capability.semanticCapability, capability]]),
    aliases: new Map(capability.semanticAliases.map((alias) => [alias, capability.semanticCapability])),
  };
}

test("a typed candidate resolves by exact capability identity and applies descriptor defaults", () => {
  const result = resolveFinnyIntent(
    {
      capabilityId: "working_capital_velocity",
      dimensions: { entity: "MTPL", period: "2026-10-19", currency: "USD", artifact: "required" },
      artifactFormat: "csv",
    },
    catalog(),
  );

  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.equal(result.semanticCapability, "working_capital_velocity");
  assert.deepEqual(result.dimensions, {
    artifact: "required",
    currency: "USD",
    entity: "MTPL",
    period: "2026-10-19",
    sources: ["netsuite"],
  });
  assert.equal(result.artifactFormat, "csv");
});

test("aliases and semantic names cannot substitute for the exact capability ID", () => {
  for (const capabilityId of ["stock_efficiency", "working_capital_velocity_alias"]) {
    const result = resolveFinnyIntent({ capabilityId, dimensions: {} }, catalog());
    assert.equal(result.status, "invalid_candidate");
    if (result.status === "invalid_candidate") assert.deepEqual(result.issues, ["capabilityId.unknown"]);
  }
});

test("candidate dimensions reject extra keys, wrong types, invalid dates, and unreviewed values", () => {
  const cases = [
    [{ entity: "MTPL", period: "2026-10-19", extra: "x" }, "dimensions.extra.undeclared"],
    [{ entity: ["MTPL"], period: "2026-10-19" }, "dimensions.entity.type"],
    [{ entity: "MTPL", period: "2026-02-31" }, "dimensions.period.date"],
    [{ entity: "MTPL", period: "2026-10-19", currency: "EUR" }, "dimensions.currency.value"],
    [{ entity: "MTPL", period: "2026-10-19", sources: ["netsuite", "warehouse"] }, "dimensions.sources.value"],
  ] as const;

  for (const [dimensions, issue] of cases) {
    const result = resolveFinnyIntent({ capabilityId: "working_capital_velocity", dimensions }, catalog());
    assert.equal(result.status, "invalid_candidate");
    if (result.status === "invalid_candidate") assert.ok(result.issues.includes(issue), issue);
  }
});

test("candidate shape rejects every model-supplied authority field", () => {
  for (const authority of ["sql", "operations", "policies", "digests", "revisionId"] as const) {
    const result = resolveFinnyIntent(
      {
        capabilityId: "working_capital_velocity",
        dimensions: { entity: "MTPL", period: "2026-10-19" },
        [authority]: authority,
      },
      catalog(),
    );
    assert.equal(result.status, "invalid_candidate");
    if (result.status === "invalid_candidate") assert.deepEqual(result.issues, [`candidate.${authority}.undeclared`]);
  }
});

test("required dimensions and artifact formats fail closed", () => {
  const missing = resolveFinnyIntent(
    { capabilityId: "working_capital_velocity", dimensions: { period: "2026-10-19" } },
    catalog(),
  );
  assert.equal(missing.status, "invalid_candidate");
  if (missing.status === "invalid_candidate") assert.deepEqual(missing.issues, ["dimensions.entity.required"]);

  const format = resolveFinnyIntent(
    {
      capabilityId: "working_capital_velocity",
      dimensions: { entity: "MTPL", period: "2026-10-19" },
      artifactFormat: "pdf" as "csv",
    },
    catalog(),
  );
  assert.equal(format.status, "invalid_candidate");
  if (format.status === "invalid_candidate") assert.deepEqual(format.issues, ["artifactFormat.invalid"]);
});

test("model-derived candidates require a before-source approval descriptor", () => {
  const capability = descriptor();
  const result = resolveFinnyIntent(
    { capabilityId: capability.capabilityId, dimensions: { entity: "MTPL", period: "2026-10-19" } },
    catalog({ ...capability, approvalPolicy: { mode: "none", binds: [] } }),
  );

  assert.equal(result.status, "invalid_candidate");
  if (result.status === "invalid_candidate") assert.deepEqual(result.issues, ["capability.approval_policy"]);
});
