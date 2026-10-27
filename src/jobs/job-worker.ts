import { randomUUID } from "node:crypto";
import { claimTasks, completeRun, extendClaim, failRun, retryTask, scheduleRun, spawnTask } from "../turns/absurd.ts";
import { JOB_QUEUE, registerAbsurdSchema } from "../turns/absurd-schema.ts";
import { WorkAdmissionClosed } from "../util/admitted-work.ts";
import { reportFailure } from "../util/errors.ts";
import { sleep } from "../util/async.ts";

/**
 * What became of a claimed job: `done` finished it; `release` gave it up unfinished (the next
 * spawn with the same key re-arms it); a number sleeps the job until that epoch-ms time.
 */
export type JobDisposition = "done" | "release" | number;

export type JobHandler = (params: unknown) => Promise<JobDisposition>;

/** Background jobs on the Absurd `jobs` queue: named handlers, keyed spawns, claimed by background owners. */
export interface JobWorker {
  /** Register a handler; `concurrency` caps how many of this job run at once in this process. */
  handle(name: string, handler: JobHandler, opts?: { concurrency?: number }): void;
  /** Durably queue a job; a key already live is a no-op, a released one is re-armed. */
  spawn(name: string, params: unknown, key: string): Promise<void>;
  /**
   * Run `fn` about every `everyMs` on one background owner: a self-rescheduling `every:<name>` job, spawned by
   * `start` and run first right after its first spawn. A failed run is reported and the next one still comes.
   */
  every(name: string, everyMs: number, fn: () => unknown): void;
  start(): Promise<void>;
  healthy(): boolean;
  stopClaims(): Promise<void>;
  stop(): Promise<void>;
}

const UNHEALTHY_AFTER_ERROR_MS = 30_000;
const UNKNOWN_JOB_RETRY_MS = 60_000;
const BUSY_RETRY_MS = 1000;
const MAX_CONCURRENCY = 32;
const POLL_MS = 1000;
const CLAIM_TIMEOUT_SEC = 120;
const CLAIM_EXTEND_MS = 30_000;

const clampConcurrency = (n: number) => Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(n)));

export function createJobWorker(databaseUrl: string): JobWorker {
  const db = registerAbsurdSchema(databaseUrl);
  const limit = MAX_CONCURRENCY;
  const worker = `jobs:${randomUUID()}`;
  const handlers = new Map<string, { run: JobHandler; concurrency: number; running: number }>();
  const recurring: string[] = [];
  let started = false;
  let lastErrorAt = 0;
  let loop: Promise<void> | null = null;
  let starting: Promise<void> | null = null;
  let wake = Promise.withResolvers<void>();
  const active = new Set<Promise<void>>();
  const noteError = (e: unknown): never => {
    lastErrorAt = Date.now();
    throw e;
  };

  async function settle(runId: string, disposition: JobDisposition): Promise<void> {
    const pool = await db.pool();
    if (disposition === "done") await completeRun(pool, JOB_QUEUE, runId);
    else if (disposition === "release") await failRun(pool, JOB_QUEUE, runId, { message: "released unfinished" });
    else await scheduleRun(pool, JOB_QUEUE, runId, new Date(disposition));
  }

  async function run(name: string, runId: string, params: unknown): Promise<void> {
    const keepAlive = setInterval(() => {
      void db
        .pool()
        .then((pool) => extendClaim(pool, JOB_QUEUE, runId, CLAIM_TIMEOUT_SEC))
        .catch((e: unknown) => reportFailure("jobs: extend claim", e, `job=${name}`));
    }, CLAIM_EXTEND_MS);
    keepAlive.unref?.();
    const handler = handlers.get(name);
    const busy = handler && handler.running >= handler.concurrency;
    if (handler && !busy) handler.running++;
    try {
      let disposition: JobDisposition;
      if (!handler) disposition = Date.now() + UNKNOWN_JOB_RETRY_MS;
      else if (busy) disposition = Date.now() + BUSY_RETRY_MS;
      else
        disposition = await handler.run(params).catch((e: unknown): JobDisposition => {
          reportFailure("jobs: run", e, `job=${name}`);
          return "release";
        });
      await settle(runId, disposition);
    } catch (e) {
      reportFailure("jobs: settle", e, `job=${name}`);
    } finally {
      if (handler && !busy) handler.running--;
      clearInterval(keepAlive);
    }
  }

  async function poll(): Promise<void> {
    const mine = new Set<Promise<void>>();
    while (started) {
      const free = limit - mine.size;
      let claimed = 0;
      if (free > 0) {
        try {
          for (const task of await claimTasks(await db.pool(), JOB_QUEUE, worker, CLAIM_TIMEOUT_SEC, free)) {
            claimed++;
            const work = run(task.taskName, task.runId, task.params);
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
          reportFailure("jobs: claim", e);
        }
      }
      if (claimed === 0 || mine.size >= limit) {
        await Promise.race([sleep(POLL_MS, { unref: true }), wake.promise]);
        wake = Promise.withResolvers<void>();
      }
    }
  }

  async function spawnKeyed(name: string, params: unknown, key: string, maxAttempts: number | null): Promise<void> {
    const pool = await db.pool();
    const spawned = await spawnTask(pool, JOB_QUEUE, name, params, { idempotencyKey: key, maxAttempts }).catch(
      noteError,
    );
    if (!spawned.created) await retryTask(pool, JOB_QUEUE, spawned.taskId).catch(noteError);
    wake.resolve();
  }

  async function stopClaims(): Promise<void> {
    await starting?.catch(() => {});
    started = false;
    wake.resolve();
    await loop;
    loop = null;
  }

  return {
    handle(name, run, opts = {}) {
      handlers.set(name, { run, concurrency: clampConcurrency(opts.concurrency ?? MAX_CONCURRENCY), running: 0 });
    },
    spawn: (name, params, key) => spawnKeyed(name, params, key, 1),
    every(name, everyMs, fn) {
      const job = `every:${name}`;
      recurring.push(job);
      handlers.set(job, {
        run: async () => {
          try {
            await fn();
          } catch (e) {
            if (!(e instanceof WorkAdmissionClosed)) reportFailure(`jobs: ${job}`, e);
          }
          return Date.now() + everyMs;
        },
        concurrency: 1,
        running: 0,
      });
    },
    start() {
      return (starting ??= (async () => {
        if (started) return;
        const pool = await db.pool();
        await pool.query("SELECT 1").catch(noteError);
        for (const job of recurring) await spawnKeyed(job, null, job, null);
        started = true;
        lastErrorAt = 0;
        loop = poll();
      })().finally(() => {
        starting = null;
      }));
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
