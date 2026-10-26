import { randomUUID } from "node:crypto";
import { claimTasks, completeRun, extendClaim, failRun, retryTask, scheduleRun, spawnTask } from "../turns/absurd.ts";
import { JOB_QUEUE, registerAbsurdSchema } from "../turns/absurd-schema.ts";
import { reportFailure } from "../util/errors.ts";
import { sleep } from "../util/async.ts";

export interface CronFireJob {
  cronId: string;
  scheduledAt: number;
  notBefore?: number;
}

/**
 * What became of a claimed fire: `done` consumed the slot; `release` left it unconsumed
 * (the next enqueue of the same slot re-arms it); a number sleeps the job until that time.
 */
export type CronFireDisposition = "done" | "release" | number;

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

const CRON_FIRE_TASK = "cron-fire";
const UNHEALTHY_AFTER_ERROR_MS = 30_000;
const POLL_MS = 1000;
const CLAIM_TIMEOUT_SEC = 120;
const CLAIM_EXTEND_MS = 30_000;

/** Cron fires as Absurd tasks on the `jobs` queue: one task per (cron, slot), keyed `cron:<id>:<slot>`. */
export function createAbsurdCronQueue(databaseUrl: string, fireConcurrency: number = 1): CronJobQueue {
  const db = registerAbsurdSchema(databaseUrl);
  const concurrency = Math.min(32, Math.max(1, Math.trunc(fireConcurrency)));
  const worker = `cron:${randomUUID()}`;
  let started = false;
  let lastErrorAt = 0;
  let loop: Promise<void> | null = null;
  let wake = Promise.withResolvers<void>();
  const active = new Set<Promise<void>>();
  const noteError = (e: unknown): never => {
    lastErrorAt = Date.now();
    throw e;
  };

  async function settle(runId: string, disposition: CronFireDisposition): Promise<void> {
    const pool = await db.pool();
    if (disposition === "done") await completeRun(pool, JOB_QUEUE, runId);
    else if (disposition === "release") await failRun(pool, JOB_QUEUE, runId, { message: "slot not consumed" });
    else await scheduleRun(pool, JOB_QUEUE, runId, new Date(disposition));
  }

  async function run(handlers: CronQueueHandlers, runId: string, job: CronFireJob): Promise<void> {
    const keepAlive = setInterval(() => {
      void db
        .pool()
        .then((pool) => extendClaim(pool, JOB_QUEUE, runId, CLAIM_TIMEOUT_SEC))
        .catch((e: unknown) => reportFailure("cron queue: extend claim", e));
    }, CLAIM_EXTEND_MS);
    keepAlive.unref?.();
    try {
      const disposition = await handlers.onFire(job).catch((e: unknown): CronFireDisposition => {
        reportFailure("cron queue: fire", e, `cron=${job.cronId}`);
        return "release";
      });
      await settle(runId, disposition);
    } catch (e) {
      reportFailure("cron queue: settle fire", e, `cron=${job.cronId}`);
    } finally {
      clearInterval(keepAlive);
    }
  }

  async function poll(handlers: CronQueueHandlers): Promise<void> {
    const mine = new Set<Promise<void>>();
    while (started) {
      const free = concurrency - mine.size;
      let claimed = 0;
      if (free > 0) {
        try {
          for (const task of await claimTasks(await db.pool(), JOB_QUEUE, worker, CLAIM_TIMEOUT_SEC, free)) {
            claimed++;
            const work = run(handlers, task.runId, task.params as CronFireJob);
            active.add(work);
            mine.add(work);
            void work.finally(() => {
              active.delete(work);
              mine.delete(work);
              wake.resolve();
            });
          }
        } catch (e) {
          lastErrorAt = Date.now();
          reportFailure("cron queue: claim", e);
        }
      }
      if (claimed === 0 || mine.size >= concurrency) {
        await Promise.race([sleep(POLL_MS, { unref: true }), wake.promise]);
        wake = Promise.withResolvers<void>();
      }
    }
  }

  async function stopClaims(): Promise<void> {
    started = false;
    wake.resolve();
    await loop;
    loop = null;
  }

  return {
    async start(handlers) {
      if (started) return;
      await (await db.pool()).query("SELECT 1").catch(noteError);
      started = true;
      lastErrorAt = 0;
      loop = poll(handlers);
    },
    async enqueueFire(job) {
      if (!started) return;
      const pool = await db.pool();
      const spawned = await spawnTask(pool, JOB_QUEUE, CRON_FIRE_TASK, job, {
        idempotencyKey: `cron:${job.cronId}:${job.scheduledAt}`,
        maxAttempts: 1,
      }).catch(noteError);
      if (!spawned.created) await retryTask(pool, JOB_QUEUE, spawned.taskId).catch(noteError);
    },
    healthy() {
      return started && Date.now() - lastErrorAt >= UNHEALTHY_AFTER_ERROR_MS;
    },
    stopClaims,
    async stop() {
      await stopClaims();
      while (active.size) await Promise.allSettled([...active]);
    },
  };
}
