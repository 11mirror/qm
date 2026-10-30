import assert from "node:assert/strict";
import { test } from "node:test";

import type { FinnyCapabilityCatalog, FinnyCapabilityDescriptor } from "../src/finny/capability-pack.ts";
import { resolveFinnyIntent } from "../src/finny/intent-resolver.ts";

function descriptor(
  semanticCapability: string,
  semanticAliases: readonly string[],
  dimensions: FinnyCapabilityDescriptor["dimensions"] = {
    required: ["entity", "period", "currency", "grain", "artifact"],
    supported: {
      entity: ["all", "named"],
      period: ["current", "as_of", "range"],
      currency: ["source_base", "specified"],
      grain: ["total", "vendor", "entity", "monthly", "transaction"],
      sources: ["netsuite", "legacy"],
      migration_markers: ["migration"],
      artifact: ["optional", "required"],
    },
    defaults: {},
  },
): FinnyCapabilityDescriptor {
  return {
    schemaVersion: 1,
    capabilityId: semanticCapability,
    revisionId: `${semanticCapability}.2026-10-30`,
    semanticCapability,
    semanticAliases: [...semanticAliases],
    dimensions,
    operations: [
      {
        id: "source",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT amount FROM reviewed_source",
        parameters: [],
      },
    ],
    resultOperationId: "source",
    parameterBindings: {},
    artifactPolicy: {
      allowedFormats: ["json", "csv"],
      defaultFormat: "json",
      attachment: "when_requested",
    },
    approvalPolicy: { mode: "none", binds: [] },
    verificationPolicy: { requiredOperationIds: ["source"], releaseGate: "delivery_eligible" },
  };
}

function catalog(...capabilities: FinnyCapabilityDescriptor[]): FinnyCapabilityCatalog {
  return {
    manifestDigest: `sha256:${"1".repeat(64)}`,
    catalogDigest: `sha256:${"2".repeat(64)}`,
    capabilities: new Map(capabilities.map((capability) => [capability.semanticCapability, capability])),
    aliases: new Map(
      capabilities.flatMap((capability) =>
        capability.semanticAliases.map((alias) => [alias, capability.semanticCapability] as const),
      ),
    ),
  };
}

test("a synthetic reviewed measure resolves through catalog data without a measure branch", () => {
  const result = resolveFinnyIntent(
    "Please show stock efficiency for MTPL as at 19-Oct-2026 in USD by entity from NetSuite and legacy including migration as a CSV file",
    catalog(descriptor("working_capital_velocity", ["stock_efficiency"])),
  );

  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.equal(result.semanticCapability, "working_capital_velocity");
  assert.deepEqual(result.dimensions, {
    entity: { kind: "named", name: "MTPL" },
    period: { kind: "as_of", date: "2026-10-19" },
    currency: { kind: "specified", code: "USD" },
    grain: "entity",
    sources: ["netsuite", "legacy"],
    migration_markers: ["migration"],
    artifact: "required",
  });
});

test("AP-like and AR-like aliases are resolved by the same catalog-driven path", () => {
  const financeCatalog = catalog(
    descriptor("supplier_exposure", ["accounts_payable", "ap_balance", "owe_suppliers"]),
    descriptor("customer_exposure", ["accounts_receivable", "open_ar"]),
  );

  const payable = resolveFinnyIntent("How much do we owe suppliers?", financeCatalog);
  assert.equal(payable.status, "resolved");
  if (payable.status === "resolved") assert.equal(payable.semanticCapability, "supplier_exposure");

  const receivable = resolveFinnyIntent("Open AR for MTPL as of 2026-10-19", financeCatalog);
  assert.equal(receivable.status, "resolved");
  if (receivable.status === "resolved") {
    assert.equal(receivable.semanticCapability, "customer_exposure");
    assert.deepEqual(receivable.dimensions.entity, { kind: "named", name: "MTPL" });
    assert.deepEqual(receivable.dimensions.period, { kind: "as_of", date: "2026-10-19" });
  }
});

test("no-match and multi-capability requests are typed unsupported results", () => {
  const financeCatalog = catalog(
    descriptor("supplier_exposure", ["ap_balance"]),
    descriptor("customer_exposure", ["open_ar"]),
  );

  assert.deepEqual(resolveFinnyIntent("show cash position", financeCatalog), {
    status: "unsupported_template",
    request: "show cash position",
    reason: "no_capability_match",
    candidates: [],
  });
  assert.deepEqual(resolveFinnyIntent("compare AP balance with open AR", financeCatalog), {
    status: "unsupported_template",
    request: "compare AP balance with open AR",
    reason: "ambiguous_capability_match",
    candidates: ["customer_exposure", "supplier_exposure"],
  });
});

test("malformed dates, conflicting dates, and unreviewed qualifiers fail closed", () => {
  const financeCatalog = catalog(descriptor("customer_exposure", ["open_ar"]));
  const cases = [
    ["Open AR for MTPL as at 31-Feb-2026", "dimensions.period"],
    ["Open AR as of 2026-10-18 as of 2026-10-19", "dimensions.period"],
    ["Open AR excluding intercompany", "qualifiers"],
    ["Open AR for current period", "dimensions.entity"],
    ["Open AR in", "qualifiers"],
    ["Open AR legacy", "qualifiers"],
    ["Open AR migration", "qualifiers"],
  ] as const;

  for (const [request, missing] of cases) {
    const result = resolveFinnyIntent(request, financeCatalog);
    assert.equal(result.status, "schema_mapping_required", request);
    if (result.status === "schema_mapping_required") assert.ok(result.missingMappings.includes(missing), request);
  }
});

test("descriptor declarations reject unsupported kinds and unresolved required dimensions", () => {
  const financeCatalog = catalog(
    descriptor("customer_exposure", ["open_ar"], {
      required: ["entity", "period", "accounting_book"],
      supported: {
        entity: ["named"],
        period: ["current"],
        currency: ["source_base"],
        grain: ["total"],
        sources: ["netsuite"],
        migration_markers: ["migration"],
        artifact: ["optional"],
      },
      defaults: {},
    }),
  );

  const result = resolveFinnyIntent("Open AR for MTPL as at 19-Oct-2026", financeCatalog);
  assert.equal(result.status, "schema_mapping_required");
  if (result.status !== "schema_mapping_required") return;
  assert.equal(result.semanticCapability, "customer_exposure");
  assert.deepEqual(result.missingMappings, ["dimensions.accounting_book", "dimensions.period.as_of"]);
});

test("defaults are rejected instead of being widened to unsupported pack values", () => {
  const financeCatalog = catalog(
    descriptor("customer_exposure", ["open_ar"], {
      required: ["entity", "period", "currency", "grain", "sources", "artifact"],
      supported: {
        entity: ["named"],
        period: ["as_of"],
        currency: ["specified"],
        grain: ["vendor"],
        sources: ["legacy", "archive"],
        migration_markers: ["migration"],
        artifact: ["required"],
      },
      defaults: {},
    }),
  );

  const result = resolveFinnyIntent("Open AR", financeCatalog);
  assert.equal(result.status, "schema_mapping_required");
  if (result.status !== "schema_mapping_required") return;
  assert.deepEqual(result.missingMappings, [
    "dimensions.artifact.optional",
    "dimensions.currency.source_base",
    "dimensions.entity.all",
    "dimensions.grain.total",
    "dimensions.period.current",
    "dimensions.sources",
  ]);
});

test("pack source and migration values require explicit generic qualifiers", () => {
  const financeCatalog = catalog(
    descriptor("customer_exposure", ["open_ar"], {
      required: ["entity", "period", "currency", "grain", "sources", "migration_markers", "artifact"],
      supported: {
        entity: ["all", "named"],
        period: ["current", "as_of"],
        currency: ["source_base", "specified"],
        grain: ["total"],
        sources: ["ledger_alpha", "ledger_beta"],
        migration_markers: ["opening_migration"],
        artifact: ["optional"],
      },
      defaults: {},
    }),
  );

  const result = resolveFinnyIntent(
    "Please show open AR from ledger alpha and ledger beta including opening migration",
    financeCatalog,
  );
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.deepEqual(result.dimensions.sources, ["ledger_alpha", "ledger_beta"]);
  assert.deepEqual(result.dimensions.migration_markers, ["opening_migration"]);
});

test("range periods reject reversed boundaries and preserve valid ISO dates", () => {
  const financeCatalog = catalog(descriptor("cash_movement", ["cash_flow"]));
  const valid = resolveFinnyIntent("Cash flow from 2026-10-01 to 2026-10-19", financeCatalog);
  assert.equal(valid.status, "resolved");
  if (valid.status === "resolved")
    assert.deepEqual(valid.dimensions.period, { kind: "range", start: "2026-10-01", end: "2026-10-19" });

  const reversed = resolveFinnyIntent("Cash flow from 2026-10-19 to 2026-10-01", financeCatalog);
  assert.equal(reversed.status, "schema_mapping_required");
  if (reversed.status === "schema_mapping_required") assert.deepEqual(reversed.missingMappings, ["dimensions.period"]);
});

test("reviewed request framing and source-base currency do not become loose qualifiers", () => {
  const result = resolveFinnyIntent(
    "Please show the open AR in source currency",
    catalog(descriptor("customer_exposure", ["open_ar"])),
  );
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.deepEqual(result.dimensions.currency, { kind: "source_base" });
});

test("an artifact request cannot override a capability that never attaches artifacts", () => {
  const capability = descriptor("customer_exposure", ["open_ar"]);
  const result = resolveFinnyIntent(
    "Open AR as a CSV file",
    catalog({ ...capability, artifactPolicy: { ...capability.artifactPolicy, attachment: "never" } }),
  );
  assert.equal(result.status, "schema_mapping_required");
  if (result.status === "schema_mapping_required") assert.deepEqual(result.missingMappings, ["artifact.attachment"]);
});
