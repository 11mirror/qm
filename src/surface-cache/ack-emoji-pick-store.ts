import { createDecisionLogStore, type DecisionLogStore } from "./decision-log-store.ts";

type AckPickOutcome = "picked" | "declined";

type AckEmojiPick = {
  id?: number;
  orgId?: string;
  surface: string;
  channel: string;
  ts: string;
  outcome: AckPickOutcome;
  picked?: string;
  icon?: string;
  message?: string;
  candidates?: string;
  model?: string;
  latencyMs?: number;
  createdAt: number;
};

type AckEmojiPickSummary = Omit<AckEmojiPick, "candidates">;

export type AckEmojiPickStore = DecisionLogStore<AckEmojiPick, AckPickOutcome, AckEmojiPickSummary>;

export function createPostgresAckEmojiPickStore(connectionString: string): AckEmojiPickStore {
  return createDecisionLogStore<AckEmojiPick, AckPickOutcome, AckEmojiPickSummary>(connectionString, {
    table: "ack_emoji_picks",
    scopeColumn: "channel",
    outcomeColumn: "outcome",
    outcomes: ["picked", "declined"],
    columns: [
      ["surface", "surface", "text", true],
      ["channel", "channel", "text", true],
      ["ts", "ts", "text", true],
      ["outcome", "outcome", "text", true],
      ["picked", "picked", "text"],
      ["icon", "icon", "text"],
      ["message", "message", "text"],
      ["candidates", "candidates", "text"],
      ["model", "model", "text"],
      ["latency_ms", "latencyMs", "int"],
    ],
    omitFromList: ["candidates"],
  });
}
