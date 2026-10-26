import { createDecisionLogStore, type DecisionLogStore } from "./decision-log-store.ts";

type AmbientDecisionKind = "act" | "ignore" | "fastlane";

type AmbientJudgment = {
  id?: number;
  orgId?: string;
  surface: string;
  container: string;
  decision: AmbientDecisionKind;
  reason?: string;
  askedBy?: string;
  prompt?: string;
  model?: string;
  latencyMs?: number;
  tsFrom?: string;
  tsTo?: string;
  createdAt: number;
};

type AmbientJudgmentSummary = Omit<AmbientJudgment, "prompt">;

export type AmbientJudgmentStore = DecisionLogStore<AmbientJudgment, AmbientDecisionKind, AmbientJudgmentSummary>;

export function createPostgresAmbientJudgmentStore(connectionString: string): AmbientJudgmentStore {
  return createDecisionLogStore<AmbientJudgment, AmbientDecisionKind, AmbientJudgmentSummary>(connectionString, {
    table: "ambient_judgments",
    migrationId: "surface-cache/ambient-judgment/0001",
    migrations: [
      `CREATE TABLE IF NOT EXISTS ambient_judgments(
        id BIGSERIAL PRIMARY KEY,
        org_id TEXT NOT NULL, surface TEXT NOT NULL, container TEXT NOT NULL,
        decision TEXT NOT NULL, reason TEXT, asked_by TEXT, prompt TEXT, model TEXT,
        latency_ms INT, ts_from TEXT, ts_to TEXT, created_at BIGINT NOT NULL
      )`,
      `ALTER TABLE ambient_judgments ADD COLUMN IF NOT EXISTS asked_by TEXT`,
      `CREATE INDEX IF NOT EXISTS ambient_judgments_org_container_created
        ON ambient_judgments(org_id, container, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS ambient_judgments_org_created
        ON ambient_judgments(org_id, created_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS ambient_judgments_org_decision
        ON ambient_judgments(org_id, decision)`,
    ],
    scopeColumn: "container",
    outcomeColumn: "decision",
    outcomes: ["act", "ignore", "fastlane"],
    columns: [
      ["surface", "surface", "text", true],
      ["container", "container", "text", true],
      ["decision", "decision", "text", true],
      ["reason", "reason", "text"],
      ["asked_by", "askedBy", "text"],
      ["prompt", "prompt", "text"],
      ["model", "model", "text"],
      ["latency_ms", "latencyMs", "int"],
      ["ts_from", "tsFrom", "text"],
      ["ts_to", "tsTo", "text"],
    ],
    omitFromList: ["prompt"],
  });
}
