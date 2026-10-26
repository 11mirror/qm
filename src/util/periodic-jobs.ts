import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { createSweeper as CreateSweeper } from "./sweeper.ts";

/**
 * One periodic background job. `lock` says how replicas share it: "leader" runs it on the replica holding the leader
 * lease `name`, "advisory" skips the tick while another replica holds the advisory lock `name`, and "none" runs it on
 * every replica.
 */
export interface PeriodicJob {
  name: string;
  everyMs: number;
  lock: "leader" | "advisory" | "none";
  immediate?: boolean;
  run: (lost: Promise<void>) => unknown;
}

const NEVER = new Promise<void>(() => {});

export function createPeriodicJobs(
  jobs: readonly PeriodicJob[],
  deps: { createSweeper: typeof CreateSweeper; leaderLease: LeaderLease; advisoryLock: AdvisoryLock },
): { start(): void; stop(): Promise<void> } {
  const tick = (job: PeriodicJob): Promise<unknown> => {
    if (job.lock === "leader") return deps.leaderLease.hold(job.name, async (lost) => job.run(lost));
    if (job.lock === "advisory") return deps.advisoryLock.tryWithLock(job.name, async () => job.run(NEVER));
    return Promise.resolve(job.run(NEVER));
  };
  const sweepers = jobs.map((job) =>
    deps.createSweeper(() => tick(job), job.everyMs, {
      label: job.name,
      ...(job.immediate ? { immediate: true } : {}),
    }),
  );
  return {
    start: () => sweepers.forEach((sweeper) => sweeper.start()),
    stop: async () => void (await Promise.all(sweepers.map((sweeper) => sweeper.stop()))),
  };
}
