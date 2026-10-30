import BigNumber from "bignumber.js";

export type FinnyDecimal = BigNumber;

export function parseFinnyDecimal(value: unknown): FinnyDecimal | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  let rendered = String(value).trim();
  let accountingNegative = false;
  if (rendered.startsWith("(") && rendered.endsWith(")")) {
    accountingNegative = true;
    rendered = rendered.slice(1, -1).trim();
  }
  const match = rendered.match(/^([+-]?)(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE]([+-]?\d+))?$/);
  if (!match) return undefined;
  const exponent = Number(match[2] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) return undefined;
  const decimal = new BigNumber(rendered.replaceAll(",", ""));
  if (!decimal.isFinite()) return undefined;
  return accountingNegative ? decimal.negated() : decimal;
}

export function addFinnyDecimal(left: FinnyDecimal, right: FinnyDecimal): FinnyDecimal {
  return left.plus(right);
}

export function subtractFinnyDecimal(left: FinnyDecimal, right: FinnyDecimal): FinnyDecimal {
  return left.minus(right);
}

export function compareFinnyDecimal(left: FinnyDecimal, right: FinnyDecimal): number {
  if (left.isLessThan(right)) return -1;
  if (left.isGreaterThan(right)) return 1;
  return 0;
}

export function equalFinnyDecimal(left: FinnyDecimal, right: FinnyDecimal): boolean {
  return left.isEqualTo(right);
}

export function absoluteFinnyDecimal(value: FinnyDecimal): FinnyDecimal {
  return value.absoluteValue();
}

export function renderFinnyDecimal(value: FinnyDecimal): string {
  return value.isZero() ? "0" : value.toFixed();
}
