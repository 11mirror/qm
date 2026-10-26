import type { InboxItem } from "../../types.ts";
import { gmailAdapter } from "./gmail.ts";
import { slackAdapter } from "./slack.ts";
import type { SourceAdapter } from "./adapter.ts";

function sourceAdapters(): readonly SourceAdapter[] {
  return [gmailAdapter, slackAdapter];
}

export function sourceAdapter(id: unknown): SourceAdapter | undefined {
  return typeof id === "string" ? sourceAdapters().find((adapter) => adapter.id === id) : undefined;
}

export function inboxMetadataKeys(): string[] {
  return [...new Set(sourceAdapters().flatMap((adapter) => adapter.inboxMetadataKeys))];
}

export function adapterForItem(item: Pick<InboxItem, "source">): SourceAdapter | undefined {
  return sourceAdapter(item.source);
}

export type { SourceAdapter } from "./adapter.ts";
