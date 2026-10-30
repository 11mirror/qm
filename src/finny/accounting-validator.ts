export type FinnyVerificationPolicy =
  "repeatable_read" | "single_numeric_total" | "balanced_debits_credits" | "balance_sheet_equation";

export interface FinnyAccountingValidation {
  policy: FinnyVerificationPolicy;
  passed: boolean;
  checks: readonly { name: string; passed: boolean }[];
}

const numericTotalFields = new Set([
  "amount",
  "balance",
  "expense",
  "grossamount",
  "netamount",
  "outstanding",
  "revenue",
  "total",
  "value",
  "variance",
]);

export function selectFinnyVerificationPolicy(request: string): FinnyVerificationPolicy {
  const normalized = request.toLowerCase();
  if (/\bbalance[ -]?sheet\b/.test(normalized)) return "balance_sheet_equation";
  if (/\btrial[ -]?balance\b|\bdebits?\b.*\bcredits?\b|\bcredits?\b.*\bdebits?\b/.test(normalized)) {
    return "balanced_debits_credits";
  }
  if (
    /\b(ap|ar)\b|\baccounts? payable\b|\baccounts? receivable\b|\b(balance|total|amount|variance|revenue|expense)\b/.test(
      normalized,
    )
  ) {
    return "single_numeric_total";
  }
  return "repeatable_read";
}

export function validateFinnyAccounting(
  records: readonly unknown[],
  policy: FinnyVerificationPolicy,
): FinnyAccountingValidation {
  switch (policy) {
    case "repeatable_read":
      return result(policy, "repeatable_read", true);
    case "single_numeric_total":
      return validateSingleNumericTotal(records, policy);
    case "balanced_debits_credits":
      return validateEquation(records, policy, ["debit"], ["credit"], "debits_equal_credits");
    case "balance_sheet_equation":
      return validateBalanceSheet(records, policy);
  }
}

function validateSingleNumericTotal(
  records: readonly unknown[],
  policy: FinnyVerificationPolicy,
): FinnyAccountingValidation {
  let found = false;
  let valid = records.length > 0;
  for (const record of records) {
    if (!isRecord(record)) {
      valid = false;
      continue;
    }
    for (const [key, value] of Object.entries(record)) {
      if (!numericTotalFields.has(normalizeField(key))) continue;
      found = true;
      if (!parseDecimal(value)) valid = false;
    }
  }
  return result(policy, "finite_numeric_total", found && valid);
}

function validateBalanceSheet(records: readonly unknown[], policy: FinnyVerificationPolicy): FinnyAccountingValidation {
  const assets = sumFields(records, ["asset", "assets"]);
  const liabilities = sumFields(records, ["liability", "liabilities"]);
  const equity = sumFields(records, ["equity"]);
  const passed =
    assets.valid &&
    liabilities.valid &&
    equity.valid &&
    assets.found &&
    liabilities.found &&
    equity.found &&
    decimalEqual(assets.total, addDecimal(liabilities.total, equity.total));
  return result(policy, "assets_equal_liabilities_plus_equity", passed);
}

function validateEquation(
  records: readonly unknown[],
  policy: FinnyVerificationPolicy,
  leftFields: readonly string[],
  rightFields: readonly string[],
  name: string,
): FinnyAccountingValidation {
  const left = sumFields(records, leftFields);
  const right = sumFields(records, rightFields);
  return result(
    policy,
    name,
    left.valid && right.valid && left.found && right.found && decimalEqual(left.total, right.total),
  );
}

interface Decimal {
  coefficient: bigint;
  scale: number;
}

function sumFields(
  records: readonly unknown[],
  fieldNames: readonly string[],
): { total: Decimal; found: boolean; valid: boolean } {
  const fields = new Set(fieldNames);
  let total: Decimal = { coefficient: 0n, scale: 0 };
  let found = false;
  let valid = records.length > 0;
  for (const record of records) {
    if (!isRecord(record)) {
      valid = false;
      continue;
    }
    for (const [key, value] of Object.entries(record)) {
      if (!fields.has(normalizeField(key))) continue;
      found = true;
      const decimal = value === null || value === "" ? { coefficient: 0n, scale: 0 } : parseDecimal(value);
      if (!decimal) {
        valid = false;
        continue;
      }
      total = addDecimal(total, decimal);
    }
  }
  return { total, found, valid };
}

function parseDecimal(value: unknown): Decimal | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  let rendered = String(value).trim();
  let negativeParentheses = false;
  if (rendered.startsWith("(") && rendered.endsWith(")")) {
    negativeParentheses = true;
    rendered = rendered.slice(1, -1).trim();
  }
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(rendered)) rendered = rendered.replaceAll(",", "");
  const match = rendered.match(/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return undefined;
  const [, sign, whole, fraction = "", exponentText = "0"] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) return undefined;
  let coefficient = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  const negativeSign = sign === "-";
  if (negativeSign !== negativeParentheses) coefficient = -coefficient;
  return { coefficient, scale };
}

function addDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) + right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function decimalEqual(left: Decimal, right: Decimal): boolean {
  const aligned = addDecimal(left, { coefficient: -right.coefficient, scale: right.scale });
  return aligned.coefficient === 0n;
}

function normalizeField(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function result(policy: FinnyVerificationPolicy, name: string, passed: boolean): FinnyAccountingValidation {
  return { policy, passed, checks: [{ name, passed }] };
}
