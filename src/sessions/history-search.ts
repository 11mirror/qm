import { contextSummary } from "./session-store.ts";
import { isOverheard, itemFields, proseText, type Item } from "./items.ts";
import { matchesSearchTerms, searchAuthor, searchSnippet, searchTerms } from "./item-search.ts";

const HIT_CHARS = 500;

function itemText(item: Item): string {
  const summary = contextSummary(item);
  if (summary) return summary.text;
  const text = proseText(item);
  if (text?.trim()) return text;
  return JSON.stringify(itemFields(item));
}

function itemLabel(entry: Item): string {
  const stamp = `(${new Date(entry.createdAt).toISOString()})`;
  if (isOverheard(entry)) {
    const author = searchAuthor(entry) ?? "someone";
    return `overheard#${entry.seq} ${stamp} ${author} (untrusted, SAID — not established fact):`;
  }
  const author = searchAuthor(entry);
  return `${entry.kind}#${entry.seq} ${stamp}${author ? ` ${author}:` : ":"}`;
}

export function openSessionItem(items: Item[], seq: number): string | null {
  const entry = items.find((e) => e.seq === seq);
  if (!entry) return null;
  return `${itemLabel(entry)} ${itemText(entry).trim()}`;
}

export function searchSessionItems(entries: Item[], query: string, limit = 20): string[] {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const hits: string[] = [];
  for (let i = entries.length - 1; i >= 0 && hits.length < limit; i--) {
    const entry = entries[i]!;
    const text = itemText(entry).trim();
    const author = searchAuthor(entry);
    if (!matchesSearchTerms(`${author ?? ""} ${text}`, terms)) continue;
    hits.push(`${itemLabel(entry)} ${searchSnippet(text, terms, HIT_CHARS)}`);
  }
  return hits;
}
