export interface FinnyDecimal {
  coefficient: bigint;
  scale: number;
}

export function parseFinnyDecimal(value: unknown): FinnyDecimal | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  let rendered = String(value).trim();
  let accountingNegative = false;
  if (rendered.startsWith("(") && rendered.endsWith(")")) {
    accountingNegative = true;
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
  if ((sign === "-") !== accountingNegative) coefficient = -coefficient;
  return { coefficient, scale };
}

function aligned(value: FinnyDecimal, scale: number): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

export function addFinnyDecimal(left: FinnyDecimal, right: FinnyDecimal): FinnyDecimal {
  const scale = Math.max(left.scale, right.scale);
  return { coefficient: aligned(left, scale) + aligned(right, scale), scale };
}

export function subtractFinnyDecimal(left: FinnyDecimal, right: FinnyDecimal): FinnyDecimal {
  return addFinnyDecimal(left, { coefficient: -right.coefficient, scale: right.scale });
}

export function compareFinnyDecimal(left: FinnyDecimal, right: FinnyDecimal): number {
  const difference = subtractFinnyDecimal(left, right).coefficient;
  if (difference < 0n) return -1;
  if (difference > 0n) return 1;
  return 0;
}

export function equalFinnyDecimal(left: FinnyDecimal, right: FinnyDecimal): boolean {
  return compareFinnyDecimal(left, right) === 0;
}

export function absoluteFinnyDecimal(value: FinnyDecimal): FinnyDecimal {
  return {
    coefficient: value.coefficient < 0n ? -value.coefficient : value.coefficient,
    scale: value.scale,
  };
}

export function renderFinnyDecimal(value: FinnyDecimal): string {
  const negative = value.coefficient < 0n;
  let digits = (negative ? -value.coefficient : value.coefficient).toString();
  if (value.scale > 0) {
    digits = digits.padStart(value.scale + 1, "0");
    const split = digits.length - value.scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`.replace(/\.?0+$/, "");
  }
  if (digits === "") digits = "0";
  return negative && digits !== "0" ? `-${digits}` : digits;
}
