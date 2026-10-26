import { marked } from "marked";
import { escapeHtml } from "./html-escape.ts";
import DOMPurify, { type Config } from "dompurify";

export const MARKDOWN_SANITIZE_CONFIG: Config = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: ["annotation", "semantics", "code-block"],
  ADD_ATTR: ["target", "encoding", "language", "code"],
};

export const SHARED_MARKDOWN_SANITIZE_CONFIG: Config = {
  ...MARKDOWN_SANITIZE_CONFIG,
  FORBID_TAGS: ["img", "video", "audio", "source", "iframe", "object", "embed", "style", "form"],
  FORBID_ATTR: ["href", "xlink:href", "src", "srcset", "poster", "style", "action"],
};

export function sandboxFileHref(href: string): string {
  const encoded = /^sandbox:\/.*\/workspace\/.*?([^/]+)$/i.exec(href)?.[1];
  if (!encoded) return href;
  try {
    return `/api/files/by-name/content?name=${encodeURIComponent(decodeURIComponent(encoded))}`;
  } catch {
    return href;
  }
}

let installed = false;

export function installMarkdownSanitizer(options: { shared?: boolean } = {}): void {
  if (installed) return;
  installed = true;
  marked.use({
    walkTokens(token) {
      if (token.type === "html") token.text = escapeHtml(token.text);
      if (token.type === "link") token.href = sandboxFileHref(token.href);
    },
    hooks: {
      postprocess: (html: string) =>
        String(DOMPurify.sanitize(html, options.shared ? SHARED_MARKDOWN_SANITIZE_CONFIG : MARKDOWN_SANITIZE_CONFIG)),
    },
  });
}
