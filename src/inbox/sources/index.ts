import type { InboxItem } from "../../types.ts";
import { gmailAdapter } from "./gmail.ts";
import { slackAdapter } from "./slack.ts";
import type { SourceAdapter } from "./adapter.ts";
import { isObj } from "../../util/objects.ts";

export function sourceAdapters(): readonly SourceAdapter[] {
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

export function conversationKeyOf(item: Pick<InboxItem, "source" | "sourcePayload">): string | undefined {
  const path = adapterForItem(item)?.conversationKeyPath;
  if (!path) return undefined;
  let value: unknown = item.sourcePayload;
  for (const key of path) value = isObj(value) ? value[key] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

export type { SourceAdapter } from "./adapter.ts";
