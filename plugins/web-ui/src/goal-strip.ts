import { html, nothing, type TemplateResult } from "lit";
import { Pause, Play, Target, X } from "lucide";
import { icon } from "./icons.ts";
import { tip } from "./tooltip.ts";

export interface GoalStripState {
  objective: string;
  status: "active" | "paused" | "complete" | "cancelled";
  floor?: string;
  createdAt: number;
}

export const GOAL_RESUME_PROMPT = "Continue the goal.";

interface GoalStripCurrent {
  sessionId: string;
  goal: GoalStripState;
  streaming: boolean;
  workedMs: number;
}

interface GoalStripDependencies {
  current(): GoalStripCurrent | null;
  readyToSend(): boolean;
  cancel(sessionId: string): Promise<unknown>;
  resume(sessionId: string): Promise<{ goal: GoalStripState }>;
  markCancelled(createdAt: number): void;
  applyResumed(goal: GoalStripState): void;
  refresh(): Promise<unknown>;
  sendResumePrompt(prompt: string): Promise<unknown>;
  draw(): void;
  reportError(message: string): void;
}

export function createGoalStrip(deps: GoalStripDependencies): { view(): TemplateResult | typeof nothing } {
  const cancelling = new Set<string>();
  const resuming = new Set<string>();
  const keyFor = ({ sessionId, goal }: GoalStripCurrent) => `${sessionId}:${goal.createdAt}`;
  const cancel = async (current: GoalStripCurrent): Promise<void> => {
    const key = keyFor(current);
    if (cancelling.has(key)) return;
    cancelling.add(key);
    deps.draw();
    try {
      await deps.cancel(current.sessionId);
      if (deps.current()?.sessionId === current.sessionId) deps.markCancelled(current.goal.createdAt);
      await deps.refresh();
    } catch (error) {
      deps.reportError(error instanceof Error ? error.message : "Could not cancel the goal.");
    } finally {
      cancelling.delete(key);
      deps.draw();
    }
  };
  const resume = async (current: GoalStripCurrent): Promise<void> => {
    const key = keyFor(current);
    if (current.streaming || resuming.has(key) || cancelling.has(key)) return;
    resuming.add(key);
    deps.draw();
    try {
      const out = await deps.resume(current.sessionId);
      if (deps.current()?.sessionId !== current.sessionId) return;
      deps.applyResumed(out.goal);
      await deps.sendResumePrompt(GOAL_RESUME_PROMPT);
    } catch (error) {
      deps.reportError(error instanceof Error ? error.message : "Could not resume the goal.");
    } finally {
      resuming.delete(key);
      deps.draw();
    }
  };
  return {
    view() {
      const current = deps.current();
      if (!current) return nothing;
      const { goal, streaming, workedMs } = current;
      const paused = goal.status === "paused";
      if (goal.status !== "active" && !paused) return nothing;
      const key = keyFor(current);
      const isCancelling = cancelling.has(key);
      let title = "Goal";
      if (paused) title = "Goal paused";
      else if (streaming) title = "Pursuing goal";
      return html`
        <section class="goal-strip ${paused ? "paused" : ""}" aria-live="polite" title=${goal.objective}>
          ${
            streaming
              ? html`<span class="goal-strip-icon">${icon(paused ? Pause : Target, 13)}</span>`
              : html`<button
                  type="button"
                  class="chip-x goal-strip-resume"
                  aria-label="Resume goal"
                  ${tip("Resume goal")}
                  ?disabled=${resuming.has(key) || isCancelling || !deps.readyToSend()}
                  @click=${() => void resume(current)}
                >
                  ${icon(Play, 13)}
                </button>`
          }
          <span class="goal-strip-title">${title}</span>
          <span class="goal-strip-objective" dir="auto">${goalObjectiveLabel(goal.objective)}</span>
          <span class="goal-strip-meta">${goalWorkedLabel(workedMs, goal.floor)}</span>
          <button
            type="button"
            class="chip-x"
            aria-label="Cancel goal"
            ${tip("Cancel goal")}
            ?disabled=${isCancelling || resuming.has(key)}
            @click=${() => void cancel(current)}
          >
            ${icon(X, 13)}
          </button>
        </section>
      `;
    },
  };
}

export function goalFloorLabel(floor: Record<string, unknown> | null): string | null {
  if (!floor || typeof floor !== "object") return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const parts: string[] = [];
  const ms = num(floor.minMs);
  if (ms !== null) parts.push(goalElapsedLabel(0, ms));
  const turns = num(floor.minTurns);
  if (turns !== null) parts.push(`${turns} turns`);
  const tokens = num(floor.minTokens);
  if (tokens !== null) parts.push(`${tokens.toLocaleString()} tokens`);
  const usd = num(floor.minUsd);
  if (usd !== null) parts.push(`$${usd}`);
  return parts.length ? parts.join(", ") : null;
}

export function goalElapsedLabel(startedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function goalObjectiveLabel(objective: string, max = 120): string {
  const oneLine = objective
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function goalWorkedLabel(workedMs: number, floor?: string | null): string {
  const worked = `${goalElapsedLabel(0, workedMs)} worked`;
  return floor ? `${worked} · ${floor} floor` : worked;
}
