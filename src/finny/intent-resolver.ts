import type { FinnyCapabilityCatalog, FinnyCapabilityDescriptor } from "./capability-pack.ts";

export type FinnyResolvedEntity = { kind: "all" } | { kind: "named"; name: string };
export type FinnyResolvedPeriod =
  { kind: "current" } | { kind: "as_of"; date: string } | { kind: "range"; start: string; end: string };
export type FinnyResolvedCurrency = { kind: "source_base" } | { kind: "specified"; code: string };
export type FinnyResolvedGrain = "total" | "vendor" | "entity" | "monthly" | "transaction";

export interface FinnyResolvedDimensions {
  entity: FinnyResolvedEntity;
  period: FinnyResolvedPeriod;
  currency: FinnyResolvedCurrency;
  grain: FinnyResolvedGrain;
  sources: readonly string[];
  migration_markers: readonly string[];
  artifact: "required" | "optional";
}

export type FinnyIntentResolution =
  | {
      status: "resolved";
      request: string;
      semanticCapability: string;
      capability: FinnyCapabilityDescriptor;
      dimensions: FinnyResolvedDimensions;
    }
  | {
      status: "unsupported_template";
      request: string;
      reason: "no_capability_match" | "ambiguous_capability_match";
      candidates: readonly string[];
    }
  | {
      status: "schema_mapping_required";
      request: string;
      semanticCapability: string;
      capabilityId: string;
      dimensions: FinnyResolvedDimensions;
      missingMappings: readonly string[];
    };

type Span = readonly [start: number, end: number];

interface ParsedDimensions {
  dimensions: FinnyResolvedDimensions;
  missingMappings: string[];
  artifactFormat?: FinnyCapabilityDescriptor["artifactPolicy"]["allowedFormats"][number];
}

const DATE_SOURCE = "(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}-[a-z]{3}-\\d{4})";
const MONTHS = new Map(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map(
    (month, index) => [month, index + 1] as const,
  ),
);
const DIMENSION_IDS = new Set(["entity", "period", "currency", "grain", "sources", "migration_markers", "artifact"]);
const REQUEST_FRAME =
  /^(?:(?:please\s+)?(?:show(?:\s+me)?|give\s+me|tell\s+me|provide|report|get|find|calculate|compute)(?:\s+(?:our|the))?|(?:what(?:\s+s|\s+is|\s+are)?|how\s+much(?:\s+(?:is|are|do\s+we))?)(?:\s+(?:our|the))?|(?:can|could|would)\s+you(?:\s+(?:show(?:\s+me)?|give\s+me|tell\s+me|provide)(?:\s+(?:our|the))?)?)$/;
const CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseBody(value: string): string {
  const phrase = value.toLowerCase().split("_").filter(Boolean);
  return phrase.length === 1 && /^[a-z]{2}$/.test(phrase[0]!)
    ? [...phrase[0]!].map(escaped).join("[\\s/.-]*")
    : phrase.map(escaped).join("[\\s/_-]+");
}

function phrasePattern(value: string): RegExp {
  const body = phraseBody(value);
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, "gi");
}

function spansOf(pattern: RegExp, value: string): Span[] {
  return [...value.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length] as const);
}

function overlaps(left: Span, right: Span): boolean {
  return left[0] < right[1] && right[0] < left[1];
}

function uniqueSpans(spans: readonly Span[]): Span[] {
  return [...new Map(spans.map((span) => [`${span[0]}:${span[1]}`, span])).values()];
}

function entityFrom(request: string): { entity: FinnyResolvedEntity; spans: Span[]; missingMappings: string[] } {
  const pattern = new RegExp(
    `\\bfor\\s+(.+?)(?=\\s+(?:as\\s+(?:of|at)\\b|from\\s+${DATE_SOURCE}\\b|in\\s+[a-z]{3}\\b|by\\s+[a-z]|from\\s+[a-z]|including\\b|as\\s+(?:an?\\s+)?(?:excel|spreadsheet|csv|xlsx|pdf|json|markdown)\\b)|[?!.,;]|$)`,
    "gi",
  );
  const matches = [...request.matchAll(pattern)];
  if (!matches.length) return { entity: { kind: "all" }, spans: [], missingMappings: [] };
  const spans = matches.map((match) => [match.index, match.index + match[0].length] as const);
  if (matches.length !== 1) return { entity: { kind: "all" }, spans, missingMappings: ["dimensions.entity"] };
  const name = matches[0]![1]!.trim();
  if (/^all(?:\s+entities)?$/i.test(name)) return { entity: { kind: "all" }, spans, missingMappings: [] };
  if (!name || /\b(?:and|or|current|period|month|quarter|year|today|yesterday)\b|[,;]/i.test(name))
    return { entity: { kind: "all" }, spans, missingMappings: ["dimensions.entity"] };
  return { entity: { kind: "named", name }, spans, missingMappings: [] };
}

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

function periodFrom(request: string): { period: FinnyResolvedPeriod; spans: Span[]; missingMappings: string[] } {
  const asOfPattern = new RegExp(`\\bas\\s+(?:of|at)\\s+(${DATE_SOURCE})\\b`, "gi");
  const rangePattern = new RegExp(`\\bfrom\\s+(${DATE_SOURCE})\\s+to\\s+(${DATE_SOURCE})\\b`, "gi");
  const asOf = [...request.matchAll(asOfPattern)];
  const ranges = [...request.matchAll(rangePattern)];
  const current = [...request.matchAll(/\bcurrent(?:\s+period)?\b/gi)];
  const spans: Span[] = [
    ...asOf.map((match) => [match.index, match.index + match[0].length] as const),
    ...ranges.map((match) => [match.index, match.index + match[0].length] as const),
    ...current.map((match) => [match.index, match.index + match[0].length] as const),
  ];
  const markers = asOf.length + ranges.length + current.length;
  const danglingMarker = /\bas\s+(?:of|at)\b/i.test(request) && asOf.length === 0;
  const danglingRange = new RegExp(`\\bfrom\\s+${DATE_SOURCE}\\b`, "i").test(request) && ranges.length === 0;
  const dateSpans = spansOf(new RegExp(`\\b${DATE_SOURCE}\\b`, "gi"), request);
  const bareDate = dateSpans.some((dateSpan) => !spans.some((span) => overlaps(dateSpan, span)));
  if (markers > 1 || danglingMarker || danglingRange || bareDate)
    return { period: { kind: "current" }, spans: [...spans, ...dateSpans], missingMappings: ["dimensions.period"] };
  if (asOf.length === 1) {
    const date = normalizedDate(asOf[0]![1]!);
    return date
      ? { period: { kind: "as_of", date }, spans, missingMappings: [] }
      : { period: { kind: "current" }, spans, missingMappings: ["dimensions.period"] };
  }
  if (ranges.length === 1) {
    const start = normalizedDate(ranges[0]![1]!);
    const end = normalizedDate(ranges[0]![2]!);
    return start && end && start <= end
      ? { period: { kind: "range", start, end }, spans, missingMappings: [] }
      : { period: { kind: "current" }, spans, missingMappings: ["dimensions.period"] };
  }
  return { period: { kind: "current" }, spans, missingMappings: [] };
}

function artifactFrom(request: string): {
  artifact: FinnyResolvedDimensions["artifact"];
  format?: ParsedDimensions["artifactFormat"];
  spans: Span[];
  missingMappings: string[];
} {
  const pattern =
    /\b(?:as|in)\s+(?:an?\s+)?(excel|spreadsheet|csv|xlsx|pdf|json|markdown)(?:\s+(?:file|artifact))?\b/gi;
  const matches = [...request.matchAll(pattern)];
  const spans = matches.map((match) => [match.index, match.index + match[0].length] as const);
  const formats = new Set(
    matches
      .map((match) => match[1]!.toLowerCase())
      .filter((format) => format !== "spreadsheet")
      .map((format) => (format === "excel" ? "xlsx" : format)),
  );
  if (formats.size > 1) return { artifact: "required", spans, missingMappings: ["dimensions.artifact"] };
  return {
    artifact: matches.length ? "required" : "optional",
    ...(formats.size ? { format: [...formats][0] as ParsedDimensions["artifactFormat"] } : {}),
    spans,
    missingMappings: [],
  };
}

function currencyFrom(
  request: string,
  ignored: readonly Span[],
): { currency: FinnyResolvedCurrency; spans: Span[]; missingMappings: string[] } {
  const baseMatches = [...request.matchAll(/\b(?:in\s+)?(?:source|base)\s+currency\b/gi)];
  const codeMatches = [...request.matchAll(/\b(?:in|currency(?:\s+is)?)\s+([a-z]{3})\b/gi)].filter((match) => {
    const span = [match.index, match.index + match[0].length] as const;
    return !ignored.some((ignoredSpan) => overlaps(span, ignoredSpan));
  });
  const spans: Span[] = [
    ...baseMatches.map((match) => [match.index, match.index + match[0].length] as const),
    ...codeMatches.map((match) => [match.index, match.index + match[0].length] as const),
  ];
  const codes = new Set(codeMatches.map((match) => match[1]!.toUpperCase()));
  if (
    baseMatches.length > 1 ||
    codes.size > 1 ||
    (baseMatches.length > 0 && codes.size > 0) ||
    [...codes].some((code) => !CURRENCY_CODES.has(code))
  )
    return { currency: { kind: "source_base" }, spans, missingMappings: ["dimensions.currency"] };
  const code = [...codes][0];
  return code
    ? { currency: { kind: "specified", code }, spans, missingMappings: [] }
    : { currency: { kind: "source_base" }, spans, missingMappings: [] };
}

function grainFrom(request: string): { grain: FinnyResolvedGrain; spans: Span[]; missingMappings: string[] } {
  const patterns: readonly [FinnyResolvedGrain, RegExp][] = [
    ["vendor", /\b(?:by\s+vendors?|vendor[ -]wise)\b/gi],
    ["entity", /\b(?:by\s+entit(?:y|ies)|entity[ -]wise)\b/gi],
    ["monthly", /\b(?:by\s+month|monthly)\b/gi],
    ["transaction", /\b(?:(?:by|per)\s+transactions?|(?:invoice|transaction)\s+detail)\b/gi],
  ];
  const matches = patterns.flatMap(([grain, pattern]) => spansOf(pattern, request).map((span) => ({ grain, span })));
  const grains = new Set(matches.map((match) => match.grain));
  if (grains.size > 1)
    return { grain: "total", spans: matches.map((match) => match.span), missingMappings: ["dimensions.grain"] };
  return {
    grain: [...grains][0] ?? "total",
    spans: matches.map((match) => match.span),
    missingMappings: [],
  };
}

function valueMatches(
  request: string,
  values: readonly string[],
  allowed: readonly Span[],
): Array<{ value: string; span: Span }> {
  return values.flatMap((value) =>
    spansOf(phrasePattern(value), request)
      .filter((span) => allowed.some(([start, end]) => start <= span[0] && span[1] <= end))
      .map((span) => ({ value, span })),
  );
}

function qualifiedValues(
  request: string,
  values: readonly string[],
  qualifier: string,
  ignored: readonly Span[],
): { values: string[]; spans: Span[] } {
  if (!values.length) return { values: [], spans: [] };
  const choices = values.map(phraseBody).sort((left, right) => right.length - left.length);
  const value = `(?:${choices.join("|")})`;
  const pattern = new RegExp(`\\b(?:${qualifier})\\s+${value}(?:\\s*(?:,|and)\\s*${value})*(?![a-z0-9])`, "gi");
  const spans = spansOf(pattern, request).filter((span) => !ignored.some((ignoredSpan) => overlaps(span, ignoredSpan)));
  const matches = valueMatches(request, values, spans);
  return {
    values: [...new Set(matches.sort((left, right) => left.span[0] - right.span[0]).map((match) => match.value))],
    spans,
  };
}

function sourceAndMigrationFrom(
  request: string,
  capability: FinnyCapabilityDescriptor,
  ignored: readonly Span[],
): { sources: string[]; migration_markers: string[]; spans: Span[] } {
  const sources = qualifiedValues(
    request,
    capability.dimensions.supported.sources ?? [],
    "from|via|using(?:\\s+sources?)?",
    ignored,
  );
  const migration = qualifiedValues(
    request,
    capability.dimensions.supported.migration_markers ?? [],
    "including|include|with",
    [...ignored, ...sources.spans],
  );
  return {
    sources: sources.values,
    migration_markers: migration.values,
    spans: [...sources.spans, ...migration.spans],
  };
}

function authorityMatches(
  request: string,
  catalog: FinnyCapabilityCatalog,
  ignored: readonly Span[],
): { candidates: string[]; spans: Span[] } {
  const matches: Array<{ semanticCapability: string; span: Span }> = [];
  for (const capability of catalog.capabilities.values()) {
    for (const authority of [capability.semanticCapability, ...capability.semanticAliases]) {
      for (const span of spansOf(phrasePattern(authority), request)) {
        if (!ignored.some((ignoredSpan) => overlaps(span, ignoredSpan)))
          matches.push({ semanticCapability: capability.semanticCapability, span });
      }
    }
  }
  return {
    candidates: [...new Set(matches.map((match) => match.semanticCapability))].sort(),
    spans: uniqueSpans(matches.map((match) => match.span)),
  };
}

function remainingQualifiers(request: string, spans: readonly Span[]): boolean {
  const masked = [...request];
  for (const [start, end] of uniqueSpans(spans)) for (let index = start; index < end; index += 1) masked[index] = " ";
  const remaining = masked
    .join("")
    .toLowerCase()
    .replace(/['’]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return remaining.length > 0 && !REQUEST_FRAME.test(remaining);
}

function parsedDimensions(
  request: string,
  capability: FinnyCapabilityDescriptor,
  authoritySpans: readonly Span[],
  entity: ReturnType<typeof entityFrom>,
): ParsedDimensions {
  const period = periodFrom(request);
  const artifact = artifactFrom(request);
  const currency = currencyFrom(request, artifact.spans);
  const grain = grainFrom(request);
  const fixedSpans = [
    ...authoritySpans,
    ...entity.spans,
    ...period.spans,
    ...artifact.spans,
    ...currency.spans,
    ...grain.spans,
  ];
  const sourceAndMigration = sourceAndMigrationFrom(request, capability, fixedSpans);
  const spans = [...fixedSpans, ...sourceAndMigration.spans];
  const missingMappings = [
    ...entity.missingMappings,
    ...period.missingMappings,
    ...artifact.missingMappings,
    ...currency.missingMappings,
    ...grain.missingMappings,
  ];
  if (remainingQualifiers(request, spans)) missingMappings.push("qualifiers");
  return {
    dimensions: {
      entity: entity.entity,
      period: period.period,
      currency: currency.currency,
      grain: grain.grain,
      sources: sourceAndMigration.sources,
      migration_markers: sourceAndMigration.migration_markers,
      artifact: artifact.artifact,
    },
    missingMappings,
    ...(artifact.format ? { artifactFormat: artifact.format } : {}),
  };
}

function descriptorMappings(capability: FinnyCapabilityDescriptor, parsed: ParsedDimensions): string[] {
  const missing = [...parsed.missingMappings];
  for (const dimension of capability.dimensions.required) {
    if (!DIMENSION_IDS.has(dimension) && !Object.hasOwn(capability.dimensions.defaults, dimension))
      missing.push(`dimensions.${dimension}`);
    else if (!capability.dimensions.supported[dimension]) missing.push(`dimensions.${dimension}`);
    else if (
      dimension === "sources" &&
      parsed.dimensions.sources.length === 0 &&
      !Object.hasOwn(capability.dimensions.defaults, dimension)
    )
      missing.push("dimensions.sources");
    else if (
      dimension === "migration_markers" &&
      parsed.dimensions.migration_markers.length === 0 &&
      !Object.hasOwn(capability.dimensions.defaults, dimension)
    )
      missing.push("dimensions.migration_markers");
  }
  const values: Readonly<Record<string, readonly string[]>> = {
    entity: [parsed.dimensions.entity.kind],
    period: [parsed.dimensions.period.kind],
    currency: [parsed.dimensions.currency.kind],
    grain: [parsed.dimensions.grain],
    sources: parsed.dimensions.sources,
    migration_markers: parsed.dimensions.migration_markers,
    artifact: [parsed.dimensions.artifact],
  };
  for (const [dimension, actualValues] of Object.entries(values)) {
    const supported = capability.dimensions.supported[dimension];
    if (!supported) continue;
    const configured = capability.dimensions.defaults?.[dimension];
    let effectiveValues: readonly string[] = actualValues;
    if (effectiveValues.length === 0 && configured !== undefined)
      effectiveValues = Array.isArray(configured) ? configured : [configured];
    for (const value of effectiveValues)
      if (!supported.includes(value)) missing.push(`dimensions.${dimension}.${value}`);
  }
  if (parsed.artifactFormat && !capability.artifactPolicy.allowedFormats.includes(parsed.artifactFormat))
    missing.push(`artifact.format.${parsed.artifactFormat}`);
  if (parsed.dimensions.artifact === "required" && capability.artifactPolicy.attachment === "never")
    missing.push("artifact.attachment");
  return [...new Set(missing)].sort();
}

export function resolveFinnyIntent(request: string, catalog: FinnyCapabilityCatalog): FinnyIntentResolution {
  const normalizedRequest = request.trim();
  const entity = entityFrom(normalizedRequest);
  const authority = authorityMatches(normalizedRequest, catalog, entity.spans);
  if (authority.candidates.length !== 1)
    return {
      status: "unsupported_template",
      request: normalizedRequest,
      reason: authority.candidates.length ? "ambiguous_capability_match" : "no_capability_match",
      candidates: authority.candidates,
    };
  const semanticCapability = authority.candidates[0]!;
  const capability = catalog.capabilities.get(semanticCapability)!;
  const parsed = parsedDimensions(normalizedRequest, capability, authority.spans, entity);
  const missingMappings = descriptorMappings(capability, parsed);
  if (missingMappings.length)
    return {
      status: "schema_mapping_required",
      request: normalizedRequest,
      semanticCapability,
      capabilityId: capability.capabilityId,
      dimensions: parsed.dimensions,
      missingMappings,
    };
  return {
    status: "resolved",
    request: normalizedRequest,
    semanticCapability,
    capability,
    dimensions: parsed.dimensions,
  };
}
