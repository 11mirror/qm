import { escapeHtml } from "./html-escape.ts";
import { swallow } from "../../chassis/src/errors.ts";

type Katex = { renderToString: (text: string, opts?: object) => string };

let real: Katex | null = null;
let loading: Promise<void> | null = null;

function rerenderMountedBlocks(): void {
  if (typeof document === "undefined") return;
  for (const el of document.querySelectorAll("qm-markdown")) {
    (el as { requestUpdate?: () => void }).requestUpdate?.();
  }
}

function ensureLoading(): void {
  loading ??= import("katex-real")
    .then((m: { default: Katex }) => {
      real = m.default;
      rerenderMountedBlocks();
    })
    .catch((e: unknown) => {
      swallow("web-ui: load KaTeX", e);
      loading = null;
    });
}

const facade: Katex = {
  renderToString(text: string, opts?: object): string {
    if (real) return real.renderToString(text, opts);
    ensureLoading();
    return `<span class="math-pending">${escapeHtml(text)}</span>`;
  },
};

export default facade;
