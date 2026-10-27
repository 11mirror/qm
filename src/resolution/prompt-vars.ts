import { readFileSync } from "node:fs";
import { join } from "node:path";

export type PromptVars = Record<string, string | boolean | undefined>;

const TEMPLATE_TOKEN = /\{\{(?:#if (\w+)|(\/if)|(\w+))\}\}/g;

export function loadProtocolFile(name: string): string {
  return readFileSync(join(import.meta.dirname, "protocols", `${name}.md`), "utf8").trim();
}

function unresolved(md: string, at: number): Error {
  return new Error(`applyPromptVars: unresolved template token near "${md.slice(at, at + 40)}"`);
}

export function applyPromptVars(md: string, vars: PromptVars): string {
  const out: string[] = [];
  const open: { shown: boolean; at: number }[] = [];
  const shown = () => open.every((block) => block.shown);
  const emitText = (from: number, to: number) => {
    if (!shown()) return;
    const text = md.slice(from, to);
    const stray = text.indexOf("{{");
    if (stray >= 0) throw unresolved(md, from + stray);
    out.push(text);
  };
  let at = 0;
  for (const token of md.matchAll(TEMPLATE_TOKEN)) {
    emitText(at, token.index);
    const [, condition, close, name] = token;
    if (condition) open.push({ shown: Boolean(vars[condition]), at: token.index });
    else if (close) {
      if (!open.pop()) throw unresolved(md, token.index);
    } else if (shown()) {
      const value = vars[name!];
      if (value === undefined) throw unresolved(md, token.index);
      out.push(String(value));
    }
    at = token.index + token[0].length;
  }
  emitText(at, md.length);
  if (open.length) throw unresolved(md, open.at(-1)!.at);
  return out.join("");
}
