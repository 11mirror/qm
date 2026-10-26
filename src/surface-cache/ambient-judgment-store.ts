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
