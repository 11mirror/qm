import { isTerminal, type Run, type RunStore } from "../../src/runs/run-store.ts";
import type { TurnRequest, TurnResult } from "../../src/types.ts";
import type { App } from "../../src/api/app-types.ts";

type Runs = Pick<RunStore, "get" | "waitFor" | "activeForThread" | "list">;

export async function settledRun(runs: Pick<Runs, "get" | "waitFor">, runId: string): Promise<Run> {
  const run = await runs.get(runId);
  return run && isTerminal(run.status) ? run : runs.waitFor(runId, 30_000);
}

export async function settledTurn(
  built: { app: Pick<App, "turn">; runs: Pick<Runs, "get" | "waitFor"> },
  request: TurnRequest,
): Promise<TurnResult> {
  const result = await built.app.turn(request);
  if (result.runId) await settledRun(built.runs, result.runId);
  return result;
}

export async function quietThread(built: { runs: Runs }, threadRef: string): Promise<void> {
  for (let run = await built.runs.activeForThread(threadRef); run; run = await built.runs.activeForThread(threadRef)) {
    await settledRun(built.runs, run.id);
  }
}

export async function quietRuns(built: { runs: Runs }): Promise<void> {
  for (;;) {
    const live = (await built.runs.list({ limit: 1_000 })).filter((run) => !isTerminal(run.status));
    if (live.length === 0) return;
    await Promise.all(live.map((run) => settledRun(built.runs, run.id)));
  }
}
