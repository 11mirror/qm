import { randomUUID } from "node:crypto";
import {
  abandonTask,
  type AbsurdDb as AbsurdConnection,
  type ClaimedRun,
  claimTasks,
  queueTenants,
  cleanup,
  completeRun,
  extendClaim,
  failRun,
  retryTask,
  scheduleRun,
  spawnTask,
} from "../turns/absurd.ts";
import { JOB_QUEUE, registerAbsurdSchema } from "../turns/absurd-schema.ts";
import { createPostgresLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import { WorkAdmissionClosed } from "../util/admitted-work.ts";
import { reportFailure } from "../util/errors.ts";
import { mapBounded, sleep } from "../util/async.ts";
import { pgPoolMax, pgTenancyEnabled, tenantLockKey } from "../persistence/pg-pool.ts";
import { holdTenant, tenant, withoutTenant, withTenant, type Tenant } from "../tenant.ts";
import { activeTenants, retiredTenantReason, taskTenant } from "../tenants/directory.ts";

export type JobDisposition = "done" | "release" | number;

export type JobHandler = (params: unknown) => Promise<JobDisposition>;

type TenantWork = { sql: string; tables: string[] };
export type EveryOptions = { immediate?: boolean } & ({ shared: true } | { due: string | TenantWork });

export const hasRows = (table: string, where = "true"): TenantWork => ({
  sql: `EXISTS (SELECT 1 FROM ${table} w WHERE w.tenant_id = t.id AND (${where}))`,
  tables: [table],
});

export const anyRows = (...work: TenantWork[]): TenantWork => ({
  sql: work.map(({ sql }) => sql).join(" OR "),
  tables: work.flatMap(({ tables }) => tables),
});

export interface JobWorker {
  handle(name: string, handler: JobHandler, opts?: { concurrency?: number }): void;
  spawn(name: string, params: unknown, key: string, db?: AbsurdConnection): Promise<void>;
  every(name: string, everyMs: number, fn: () => unknown, opts: EveryOptions): void;
  start(): Promise<void>;
  healthy(): boolean;
  stopClaims(): Promise<void>;
  stop(): Promise<void>;
}

const UNHEALTHY_AFTER_ERROR_MS = 30_000;
const UNKNOWN_JOB_RETRY_MS = 60_000;
const TENANT_NOT_READY_RETRY_MS = 5_000;
const BUSY_RETRY_MS = 1000;
const POLL_MS = 1000;
const CLAIM_TIMEOUT_SEC = 120;
const CLAIM_EXTEND_MS = 30_000;

const DONE_RETENTION_SEC = 7 * 24 * 60 * 60;
const CLEANUP_BATCH = 1000;
const UNDEFINED_TABLE = "42P01";

const claimBudget = () => Math.max(1, Math.floor(pgPoolMax("query") / 2));
const clampConcurrency = (n: number) => Math.min(claimBudget(), Math.max(1, Math.trunc(n)));

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
type Settlement = JobDisposition | { abandon: string };
type JobHandlers = Map<
  string,
  {
    run: (params: unknown, tenantId: string | undefined) => Promise<Settlement>;
    concurrency: number;
    running: number;
  }
>;

async function settleJob(db: AbsurdDb, task: ClaimedRun, disposition: Settlement): Promise<void> {
  const pool = await db.pool();
  const { runId } = task;
  if (typeof disposition === "object") await abandonTask(pool, JOB_QUEUE, task, disposition.abandon);
  else if (disposition === "done") await completeRun(pool, JOB_QUEUE, runId);
  else if (disposition === "release") await failRun(pool, JOB_QUEUE, runId, { message: "released unfinished" });
  else await scheduleRun(pool, JOB_QUEUE, runId, new Date(disposition));
}

async function runJob(db: AbsurdDb, handlers: JobHandlers, task: ClaimedRun): Promise<void> {
  const { taskName: name, runId } = task;
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
    let disposition: Settlement;
    if (!handler) disposition = Date.now() + UNKNOWN_JOB_RETRY_MS;
    else if (busy) disposition = Date.now() + BUSY_RETRY_MS;
    else
      disposition = await handler.run(task.params, task.tenantId).catch((e: unknown): Settlement => {
        reportFailure("jobs: run", e, `job=${name}`);
        return "release";
      });
    await settleJob(db, task, disposition);
  } catch (e) {
    reportFailure("jobs: settle", e, `job=${name}`);
  } finally {
    if (handler && !busy) handler.running--;
    clearInterval(keepAlive);
  }
}

async function runRecurring(job: string, fn: () => unknown, context?: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof WorkAdmissionClosed)) reportFailure(`jobs: ${job}`, e, context);
  }
}

function tenantTicker(job: string, fn: () => unknown, track: (work: Promise<void>) => void) {
  const inFlight = new Set<string>();
  return async (owners: Tenant[]): Promise<void> => {
    const ready = owners.filter((owner) => !inFlight.has(owner.id ?? ""));
    for (const owner of ready) inFlight.add(owner.id ?? "");
    const work = mapBounded(ready, claimBudget(), async (owner) => {
      const release = holdTenant(owner);
      await runRecurring(job, () => withTenant(owner, fn), `tenant=${owner.slug ?? owner.id}`).finally(() => {
        release();
        inFlight.delete(owner.id ?? "");
      });
    }).then(() => undefined);
    track(work);
    await work;
  };
}

async function dueTenants(db: AbsurdDb, job: string, due: string | TenantWork): Promise<Tenant[]> {
  if (!pgTenancyEnabled()) return [tenant()];
  const active = await activeTenants();
  const tables = typeof due === "string" ? [] : due.tables;
  const sql = typeof due === "string" ? due : due.sql;
  const candidates = tables.length
    ? await (
        await db.deploymentPool()
      )
        .query("SELECT id::text AS id FROM qm_tenants_with_rows($1::regclass[])", [tables])
        .catch((error: unknown) => {
          if ((error as { code?: string }).code === UNDEFINED_TABLE) return { rows: [] };
          throw error;
        })
    : undefined;
  const ids = new Set(candidates?.rows.map((row) => row.id));
  const owners = candidates ? active.filter((owner) => ids.has(owner.id ?? null)) : active;
  const dueOwners = await mapBounded(owners, claimBudget(), (owner) =>
    withTenant(owner, async () => {
      const rows = await (
        await db.pool()
      )
        .query(`SELECT t.id FROM (SELECT qm_tenant_id() AS id) t WHERE ${sql}`)
        .catch((e: unknown) => {
          if ((e as { code?: string }).code === UNDEFINED_TABLE) return { rows: [] };
          throw e;
        });
      return rows.rows.length ? owner : undefined;
    }),
  );
  const ready = await mapBounded(
    dueOwners.filter((owner): owner is Tenant => owner !== undefined),
    claimBudget(),
    (owner) =>
      taskTenant(owner.id, true).catch((error: unknown) => {
        reportFailure(`jobs: ${job} tenant`, error, `tenant=${owner.id}`);
        return undefined;
      }),
  );
  return ready.filter((owner): owner is Tenant => typeof owner === "object");
}

async function cleanupJobs(db: AbsurdDb): Promise<void> {
  while ((await cleanup(await db.pool(), JOB_QUEUE, DONE_RETENTION_SEC, CLEANUP_BATCH)).tasks >= CLEANUP_BATCH);
}

type RecurringJob = { run: () => Promise<void>; everyMs: number; nextAt: number; pending: boolean };

async function recurringTicks(
  lease: LeaderLease,
  jobs: RecurringJob[],
  started: () => boolean,
  stopped: Promise<void>,
  track: (work: Promise<void>) => void,
): Promise<void> {
  while (started()) {
    await lease
      .hold("jobs:recurring", async (lost) => {
        let held = true;
        const halt = Promise.race([lost, stopped]);
        void halt.then(() => {
          held = false;
        });
        while (held && started()) {
          for (const job of jobs) {
            if (job.pending || Date.now() < job.nextAt) continue;
            job.pending = true;
            job.nextAt = Date.now() + job.everyMs;
            track(
              job.run().finally(() => {
                job.pending = false;
              }),
            );
          }
          await Promise.race([sleep(POLL_MS, { unref: true }), halt]);
        }
      })
      .catch((error: unknown) => reportFailure("jobs: recurring ownership", error));
    if (started()) await Promise.race([sleep(POLL_MS, { unref: true }), stopped]);
  }
}

export function createJobWorker(databaseUrl: string): JobWorker {
  const db = registerAbsurdSchema(databaseUrl);
  const worker = `jobs:${randomUUID()}`;
  const handlers: JobHandlers = new Map();
  const lease = createPostgresLeaderLease({ sessionPool: () => db.deploymentSessionPool() });
  const recurring: RecurringJob[] = [];
  let ticks: Promise<void> | undefined;
  let stopping = Promise.withResolvers<void>();
  let started = false;
  let lastErrorAt = 0;
  let loop: Promise<void> | null = null;
  let wake = Promise.withResolvers<void>();
  const active = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    active.add(work);
    void work.finally(() => active.delete(work));
  };
  const noteError = (e: unknown): never => {
    lastErrorAt = Date.now();
    throw e;
  };

  async function poll(): Promise<void> {
    const mine = new Set<Promise<void>>();
    while (started) {
      const limit = claimBudget();
      const free = limit - mine.size;
      let claimed = 0;
      if (free > 0) {
        try {
          for (const owner of await queueTenants(await db.deploymentPool(), JOB_QUEUE)) {
            if (mine.size >= limit) break;
            const tasks = await withTenant(owner, async () =>
              claimTasks(await db.pool(), JOB_QUEUE, worker, CLAIM_TIMEOUT_SEC, limit - mine.size),
            );
            for (const task of tasks) {
              claimed++;
              const work = withTenant(owner, () => runJob(db, handlers, task));
              active.add(work);
              mine.add(work);
              void work.finally(() => {
                active.delete(work);
                mine.delete(work);
                wake.resolve();
              });
            }
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

  async function spawnKeyed(
    name: string,
    params: unknown,
    key: string,
    maxAttempts: number | null,
    conn?: AbsurdConnection,
  ): Promise<boolean> {
    const pool = conn ?? (await db.pool());
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
    stopping.resolve();
    await Promise.all([loop, ticks]);
    loop = null;
  }

  const jobWorker = serializeStart({
    handle(name, run, opts = {}) {
      handlers.set(name, {
        run: async (params, tenantId) => {
          const owner = await taskTenant(tenantId).catch((e: unknown) => {
            reportFailure(`jobs: ${name} tenant`, e);
            return undefined;
          });
          if (owner === "retired") return { abandon: retiredTenantReason(tenantId) };
          if (!owner) return Date.now() + TENANT_NOT_READY_RETRY_MS;
          const release = holdTenant(owner);
          return withTenant(owner, () => run(params)).finally(release);
        },
        concurrency: clampConcurrency(opts.concurrency ?? claimBudget()),
        running: 0,
      });
    },
    async spawn(name, params, key, conn) {
      await spawnKeyed(name, params, tenantLockKey(key), 1, conn);
    },
    every(name, everyMs, fn, opts) {
      const job = `every:${name}`;
      const tick = tenantTicker(job, fn, track);
      recurring.push({
        everyMs,
        nextAt: 0,
        pending: false,
        run: async () => {
          try {
            const owners = "shared" in opts ? await activeTenants() : await dueTenants(db, job, opts.due);
            await tick(owners);
          } catch (error) {
            reportFailure(`jobs: ${job}`, error);
          }
        },
      });
    },
    async start() {
      if (started) return;
      await (await db.deploymentPool()).query("SELECT 1").catch(noteError);
      for (const job of recurring) job.nextAt = 0;
      started = true;
      lastErrorAt = 0;
      stopping = Promise.withResolvers<void>();
      loop = withoutTenant(() => poll());
      ticks = withoutTenant(() => recurringTicks(lease, recurring, () => started, stopping.promise, track));
    },
    healthy: () => started && Date.now() - lastErrorAt >= UNHEALTHY_AFTER_ERROR_MS,
    stopClaims,
    async stop() {
      await stopClaims();
      while (active.size) await Promise.allSettled([...active]);
    },
  });
  jobWorker.every("jobs:cleanup", 60 * 60_000, () => cleanupJobs(db), { shared: true });
  return jobWorker;
}
