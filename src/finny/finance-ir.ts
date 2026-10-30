import type { FinnyVerificationPolicy } from "./accounting-validator.ts";

export type FinnyFinanceMeasure = "ap_gl_control_balance" | "open_receivables" | "revenue" | "expense" | "unknown";
export type FinnyFinancePeriod =
  | { kind: "current" }
  | { kind: "as_of"; date: string }
  | { kind: "range"; start: string; end: string }
  | { kind: "unresolved"; text: string };
export type FinnyFinanceEntity = { kind: "all" } | { kind: "named"; name: string };
export type FinnyFinanceCurrency = { kind: "source_base" } | { kind: "specified"; code: string };
export type FinnyFinanceGrain = "total" | "vendor" | "entity" | "monthly" | "transaction";
export type FinnyFinanceSource = "netsuite" | "legacy";

export interface FinnyFinanceIntent {
  request: string;
  measure?: FinnyFinanceMeasure;
  entity?: FinnyFinanceEntity;
  period?: FinnyFinancePeriod;
  currency?: FinnyFinanceCurrency;
  grain?: FinnyFinanceGrain;
  sources?: readonly FinnyFinanceSource[];
  migrationMarkers?: readonly string[];
  artifact?: "required" | "optional";
  verification?: FinnyVerificationPolicy;
}

export interface FinnyFinanceIR {
  version: 1;
  request: string;
  measure: FinnyFinanceMeasure;
  temporalShape: "stock" | "flow" | "unknown";
  entity: FinnyFinanceEntity;
  period: FinnyFinancePeriod;
  currency: FinnyFinanceCurrency;
  grain: FinnyFinanceGrain;
  sources: readonly FinnyFinanceSource[];
  migrationMarkers: readonly string[];
  artifact: "required" | "optional";
  verification: FinnyVerificationPolicy;
  unresolvedConstraints?: readonly string[];
}

export function normalizeFinnyFinanceIntent(input: string | FinnyFinanceIntent): FinnyFinanceIR {
  const intent = typeof input === "string" ? { request: input } : input;
  const request = intent.request.trim();
  const measure = intent.measure ?? measureOf(request);
  const currency = intent.currency ?? currencyOf(request);
  const entity = intent.entity ?? entityOf(request);
  const unresolved =
    measure === "ap_gl_control_balance" && intent.measure === undefined && !isReviewedCurrentApRequest(request)
      ? request
      : "";
  const temporalShapes = {
    ap_gl_control_balance: "stock",
    open_receivables: "stock",
    revenue: "flow",
    expense: "flow",
    unknown: "unknown",
  } as const;
  return {
    version: 1,
    request,
    measure,
    temporalShape: temporalShapes[measure],
    entity: entity.kind === "named" ? { kind: "named", name: entity.name.trim() } : entity,
    period: intent.period ?? periodOf(request),
    currency:
      currency.kind === "specified" ? { kind: "specified", code: currency.code.trim().toUpperCase() } : currency,
    grain: intent.grain ?? grainOf(request),
    sources: [
      ...new Set<FinnyFinanceSource>(
        intent.sources ?? (/\blegacy\b/i.test(request) ? ["netsuite", "legacy"] : ["netsuite"]),
      ),
    ],
    migrationMarkers: [
      ...new Set(
        (intent.migrationMarkers ?? (/\bmigration\b/i.test(request) ? ["migration"] : []))
          .map((marker) => marker.trim())
          .filter(Boolean),
      ),
    ],
    artifact:
      intent.artifact ?? (/\b(?:excel|spreadsheet|csv|xlsx|artifact|file)\b/i.test(request) ? "required" : "optional"),
    verification: intent.verification ?? (measure === "unknown" ? "repeatable_read" : "single_numeric_total"),
    ...(unresolved ? { unresolvedConstraints: [unresolved] } : {}),
  };
}

function measureOf(request: string): FinnyFinanceMeasure {
  if (/\brevenue\b/i.test(request)) return "revenue";
  if (/\bexpenses?\b/i.test(request)) return "expense";
  if (/\b(?:accounts?\s+receivable|receivables?|a\/?r)\b/i.test(request)) return "open_receivables";
  if (/\b(?:accounts?\s+payable|a\/?p)\b/i.test(request) && /\b(?:balance|outstanding|payable)\b/i.test(request))
    return "ap_gl_control_balance";
  if (/\b(?:owe|owed)\b/i.test(request) && /\b(?:suppliers?|vendors?)\b/i.test(request)) return "ap_gl_control_balance";
  return "unknown";
}

function periodOf(request: string): FinnyFinancePeriod {
  const asOf = /\bas\s+(?:of|at)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}-[a-z]{3}-\d{4})\b/i.exec(request);
  const asOfDate = asOf ? normalizedDate(asOf[1]!) : undefined;
  if (asOfDate) return { kind: "as_of", date: asOfDate };
  const range = /\bfrom\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})\b/i.exec(request);
  if (range) return { kind: "range", start: range[1]!, end: range[2]! };
  if (/\bas\s+(?:of|at)\b|\b(?:period|quarter|year|month|yesterday|last|historical)\b|\b\d{4}\b/i.test(request))
    return { kind: "unresolved", text: request };
  return { kind: "current" };
}

const MONTHS = new Map(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map(
    (month, index) => [month, index + 1] as const,
  ),
);

function normalizedDate(value: string): string | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = /^(\d{1,2})-([a-z]{3})-(\d{4})$/i.exec(value);
  if (!named) return undefined;
  const month = MONTHS.get(named[2]!.toLowerCase());
  return month === undefined ? undefined : validDate(Number(named[3]), month, Number(named[1]));
}

function validDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function currencyOf(request: string): FinnyFinanceCurrency {
  const currency =
    /\b(INR|USD|EUR|GBP|JPY|AUD|CAD|SGD)\b/i.exec(request) ?? /\b(?:in|currency)\s+([a-z]{3})\b/i.exec(request);
  return currency ? { kind: "specified", code: currency[1]!.toUpperCase() } : { kind: "source_base" };
}

function entityOf(request: string): FinnyFinanceEntity {
  const entity = /\bfor\s+(.+?)(?=\s+(?:as|in|by|from|at)\b|[?.!,]|$)/i.exec(request);
  return entity ? { kind: "named", name: entity[1]!.trim() } : { kind: "all" };
}

const REVIEWED_CURRENT_AP_REQUESTS = new Set([
  "ap",
  "ap balance",
  "ap gl control balance",
  "accounts payable",
  "accounts payable balance",
  "accounts payable gl control balance",
  "current ap balance",
  "current ap gl control balance",
  "current accounts payable balance",
  "current accounts payable gl control balance",
  "can you show our ap balance",
  "how much do we owe our suppliers",
  "how much do we owe our vendors",
  "how much do we owe suppliers",
  "how much do we owe vendors",
  "how much is owed to our suppliers",
  "how much is owed to our vendors",
  "how much is owed to suppliers",
  "how much is owed to vendors",
  "show me our ap balance",
  "show me our accounts payable balance",
  "show the current accounts payable balance",
  "show our ap balance",
  "show our accounts payable balance",
  "what is our ap balance",
  "what is our accounts payable balance",
  "what is the ap balance",
]);

function isReviewedCurrentApRequest(request: string): boolean {
  const surface = request
    .toLowerCase()
    .replace(/[?.!,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const withoutArtifact = surface.replace(/\s+(?:as|in)\s+(?:an?\s+)?(?:excel|spreadsheet|csv|xlsx)(?:\s+file)?$/, "");
  return REVIEWED_CURRENT_AP_REQUESTS.has(withoutArtifact);
}

function grainOf(request: string): FinnyFinanceGrain {
  if (/\b(?:by\s+vendor|vendor[ -]wise)\b/i.test(request)) return "vendor";
  if (/\b(?:by\s+entity|entity[ -]wise)\b/i.test(request)) return "entity";
  if (/\bmonthly\b/i.test(request)) return "monthly";
  if (/\b(?:transaction|invoice)s?\b/i.test(request)) return "transaction";
  return "total";
}
