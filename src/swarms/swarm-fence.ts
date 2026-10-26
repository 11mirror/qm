import type { Run } from "../runs/run-store.ts";

export interface SwarmRunFence {
  runId: string;
  attempt: number;
  leaseToken: string;
  sessionId: string;
  threadRef: string;
  actorId: string;
  scopeId: string;
}

export function assertSwarmRun(
  fence: SwarmRunFence,
  run:
    | (Pick<Run, "attempts" | "sessionId" | "request"> & {
        turnFenceHeld: boolean;
      })
    | null,
): void {
  if (
    !run ||
    run.attempts !== fence.attempt ||
    !fence.leaseToken ||
    !run.turnFenceHeld ||
    run.sessionId !== fence.threadRef ||
    run.request.actor.id !== fence.actorId
  )
    throw new Error("active capability run required");
}
