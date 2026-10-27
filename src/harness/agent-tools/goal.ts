// The goal tool's create/get/update actions and the evidence files the governor reads.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { errMessage } from "../../util/errors.ts";
import {
  applyGovernorVerdict,
  cancelGoal,
  GOAL_STEP_BACK_PROMPT,
  type GoalCreateInput,
  GoalCreateParams,
  goalFloorMeter,
  goalFromParams,
  goalIsOpen,
  type GoalRecord,
  goalReport,
  GovernorUndecided,
  type GovernorVerdict,
  resumeGoal,
} from "../goal.ts";
import { createGrindMeter, grindState } from "../grind.ts";
import { type ToolKit } from "./kit.ts";
import { outsideWorkspace, sandboxSelector, text } from "./shared.ts";

export function goalTools(kit: ToolKit) {
  const { createGoal } = createGoalTool(kit);
  const { getGoal } = getGoalTool(kit);
  const { updateGoal } = updateGoalTool(kit);
  return { createGoal, getGoal, updateGoal };
}

async function goalEvidenceFiles(
  tc: ToolKit["ref"]["current"],
  paths: readonly string[] | undefined,
  signal?: AbortSignal,
  sandboxId?: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths ?? []) {
    const content = tc
      ? await tc.read(path, signal, sandboxId).then(
          (r) => r.content ?? (r.outsideWorkspace ? outsideWorkspace(path) : "[missing: no such file]"),
          (e: unknown) => `[unreadable: ${errMessage(e)}]`,
        )
      : "[missing: no such file]";
    out.push(`<file path="${path.replace(/"/g, "")}">\n${content}\n</file>`);
  }
  return out;
}

/** goal create: registers a goal for sustained work. */
function createGoalTool(kit: ToolKit) {
  const { ref, recordCall, recordCoreAuthoredResult } = kit;
  const createGoal = defineTool({
    name: "create",
    label: "create",
    description:
      'Register a goal only when the user explicitly asks for sustained work ("grind on X for 30 minutes", "keep going until the tests pass"); never infer one. Create it first, before any work, with the floor set to exactly the amount named (20 minutes = minMs 1200000; never subtract time already spent), even if the task looks hard or impossible. ' +
      "The harness then answers any attempt to end a reply with a keep-going prompt while the goal is active or the floor unmet (token_cap or a governor pause also ends it); only the user can cancel it. Fails if an unfinished goal exists.",
    parameters: GoalCreateParams,
    async execute(callId, params) {
      const p = params as GoalCreateInput;
      await recordCall(callId, { tool: "goal", action: "create", objective: p.objective });
      if (goalIsOpen(ref.goal)) {
        return recordCoreAuthoredResult(
          callId,
          { tool: "goal", action: "create", error: "goal_exists" },
          text(
            'A goal is already registered (active or paused) — goal action get shows it. If the user asked to replace it, cancel it first (goal action update "cancel").',
          ),
          true,
        );
      }
      if (p.floor?.minUsd !== undefined && ref.modelHasPrices?.() === false) {
        return recordCoreAuthoredResult(
          callId,
          { tool: "goal", action: "create", error: "spend_unmeasurable" },
          text(
            "The current model has no price data, so a spend floor (minUsd) cannot be measured. Use a time (minMs), token (minTokens) or turn (minTurns) floor instead.",
          ),
          true,
        );
      }
      let record: GoalRecord;
      try {
        record = goalFromParams(p);
      } catch (e) {
        return recordCoreAuthoredResult(
          callId,
          { tool: "goal", action: "create", error: "invalid" },
          text(errMessage(e)),
          true,
        );
      }
      ref.goal = record;
      ref.goalOpenedThisTurn = true;
      await ref.saveGoal?.(record);
      return recordCoreAuthoredResult(
        callId,
        { tool: "goal", action: "create", goal: record },
        text(
          "Goal registered and now enforced: you can no longer end a reply while it is active. " +
            "Complete it with goal action update only when the objective is verifiably met.",
        ),
      );
    },
  });
  return { createGoal };
}

/** goal get: the session's goal, its floor and usage. */
function getGoalTool(kit: ToolKit) {
  const { ref, recordCall, recordCoreAuthoredResult } = kit;
  const getGoal = defineTool({
    name: "get",
    label: "get",
    description: "Read this session's goal: objective, status, floor, cap and usage.",
    parameters: Type.Object({}),
    async execute(callId) {
      await recordCall(callId, { tool: "goal", action: "get" });
      const goal = ref.goal ?? null;
      return recordCoreAuthoredResult(
        callId,
        { tool: "goal", action: "get", goal },
        text(goal ? goalReport(goal, ref.goalMeter ?? createGrindMeter()) : "No goal registered in this session."),
      );
    },
  });
  return { getGoal };
}

/** goal update: complete, resume, cancel or wait, with the governor's check on completion. */
function updateGoalTool(kit: ToolKit) {
  const updateGoal = defineTool({
    name: "update",
    label: "update",
    description:
      "complete: only when the objective is actually achieved, never because budget is low or you are stopping; an independent governor reads the objective, your recent work, note and named files, and may reject (the goal stays active with its reasons) or pause it for the user. " +
      "resume/cancel: only when the person in this turn explicitly asks; never to escape unfinished work.",
    parameters: updateGoalParams(),
    execute: (callId, params) => runUpdateGoal(kit, callId, params),
  });
  return { updateGoal };
}

function updateGoalParams() {
  return Type.Object({
    status: Type.Union([Type.Literal("complete"), Type.Literal("resume"), Type.Literal("cancel")]),
    note: Type.String({
      description: "complete: concrete evidence. resume/cancel: quote the user's request.",
    }),
    files: Type.Optional(
      Type.Array(Type.String(), { description: "Workspace paths of deliverables for the governor to read." }),
    ),
    sandbox_id: sandboxSelector("Sandbox holding `files`; omit for the default."),
  });
}

/** Runs goal update: status changes, and the governor check before a completion lands. */
async function runUpdateGoal(kit: ToolKit, callId: string, params: Static<ReturnType<typeof updateGoalParams>>) {
  const { ref, recordCall, recordCoreAuthoredResult } = kit;
  const p = params as {
    status?: "complete" | "resume" | "cancel";
    note: string;
    files?: string[];
    sandbox_id?: string;
  };
  const status = p.status ?? "complete";
  await recordCall(callId, {
    tool: "goal",
    action: "update",
    status,
    ...(p.note ? { note: p.note } : {}),
  });
  const goal = ref.goal;
  if (status === "cancel") return cancelGoalUpdate(kit, callId, goal, p.note);
  if (status === "resume") return resumeGoalUpdate(kit, callId, goal);
  if (goal?.status !== "active") {
    return recordCoreAuthoredResult(
      callId,
      { tool: "goal", action: "update", error: "no_active_goal" },
      text(
        goal?.status === "paused"
          ? "The goal is paused by the user. Only the user can resume it, by asking to."
          : "No active goal to complete.",
      ),
      true,
    );
  }
  if (goal.floor) {
    const state = grindState(goal.floor, goalFloorMeter(goal, ref.goalMeter ?? createGrindMeter()));
    if (!state.met)
      return recordCoreAuthoredResult(
        callId,
        { tool: "goal", action: "update", error: "floor_unmet", goal },
        text(
          `The work floor is not met yet (${state.text}); the goal stays active and cannot be completed before then. Keep working: verify the result more deeply, harden it, or go further on the objective.`,
        ),
        true,
      );
  }
  const evidence = [p.note ?? "", ...(await goalEvidenceFiles(ref.current, p.files, ref.abortSignal, p.sandbox_id))];
  let verdict: GovernorVerdict;
  try {
    if (!ref.governGoal) throw new GovernorUndecided("no independent governor is available on this runtime");
    verdict = await ref.governGoal({
      objective: goal.objective,
      trigger: "completion",
      recentWork: ref.goalRecentWork?.() ?? "",
      evidence,
      ...(goal.governor ? { previous: goal.governor } : {}),
    });
  } catch (e) {
    return recordCoreAuthoredResult(
      callId,
      { tool: "goal", action: "update", error: "governor_undecided", goal },
      text(
        `The governor could not reach a decision (${errMessage(e)}). This is not a rejection and nothing was recorded against the goal; it stays active. Request completion again with the same evidence.`,
      ),
      true,
    );
  }
  if (verdict.verdict !== "complete") {
    const applied = applyGovernorVerdict(goal, verdict);
    await ref.saveGoal?.(goal);
    let message = `The governor did not accept completion; the goal stays active. Reasons: ${verdict.reasons}`;
    if (applied.verdict === "step_back") message += `\n${GOAL_STEP_BACK_PROMPT}`;
    if (applied.verdict === "pause")
      message = `The governor paused the goal because it needs the user: ${verdict.reasons}\nStop working on it. End your reply with one short message to the user saying where things stand and exactly what you need; their reply resumes the goal.`;
    return recordCoreAuthoredResult(
      callId,
      { tool: "goal", action: "update", error: `governor_${applied.verdict}`, goal },
      text(message),
      applied.verdict !== "pause",
    );
  }
  delete goal.governor;
  goal.status = "complete";
  goal.updatedAt = Date.now();
  goal.completionNote = p.note;
  await ref.saveGoal?.(goal);
  return recordCoreAuthoredResult(
    callId,
    { tool: "goal", action: "update", goal },
    text(`The governor accepted completion; the goal is complete. Report the outcome (and evidence) to the user.`),
  );
}

/** goal update status=cancel: only the user's own message after the goal started may cancel it. */
async function cancelGoalUpdate(kit: ToolKit, callId: string, goal: ToolKit["ref"]["goal"], note: string) {
  const { ref, recordCoreAuthoredResult } = kit;
  if (!goalIsOpen(goal)) {
    return recordCoreAuthoredResult(
      callId,
      { tool: "goal", action: "update", error: "no_open_goal" },
      text("No active or paused goal to cancel."),
      true,
    );
  }
  if (ref.current?.humanTurn !== true || (ref.goalRound ?? 0) > 0 || ref.goalOpenedThisTurn) {
    return recordCoreAuthoredResult(
      callId,
      { tool: "goal", action: "update", error: "human_required" },
      text(
        "Only the user's own message can cancel a goal, and the message you are answering is not one that came after this goal started (it is a keep-going prompt, an automated run, or the goal was started or resumed this turn). The goal is unchanged. If the user asked to cancel, tell them to use the cancel button on the goal bar, or to stop this reply and ask again.",
      ),
      true,
    );
  }
  cancelGoal(goal, note);
  await ref.saveGoal?.(goal);
  return recordCoreAuthoredResult(
    callId,
    { tool: "goal", action: "update", goal },
    text(
      "The goal is cancelled at the user's request: it is no longer enforced and was not completed. A new goal can be registered now if the user asked for one.",
    ),
  );
}

/** goal update status=resume: only the user's own message may lift a pause. */
async function resumeGoalUpdate(kit: ToolKit, callId: string, goal: ToolKit["ref"]["goal"]) {
  const { ref, recordCoreAuthoredResult } = kit;
  if (goal?.status !== "paused") {
    return recordCoreAuthoredResult(
      callId,
      { tool: "goal", action: "update", error: "not_paused" },
      text(goal?.status === "active" ? "The goal is already active." : "No paused goal to resume."),
      true,
    );
  }
  // Only a person's own message can lift a pause the person put there;
  // crons, webhooks, ambient and delegated wakes cannot.
  if (ref.current?.humanTurn !== true) {
    return recordCoreAuthoredResult(
      callId,
      { tool: "goal", action: "update", error: "human_required" },
      text(
        "Only the user can resume a paused goal, by asking in their own message; this run was not started by one. The goal stays paused.",
      ),
      true,
    );
  }
  resumeGoal(goal);
  ref.goalOpenedThisTurn = true;
  await ref.saveGoal?.(goal);
  return recordCoreAuthoredResult(
    callId,
    { tool: "goal", action: "update", goal },
    text("The goal is active again and enforced as before. Continue working toward it."),
  );
}
