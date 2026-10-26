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
    migrationId: "surface-cache/ack-emoji-pick/0001",
    migrations: [
      `CREATE TABLE IF NOT EXISTS ack_emoji_picks(
        id BIGSERIAL PRIMARY KEY,
        org_id TEXT NOT NULL, surface TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL,
        outcome TEXT NOT NULL, picked TEXT, icon TEXT, message TEXT, candidates TEXT, model TEXT,
        latency_ms INT, created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ack_emoji_picks_org_channel_created
        ON ack_emoji_picks(org_id, channel, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS ack_emoji_picks_org_created
        ON ack_emoji_picks(org_id, created_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS ack_emoji_picks_org_outcome
        ON ack_emoji_picks(org_id, outcome)`,
    ],
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
