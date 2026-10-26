import type { JobDisposition, JobWorker } from "../jobs/job-worker.ts";

export interface CronFireJob {
  cronId: string;
  scheduledAt: number;
  notBefore?: number;
}

/** `done` consumed the slot; `release` left it unconsumed (re-armed by the next enqueue); a number sleeps the job. */
export type CronFireDisposition = JobDisposition;

interface CronQueueHandlers {
  onFire(job: CronFireJob): Promise<CronFireDisposition>;
}

export interface CronJobQueue {
  start(handlers: CronQueueHandlers): Promise<void>;
  enqueueFire(job: CronFireJob): Promise<void>;
  healthy(): boolean;
  stopClaims(): Promise<void>;
  stop(): Promise<void>;
}

const CRON_FIRE_JOB = "cron-fire";

/** Cron fires as `cron-fire` jobs, one per (cron, slot), keyed `cron:<id>:<slot>`. */
export function cronJobQueue(jobs: JobWorker, concurrency: number): CronJobQueue {
  let started = false;
  return {
    async start(handlers) {
      jobs.handle(CRON_FIRE_JOB, (params) => handlers.onFire(params as CronFireJob), { concurrency });
      await jobs.start();
      started = true;
    },
    async enqueueFire(job) {
      if (!started) return;
      await jobs.spawn(CRON_FIRE_JOB, job, `cron:${job.cronId}:${job.scheduledAt}`);
    },
    healthy: () => jobs.healthy(),
    async stopClaims() {
      started = false;
      await jobs.stopClaims();
    },
    async stop() {
      started = false;
      await jobs.stop();
    },
  };
}
