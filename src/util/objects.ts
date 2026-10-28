export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  isObj(v) && !Array.isArray(v) ? v : undefined;
