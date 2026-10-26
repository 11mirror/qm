import { escapeHtml } from "./html-escape.ts";
import { swallow } from "../../chassis/src/errors.ts";

type HighlightResult = { value: string };
type Hljs = {
  registerLanguage: (name: string, lang: unknown) => void;
  getLanguage: (name: string) => unknown;
  highlight: (code: string, opts: { language: string }) => HighlightResult;
  highlightAuto: (code: string) => HighlightResult;
};

let real: Hljs | null = null;
let loading: Promise<void> | null = null;

const LANGS: Record<string, () => Promise<{ default: unknown }>> = {
  javascript: () => import("hljs-real-javascript"),
  typescript: () => import("hljs-real-typescript"),
  python: () => import("hljs-real-python"),
  xml: () => import("hljs-real-xml"),
  css: () => import("hljs-real-css"),
  json: () => import("hljs-real-json"),
  bash: () => import("hljs-real-bash"),
  sql: () => import("hljs-real-sql"),
  markdown: () => import("hljs-real-markdown"),
};
const LANG_ALIASES: Record<string, string> = { html: "xml" };

function rerenderMountedBlocks(): void {
  if (typeof document === "undefined") return;
  for (const el of document.querySelectorAll("code-block")) {
    (el as { requestUpdate?: () => void }).requestUpdate?.();
  }
}

function ensureLoading(): void {
  const names = Object.keys(LANGS);
  loading ??= Promise.all([import("hljs-real"), ...names.map((name) => LANGS[name]!())])
    .then(([core, ...langs]) => {
      const hljs = core.default as Hljs;
      names.forEach((name, i) => hljs.registerLanguage(name, langs[i]!.default));
      for (const [alias, target] of Object.entries(LANG_ALIASES))
        hljs.registerLanguage(alias, langs[names.indexOf(target)]!.default);
      real = hljs;
      rerenderMountedBlocks();
    })
    .catch((e: unknown) => {
      swallow("web-ui: load highlighter", e);
      loading = null;
    });
}

const facade: Hljs = {
  registerLanguage(): void {},
  getLanguage(name: string): unknown {
    return real ? real.getLanguage(name) : undefined;
  },
  highlight(code: string, opts: { language: string }): HighlightResult {
    if (real) return real.highlight(code, opts);
    ensureLoading();
    return { value: escapeHtml(code) };
  },
  highlightAuto(code: string): HighlightResult {
    if (real) return real.highlightAuto(code);
    ensureLoading();
    return { value: escapeHtml(code) };
  },
};

export default facade;
