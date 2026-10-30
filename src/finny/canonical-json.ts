function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function normalize(value: unknown, ancestors: Set<object>, invalid: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(invalid);
    return value;
  }
  if (!Array.isArray(value) && !plainRecord(value)) throw new Error(invalid);
  if (ancestors.has(value)) throw new Error(invalid);
  ancestors.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error(invalid);
    normalized = value.map((nested) => normalize(nested, ancestors, invalid));
  } else {
    normalized = Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          const nested = value[key];
          if (nested === undefined) throw new Error(invalid);
          return [key, normalize(nested, ancestors, invalid)];
        }),
    );
  }
  ancestors.delete(value);
  return normalized;
}

export function canonicalFinnyJson(value: unknown, invalid = "Finny canonical value is invalid"): string {
  return JSON.stringify(normalize(value, new Set(), invalid));
}
