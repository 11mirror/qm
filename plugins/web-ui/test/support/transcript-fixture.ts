import { activityItems, type WorkActivity } from "../../src/items.ts";
import { itemsToMessages } from "../../src/transcript-messages.ts";

export const kinds = (work: { activity: WorkActivity[] } | undefined) =>
  activityItems(work?.activity ?? []).map((a) => a.kind);

export const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Parameters<
  typeof itemsToMessages
>[1];
