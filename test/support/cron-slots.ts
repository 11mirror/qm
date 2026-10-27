import { isDeferred, type CronStore } from "../../src/cron/cron-store.ts";
import { recoverNextFireAt } from "../../src/cron/schedule.ts";
import type { Cron } from "../../src/types.ts";
import type { JobWorker } from "../../src/jobs/job-worker.ts";

/** Crons whose current slot is due at `now`, as the scheduler's fire path sees them. */
export async function dueCrons(crons: CronStore, now: number): Promise<Array<Cron & { scheduledAt: number }>> {
  const due: Array<Cron & { scheduledAt: number }> = [];
  for (const c of await crons.list()) {
    if (c.archived || !c.enabled || isDeferred(c, now)) continue;
    const scheduledAt = recoverNextFireAt(c.schedule, c.createdAt, c.lastFiredAt, c.nextFireAt);
    if (scheduledAt !== undefined && now >= scheduledAt) due.push({ ...c, nextFireAt: scheduledAt, scheduledAt });
  }
  return due;
}

/** Consume a cron's current (or the given) slot at `at`, the way a successful fire does. */
export async function markFired(crons: CronStore, id: string, at: number, scheduledAt?: number): Promise<void> {
  const cron = await crons.get(id);
  if (!cron) return;
  const slot = scheduledAt ?? recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt);
  if (slot !== undefined) await crons.claimSlot(id, slot, at);
}

/** A job worker that never claims: for tests that drive fires through `scheduler.tick`. */
export function idleJobs(): Pick<JobWorker, "handle" | "spawn"> {
  return { handle() {}, async spawn() {} };
}
