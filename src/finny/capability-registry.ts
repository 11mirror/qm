import type { FinnyFinanceIR } from "./finance-ir.ts";
import { FINNY_AP_GL_CONTROL_BALANCE_QUERY } from "./reviewed-query.ts";

export interface FinnySchemaAuthority {
  id: string;
  status: "reviewed" | "unreviewed";
  basis: "reviewed_template";
  fields: Readonly<Record<string, string>>;
}

export interface FinnyReviewedCapability {
  id: string;
  status: "reviewed";
  measure: FinnyFinanceIR["measure"];
  temporalShape: FinnyFinanceIR["temporalShape"];
  entity: FinnyFinanceIR["entity"]["kind"];
  period: FinnyFinanceIR["period"]["kind"];
  currency: FinnyFinanceIR["currency"]["kind"];
  grain: FinnyFinanceIR["grain"];
  sources: FinnyFinanceIR["sources"];
  migrationMarkers: readonly string[];
  verification: FinnyFinanceIR["verification"];
  schemaAuthorityId: string;
  requiredFields: Readonly<Record<string, string>>;
  query: string;
}

const apFields = Object.freeze({
  table: "TransactionAccountingLine",
  credit: "credit",
  debit: "debit",
  accountType: "accounttype",
  accountingBook: "accountingbook",
});

export const FINNY_REVIEWED_SCHEMA_REGISTRY: readonly FinnySchemaAuthority[] = Object.freeze([
  Object.freeze({
    id: "netsuite.ap_gl_control_balance.v1",
    status: "reviewed",
    basis: "reviewed_template",
    fields: apFields,
  }),
]);

export const FINNY_REVIEWED_CAPABILITY_REGISTRY: readonly FinnyReviewedCapability[] = Object.freeze([
  Object.freeze({
    id: "ap_gl_control_balance.v1",
    status: "reviewed",
    measure: "ap_gl_control_balance",
    temporalShape: "stock",
    entity: "all",
    period: "current",
    currency: "source_base",
    grain: "total",
    sources: Object.freeze(["netsuite"] as const),
    migrationMarkers: Object.freeze([]),
    verification: "single_numeric_total",
    schemaAuthorityId: "netsuite.ap_gl_control_balance.v1",
    requiredFields: apFields,
    query: FINNY_AP_GL_CONTROL_BALANCE_QUERY,
  }),
]);

export function isReviewedFinnyQuery(query: string): boolean {
  return FINNY_REVIEWED_CAPABILITY_REGISTRY.some((capability) => capability.query === query);
}

export type FinnyFinanceCompilation =
  | {
      status: "compiled";
      capabilityId: string;
      schemaAuthorityId: string;
      ir: FinnyFinanceIR;
      query: string;
    }
  | { status: "unsupported_template"; ir: FinnyFinanceIR; reason: string }
  | { status: "schema_mapping_required"; ir: FinnyFinanceIR; capabilityId: string; missingMappings: readonly string[] };

export function compileFinnyFinanceIntent(
  ir: FinnyFinanceIR,
  options: {
    schemas?: readonly FinnySchemaAuthority[];
    capabilities?: readonly FinnyReviewedCapability[];
  } = {},
): FinnyFinanceCompilation {
  const capabilities = (options.capabilities ?? FINNY_REVIEWED_CAPABILITY_REGISTRY).filter(
    (entry) => entry.status === "reviewed" && entry.measure === ir.measure,
  );
  if (!capabilities.length)
    return { status: "unsupported_template", ir, reason: "No reviewed capability supports this measure" };
  const capability = capabilities.find((entry) => missingDimensions(ir, entry).length === 0) ?? capabilities[0]!;
  const missingMappings = missingDimensions(ir, capability);
  const schema = (options.schemas ?? FINNY_REVIEWED_SCHEMA_REGISTRY).find(
    (entry) => entry.id === capability.schemaAuthorityId && entry.status === "reviewed",
  );
  if (!schema) missingMappings.push("schema_authority");
  else {
    for (const [field, mapping] of Object.entries(capability.requiredFields)) {
      if (schema.fields[field] !== mapping) missingMappings.push(`schema.${field}`);
    }
  }
  if (missingMappings.length)
    return { status: "schema_mapping_required", ir, capabilityId: capability.id, missingMappings };
  return {
    status: "compiled",
    capabilityId: capability.id,
    schemaAuthorityId: capability.schemaAuthorityId,
    ir,
    query: capability.query,
  };
}

function missingDimensions(ir: FinnyFinanceIR, capability: FinnyReviewedCapability): string[] {
  const missing: string[] = [];
  if (ir.version !== 1) missing.push("ir_version");
  if (ir.unresolvedConstraints?.length) missing.push("unresolved_constraints");
  if (ir.temporalShape !== capability.temporalShape) missing.push("temporal_shape");
  if (ir.entity.kind !== capability.entity || ir.entity.kind === "named") missing.push("entity");
  if (ir.period.kind !== capability.period || ir.period.kind !== "current") missing.push("period");
  if (ir.currency.kind !== capability.currency || ir.currency.kind !== "source_base") missing.push("currency");
  if (ir.grain !== capability.grain) missing.push("grain");
  if (
    ir.sources.length !== capability.sources.length ||
    ir.sources.some((source) => !capability.sources.includes(source))
  )
    missing.push("sources");
  if (
    ir.migrationMarkers.length !== capability.migrationMarkers.length ||
    ir.migrationMarkers.some((marker) => !capability.migrationMarkers.includes(marker))
  )
    missing.push("migration_markers");
  if (ir.verification !== capability.verification) missing.push("verification");
  return missing;
}
