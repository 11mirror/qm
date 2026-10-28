import { getTokenizer } from "@anthropic-ai/tokenizer";
import { headSlice, tailSlice } from "./text.ts";

let tokenizer: ReturnType<typeof getTokenizer> | undefined;

const CHUNK_CHARS = 4_000;

function chunkTokens(chunk: string): number {
  tokenizer ??= getTokenizer();
  return tokenizer.encode(chunk.normalize("NFKC"), "all").length;
}

export function countTokens(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += CHUNK_CHARS) n += chunkTokens(text.slice(i, i + CHUNK_CHARS));
  return n;
}

export function headWithinTokens(text: string, maxTokens: number): { head: string; tokens: number } {
  let used = 0;
  for (let i = 0; i < text.length; i += CHUNK_CHARS) {
    const chunk = text.slice(i, i + CHUNK_CHARS);
    const n = chunkTokens(chunk);
    if (used + n <= maxTokens) {
      used += n;
      continue;
    }
    let lo = 0;
    let hi = chunk.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (used + chunkTokens(headSlice(chunk, mid)) <= maxTokens) lo = mid;
      else hi = mid - 1;
    }
    const head = headSlice(text, i + lo);
    return { head, tokens: countTokens(head) };
  }
  return { head: text, tokens: used };
}

function cutMiddleToChars(text: string, keepChars: number, notice: (cutChars: number) => string): string {
  if (text.length <= keepChars) return text;
  const head = Math.ceil(keepChars / 2);
  return headSlice(text, head) + notice(text.length - keepChars) + tailSlice(text, keepChars - head);
}

export function fitPartsToTokens(
  parts: readonly string[],
  maxTokens: number,
  notice: (cutChars: number) => string,
): string[] {
  const fitted = (keepChars: number) => parts.map((part) => cutMiddleToChars(part, keepChars, notice));
  const fits = (candidate: string[]) => countTokens(candidate.join("\n")) <= maxTokens;
  if (fits([...parts])) return [...parts];
  let lo = 0;
  let hi = Math.max(0, ...parts.map((part) => part.length));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(fitted(mid))) lo = mid;
    else hi = mid - 1;
  }
  return fitted(lo);
}

export function fitNewestLinesToTokens(
  lines: readonly string[],
  maxTokens: number,
  notice: (cutChars: number) => string,
): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = countTokens(`${lines[i]!}\n`);
    if (used + cost > maxTokens) return kept.length ? kept : fitPartsToTokens([lines[i]!], maxTokens, notice);
    kept.unshift(lines[i]!);
    used += cost;
  }
  return kept;
}

export function linesWithinTokenBudget(
  lines: readonly string[],
  budgetTokens: number,
): { kept: string[]; omitted: number } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const tokens = countTokens(line);
    if (used + tokens > budgetTokens) {
      if (!kept.length) kept.push(`${line.slice(0, Math.floor((line.length * budgetTokens) / tokens))}…`);
      break;
    }
    used += tokens;
    kept.push(line);
  }
  return { kept, omitted: lines.length - kept.length };
}
