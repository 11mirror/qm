import { currentTextPhase } from "./timeline.ts";
import { goalElapsedLabel, type GoalStripState } from "./goal-strip.ts";
import { serverNow, workPausedForApproval, type WorkBlock } from "./core-bridge.ts";

function activityTimes(work: WorkBlock): number[] {
  return work.activity.map((a) => a.createdAt).filter((t) => typeof t === "number" && t > 0);
}

export function workStart(work: WorkBlock): number | null {
  if (typeof work.startedAt === "number") return work.startedAt;
  const times = activityTimes(work);
  return times.length ? Math.min(...times) : null;
}

export function workSeconds(work: WorkBlock): number {
  const start = workStart(work);
  if (start == null) return 0;
  const live = work.status === "thinking" || work.status === "working";
  const phase = currentTextPhase(work);
  const last = work.activity.at(-1);
  let end = workPausedForApproval(work) ? last!.createdAt : work.finishedAt;
  if (phase?.phase === "final_answer") end = phase.startedAt;
  if (end == null) {
    if (live) return Math.max(0, Math.floor((serverNow() - start) / 1000));
    const times = activityTimes(work);
    end = times.length ? Math.max(...times, start) : start;
  }
  return Math.max(0, Math.round((end - start) / 1000));
}

export function workedLabel(prefix: string, secs: number): string {
  return secs > 0 ? `${prefix} for ${goalElapsedLabel(0, secs * 1000)}` : prefix;
}

interface GoalTurn {
  role?: string;
  stopReason?: string;
  work?: WorkBlock;
}

/**
 * Time actually spent running turns on the goal: the work time of every turn
 * from the one that created it, clamped to the goal's creation. Idle time
 * between turns never counts, and a human stop ends the tally (the goal is
 * paused from then on).
 */
export function goalWorked(messages: readonly unknown[], goal: GoalStripState): { workedMs: number; paused: boolean } {
  let workedMs = 0;
  let counting = false;
  for (const m of messages as readonly GoalTurn[]) {
    const work = m.role === "assistant" ? m.work : undefined;
    if (!work) continue;
    const start = workStart(work);
    if (!counting) {
      if (start === null || (work.finishedAt ?? Infinity) < goal.createdAt) continue;
      counting = true;
      workedMs -= Math.max(0, goal.createdAt - start);
    }
    workedMs += workSeconds(work) * 1000;
    if (m.stopReason === "aborted") return { workedMs: Math.max(0, workedMs), paused: true };
  }
  return { workedMs: Math.max(0, workedMs), paused: false };
}
