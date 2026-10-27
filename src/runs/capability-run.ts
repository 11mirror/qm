import type { CapabilityClaims } from "../auth/capability-token.ts";
import { samePerson } from "../directory/person.ts";
import type { RunStore } from "./run-store.ts";

export async function capabilityRunActive(
  runs: Pick<RunStore, "get" | "leaseHeld"> | undefined,
  cap: CapabilityClaims,
): Promise<boolean> {
  const run = runs && cap.runId ? await runs.get(cap.runId) : null;
  return Boolean(
    run &&
    cap.runLeaseToken &&
    run.attempts === cap.runAttempt &&
    run.sessionId === cap.threadRef &&
    samePerson(run.request.actor.id, cap.actorId) &&
    (await runs!.leaseHeld(run, cap.runLeaseToken)),
  );
}
