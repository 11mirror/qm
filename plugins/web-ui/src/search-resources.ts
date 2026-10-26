import { html, nothing, type TemplateResult } from "lit";
import { deepLinkPath } from "./deep-link.ts";
import { VIEW_TITLES } from "./document-title.ts";
import type { View } from "./shell-state.ts";

export interface ResourceHit {
  title: string;
  description: string;
  group: string;
  href: string;
}
export interface ResourceSearchResponse {
  hits: Array<{
    id: string;
    kind: "skills" | "crons" | "deploys" | "webhooks" | "contexts";
    title: string;
    snippet: string;
  }>;
  failed: string[];
  limited?: string[];
}

export function resourceResults(
  result: ResourceSearchResponse,
  base: string,
): { hits: ResourceHit[]; failed: string[] } {
  return {
    hits: result.hits.map((hit) => ({
      title: hit.title,
      description: hit.snippet,
      group: VIEW_TITLES[hit.kind],
      href: deepLinkPath(base, hit.kind, null, ...(hit.kind === "contexts" ? [hit.id, null] : [null, hit.id])),
    })),
    failed: result.failed.map((kind) => VIEW_TITLES[kind as View] ?? kind),
  };
}

export function matchResources(hits: ResourceHit[], query: string): ResourceHit[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return hits.filter((h) => {
    const text = `${h.title} ${h.description} ${h.group}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function searchGroup(title: string, archived: boolean, recency: string): TemplateResult {
  return html`<div class="chat-search-group ${archived ? "archived" : ""}">
    <b dir="auto">${title}</b>${archived ? html`<em class="chat-search-archived-tag">Archived</em>` : nothing}<span
      >${recency}</span
    >
  </div>`;
}
