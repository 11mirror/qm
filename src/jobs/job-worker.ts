import { randomUUID } from "node:crypto";
import {
  claimTasks,
  cleanup,
  completeRun,
  extendClaim,
  failRun,
  retryTask,
  scheduleRun,
  spawnTask,
} from "../turns/absurd.ts";
import { JOB_QUEUE, registerAbsurdSchema } from "../turns/absurd-schema.ts";
import { WorkAdmissionClosed } from "../util/admitted-work.ts";
import { reportFailure } from "../util/errors.ts";
import { sleep } from "../util/async.ts";

export type JobDisposition = "done" | "release" | number;

export type JobHandler = (params: unknown) => Promise<JobDisposition>;

export interface JobWorker {
  handle(name: string, handler: JobHandler, opts?: { concurrency?: number }): void;
  spawn(name: string, params: unknown, key: string): Promise<void>;
  every(name: string, everyMs: number, fn: () => unknown, opts?: { immediate?: boolean }): void;
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

const DONE_RETENTION_SEC = 7 * 24 * 60 * 60;
const CLEANUP_BATCH = 1000;

const clampConcurrency = (n: number) => Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(n)));

function serializeStart(worker: JobWorker): JobWorker {
  let starting: Promise<void> | null = null;
  const { start, stopClaims, stop } = worker;
  const started = () => starting?.catch(() => {});
  return Object.assign(worker, {
    start: () => (starting ??= start().finally(() => (starting = null))),
    stopClaims: async () => (await started(), stopClaims()),
    stop: async () => (await started(), stop()),
  });
}

type AbsurdDb = ReturnType<typeof registerAbsurdSchema>;
type JobHandlers = Map<string, { run: JobHandler; concurrency: number; running: number }>;

async function settleJob(db: AbsurdDb, runId: string, disposition: JobDisposition): Promise<void> {
  const pool = await db.pool();
  if (disposition === "done") await completeRun(pool, JOB_QUEUE, runId);
  else if (disposition === "release") await failRun(pool, JOB_QUEUE, runId, { message: "released unfinished" });
  else await scheduleRun(pool, JOB_QUEUE, runId, new Date(disposition));
}

async function runJob(
  db: AbsurdDb,
  handlers: JobHandlers,
  name: string,
  runId: string,
  params: unknown,
): Promise<void> {
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
    await settleJob(db, runId, disposition);
  } catch (e) {
    reportFailure("jobs: settle", e, `job=${name}`);
  } finally {
    if (handler && !busy) handler.running--;
    clearInterval(keepAlive);
  }
}

export function createJobWorker(databaseUrl: string): JobWorker {
  const db = registerAbsurdSchema(databaseUrl);
  const limit = MAX_CONCURRENCY;
  const worker = `jobs:${randomUUID()}`;
  const handlers: JobHandlers = new Map();
  const recurring: Array<{ job: string; immediate: boolean }> = [];
  let starts = 0;
  let started = false;
  let lastErrorAt = 0;
  let loop: Promise<void> | null = null;
  let wake = Promise.withResolvers<void>();
  const active = new Set<Promise<void>>();
  const noteError = (e: unknown): never => {
    lastErrorAt = Date.now();
    throw e;
  };

  async function poll(): Promise<void> {
    const mine = new Set<Promise<void>>();
    while (started) {
      const free = limit - mine.size;
      let claimed = 0;
      if (free > 0) {
        try {
          for (const task of await claimTasks(await db.pool(), JOB_QUEUE, worker, CLAIM_TIMEOUT_SEC, free)) {
            claimed++;
            const work = runJob(db, handlers, task.taskName, task.runId, task.params);
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

  async function spawnKeyed(name: string, params: unknown, key: string, maxAttempts: number | null): Promise<boolean> {
    const pool = await db.pool();
    const spawned = await spawnTask(pool, JOB_QUEUE, name, params, { idempotencyKey: key, maxAttempts }).catch(
      noteError,
    );
    if (!spawned.created) await retryTask(pool, JOB_QUEUE, spawned.taskId).catch(noteError);
    wake.resolve();
    return spawned.created;
  }

  async function stopClaims(): Promise<void> {
    started = false;
    wake.resolve();
    await loop;
    loop = null;
  }

  const jobWorker = serializeStart({
    handle(name, run, opts = {}) {
      handlers.set(name, { run, concurrency: clampConcurrency(opts.concurrency ?? MAX_CONCURRENCY), running: 0 });
    },
    async spawn(name, params, key) {
      await spawnKeyed(name, params, key, 1);
    },
    every(name, everyMs, fn, opts = {}) {
      const job = `every:${name}`;
      recurring.push({ job, immediate: opts.immediate ?? false });
      handlers.set(job, {
        run: async (params) => {
          try {
            await fn();
          } catch (e) {
            if (!(e instanceof WorkAdmissionClosed)) reportFailure(`jobs: ${job}`, e);
          }
          return (params as { once?: boolean } | null)?.once ? "done" : Date.now() + everyMs;
        },
        concurrency: 1,
        running: 0,
      });
    },
    async start() {
      if (started) return;
      const pool = await db.pool();
      await pool.query("SELECT 1").catch(noteError);
      const start = `${worker}:${++starts}`;
      for (const { job, immediate } of recurring) {
        const created = await spawnKeyed(job, null, job, null);
        if (immediate && !created) await spawnKeyed(job, { once: true }, `${job}:start:${start}`, 1);
      }
      started = true;
      lastErrorAt = 0;
      loop = poll();
    },
    healthy() {
      return started && Date.now() - lastErrorAt >= UNHEALTHY_AFTER_ERROR_MS;
    },
    stopClaims,
    async stop() {
      await stopClaims();
      while (active.size) await Promise.allSettled([...active]);
    },
  });
  jobWorker.every("jobs:cleanup", 60 * 60_000, async () => {
    while ((await cleanup(await db.pool(), JOB_QUEUE, DONE_RETENTION_SEC, CLEANUP_BATCH)).tasks >= CLEANUP_BATCH);
  });
  return jobWorker;
}
