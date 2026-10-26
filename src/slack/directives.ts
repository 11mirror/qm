import { codeRegions } from "../util/markdown.ts";

const CODE_PLACEHOLDER = /\u0000CODE(\d+)\u0000/g;

export function extractDirectives<T>(
  reply: string,
  directiveRe: RegExp,
  trailing: RegExp | ((text: string) => string),
  onMatch: (groups: string[]) => T | undefined,
): { text: string; matches: T[] } {
  if (!reply) return { text: reply ?? "", matches: [] };
  const code: string[] = [];
  let masked = "";
  let cursor = 0;
  for (const [start, end] of codeRegions(reply)) {
    masked += `${reply.slice(cursor, start)}\u0000CODE${code.push(reply.slice(start, end)) - 1}\u0000`;
    cursor = end;
  }
  masked += reply.slice(cursor);
  const matches: T[] = [];
  let changed = false;
  let text = masked.replace(directiveRe, (_m: string, ...rest: unknown[]) => {
    changed = true;
    const parsed = onMatch(rest.slice(0, -2) as string[]);
    if (parsed !== undefined) matches.push(parsed);
    return "";
  });
  const stripped = typeof trailing === "function" ? trailing(text) : text.replace(trailing, "");
  if (stripped !== text) {
    changed = true;
    text = stripped;
  }
  if (!changed) return { text: reply, matches };
  text = text
    .replace(CODE_PLACEHOLDER, (_m, i: string) => code[Number(i)] ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, matches };
}
