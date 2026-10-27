import { isObj } from "../util/objects.ts";

export interface RerunRecord {
  tool: string;
  input: Record<string, unknown>;
  recorded?: string[];
}

const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export function packRerun(payload: Record<string, unknown>, rerun: RerunRecord): RerunRecord {
  const recorded: string[] = [];
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rerun.input)) {
    if (key in payload && sameValue(payload[key], value)) recorded.push(key);
    else input[key] = value;
  }
  return { tool: rerun.tool, input, ...(recorded.length ? { recorded } : {}) };
}

export function recordedRerun(
  body: Record<string, unknown>,
): { tool: string; input: Record<string, unknown> } | undefined {
  const rerun = body.rerun;
  if (!isObj(rerun) || typeof rerun.tool !== "string" || !isObj(rerun.input) || Array.isArray(rerun.input))
    return undefined;
  const input = { ...rerun.input };
  if (Array.isArray(rerun.recorded))
    for (const key of rerun.recorded) if (typeof key === "string" && key in body) input[key] = body[key];
  return { tool: rerun.tool, input };
}
