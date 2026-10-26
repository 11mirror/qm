import { html, nothing, type TemplateResult } from "lit";
import { FileImage, Paperclip, X } from "lucide";
import { type DeliveredFile, fileContentUrl } from "./core-bridge";
import { browserRenderableImage, chipBadge, formatBytes } from "./ui";
import { icon } from "./icons";
import { base64ToBytes } from "./paste-text";
import { tip } from "./tooltip";

export interface UserAttachmentView {
  fileName: string;
  mimeType?: string;
  size?: number;
  content?: string;
  artifactId?: string;
}

export function createChatAttachments({
  chatState,
  redrawTranscript,
}: {
  chatState: { readonly sessionId: string | null };
  redrawTranscript: () => void;
}) {
  function inlineHtmlName(name?: string, mimeType?: string): boolean {
    if (mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "text/html") return true;
    return /\.html?$/i.test(name ?? "");
  }

  const dismissedHtmlPreviews = new Set<string>();

  function inlineHtmlFrame(name: string, src: string, size?: number, href?: string): TemplateResult {
    const key = `${chatState.sessionId ?? "new"}:${href ?? src}:${name}`;
    const chip = chipBadge(Paperclip, name, size, href, false);
    if (dismissedHtmlPreviews.has(key)) return chip;
    return html`<span class="file-html-unfurl"
      ><span class="file-html-header"
        ><span dir="auto">${name}</span
        ><button
          type="button"
          aria-label="Dismiss ${name} preview"
          title="Dismiss preview"
          @click=${() => {
            dismissedHtmlPreviews.add(key);
            redrawTranscript();
          }}
        >
          ${icon(X, 14)}
        </button></span
      ><iframe sandbox="allow-scripts" src=${src} title=${name} loading="lazy"></iframe>${chip}</span
    >`;
  }

  const localAttachmentUrls = new Map<UserAttachmentView, string>();

  function localContentUrl(a: UserAttachmentView): string | undefined {
    if (!a.content) return undefined;
    const cached = localAttachmentUrls.get(a);
    if (cached) return cached;
    try {
      const b64 = a.content.startsWith("data:") ? (a.content.split(",")[1] ?? "") : a.content;
      const bytes = base64ToBytes(b64);
      const blob = new Blob([bytes as BlobPart], { type: a.mimeType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      localAttachmentUrls.set(a, url);
      return url;
    } catch {
      return undefined;
    }
  }

  let attachmentPeek: HTMLElement | null = null;

  function unpeekAttachment(): void {
    attachmentPeek?.remove();
    attachmentPeek = null;
    document.removeEventListener("scroll", unpeekAttachment, true);
  }

  function peekAttachment(e: Event): void {
    const link = e.currentTarget as HTMLElement | null;
    const img = link?.querySelector("img");
    if (!link || !img || getComputedStyle(link).getPropertyValue("--attachment-compact").trim() !== "1") return;
    unpeekAttachment();
    const bounds = (link.closest(".split-pane-content") ?? document.documentElement).getBoundingClientRect();
    const anchor = link.getBoundingClientRect();
    const pad = 12;
    const chrome = 12;
    const maxW = Math.max(80, Math.min(360, bounds.width - pad * 2 - chrome));
    const maxH = Math.max(60, Math.min(320, bounds.height - anchor.height - pad * 3 - chrome));
    const natural = { w: img.naturalWidth || maxW, h: img.naturalHeight || maxH };
    const scale = Math.min(maxW / natural.w, maxH / natural.h, 1);
    const w = Math.round(natural.w * scale);
    const h = Math.round(natural.h * scale);
    const copy = Object.assign(document.createElement("img"), { src: img.currentSrc || img.src, alt: "" });
    Object.assign(copy.style, { width: `${w}px`, height: `${h}px` });
    const peek = Object.assign(document.createElement("div"), { className: "attachment-peek" });
    peek.setAttribute("aria-hidden", "true");
    peek.append(copy);
    const below = anchor.bottom + 8;
    const top =
      below + h + chrome <= bounds.bottom - pad ? below : Math.max(bounds.top + pad, anchor.top - 8 - h - chrome);
    const left = Math.max(bounds.left + pad, Math.min(anchor.right - w - chrome, bounds.right - pad - w - chrome));
    Object.assign(peek.style, { top: `${top}px`, left: `${left}px` });
    document.body.append(peek);
    attachmentPeek = peek;
    document.addEventListener("scroll", unpeekAttachment, true);
  }

  function userAttachmentBadge(a: UserAttachmentView): TemplateResult {
    const artifactHref = a.artifactId ? fileContentUrl(a.artifactId, a.fileName) : undefined;
    if (a.mimeType?.startsWith("image/")) {
      const dataUrl =
        a.content && (a.content.startsWith("data:") ? a.content : `data:${a.mimeType};base64,${a.content}`);
      const href = artifactHref ?? localContentUrl(a) ?? dataUrl;
      if (href && browserRenderableImage(a.mimeType)) {
        return html`<a
          class="file-image"
          href=${href}
          target="_blank"
          rel="noreferrer"
          ${tip(a.fileName)}
          @mouseenter=${peekAttachment}
          @mouseleave=${unpeekAttachment}
          @focus=${peekAttachment}
          @blur=${unpeekAttachment}
          ><img src=${href} alt=${a.fileName} loading="lazy" /><span class="file-image-name" dir="auto"
            >${a.fileName}</span
          >${typeof a.size === "number" ? html`<small class="file-image-size">${formatBytes(a.size)}</small>` : nothing}</a
        >`;
      }
      return chipBadge(FileImage, a.fileName, a.size, href || undefined, true);
    }
    if (inlineHtmlName(a.fileName, a.mimeType)) {
      let src = artifactHref;
      if (!src && a.content) {
        src = a.content.startsWith("data:") ? a.content : `data:text/html;base64,${a.content}`;
      }
      if (src) return inlineHtmlFrame(a.fileName, src, a.size, artifactHref);
    }
    return chipBadge(Paperclip, a.fileName, a.size, artifactHref ?? localContentUrl(a), false, a.mimeType);
  }

  function deliveredFileBadge(file: DeliveredFile): TemplateResult {
    if (!file.artifactId) return chipBadge(Paperclip, file.name, file.sizeBytes, undefined, false);
    const href = fileContentUrl(file.artifactId, file.name);
    if (file.mimetype?.startsWith("image/")) {
      if (!browserRenderableImage(file.mimetype)) return chipBadge(FileImage, file.name, file.sizeBytes, href, true);
      return html`<a class="file-image" href=${href} target="_blank" rel="noreferrer" ${tip(file.name)}
        ><img src=${href} alt=${file.name} loading="lazy"
      /></a>`;
    }
    if (inlineHtmlName(file.name, file.mimetype)) return inlineHtmlFrame(file.name, href, file.sizeBytes, href);
    return chipBadge(Paperclip, file.name, file.sizeBytes, href, false, file.mimetype);
  }
  return { userAttachmentBadge, deliveredFileBadge };
}
