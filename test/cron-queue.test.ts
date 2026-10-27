import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createScheduler, CRON_FIRE_JOB, type Scheduler } from "../src/cron/scheduler.ts";
import { createJobWorker, type JobWorker } from "../src/jobs/job-worker.ts";
import { createCronStore, type CronStore } from "../src/cron/cron-store.ts";
import { type CronFireStore } from "../src/cron/fire-store.ts";
import { recordingOutbound } from "./support/recording-outbound.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { scopeId, type Cron, type TurnRequest, type TurnResult } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testDatabaseUrl, testMap } from "./support/test-database.ts";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the cron queue tests";

const CRONS_TABLE = "cron_queue_test_crons";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(`DROP TABLE IF EXISTS ${CRONS_TABLE}`);
  await p.end();
});

async function until(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

function instance(
  calls: TurnRequest[],
  turnMs: number,
  fires: CronFireStore,
): { scheduler: Scheduler; crons: CronStore; jobs: JobWorker } {
  const maps = createPostgresMapFactory(URL!);
  const crons = createCronStore(maps.map<Cron>(CRONS_TABLE), { fires });
  const jobs = createJobWorker(URL ?? "");
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    if (turnMs) await new Promise((r) => setTimeout(r, turnMs));
    return { status: "ok", reply: "QUEUE-OUTPUT" };
  };
  const scheduler = createScheduler({
    ...singleProcessDeps(),
    crons,
    outbound: recordingOutbound(),
    idempotency: createIdempotencyStore(URL!),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    run,
    jobs,
    fireConcurrency: 4,
  });
  return { scheduler, crons, jobs };
}

test(
  "cron job queue: a slow fire is not double-run by a sibling instance (durable slot claim)",
  { skip, timeout: 120_000 },
  async () => {
    const calls: TurnRequest[] = [];
    const fires = createPostgresCronFireStore(testDatabaseUrl());
    const a = instance(calls, 12_000, fires);
    const b = instance(calls, 12_000, fires);
    await a.jobs.start();
    await b.jobs.start();
    try {
      const cron = await a.crons.create({
        schedule: { firstFireAt: Date.now() + 500 },
        action: "remind me once",
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
      });
      a.scheduler.notifyChanged(cron.id);
      await until(() => calls.length >= 1, 30_000);
      assert.equal(calls.length, 1, "the due slot starts exactly one turn");
      await new Promise((r) => setTimeout(r, 16_000));
      assert.equal(calls.length, 1, "no sibling or reconcile re-run while (or after) the slow turn runs");
      assert.equal((await b.crons.get(cron.id))?.enabled, false, "the one-shot ends disabled");
      assert.equal((await b.crons.listFires(cron.id)).total, 1, "one fire recorded");
    } finally {
      await Promise.all([a.jobs.stop(), b.jobs.stop()]);
    }
  },
);

test(
  "cron job queue: a recurring cron chains fires with unique slots, and a schedule edit invalidates queued slots",
  { skip, timeout: 120_000 },
  async () => {
    const calls: TurnRequest[] = [];
    const fireStore = createPostgresCronFireStore(testDatabaseUrl());
    const a = instance(calls, 0, fireStore);
    const b = instance(calls, 0, fireStore);
    await a.jobs.start();
    await b.jobs.start();
    try {
      const cron = await a.crons.create({
        schedule: { everyMs: 2000 },
        action: "poll the queue",
        owner: "U2",
        createdBy: "U2",
        ownerScopeId: scopeId("personal", "U2"),
      });
      a.scheduler.notifyChanged(cron.id);
      const fires = () => calls.filter((c) => c.idempotencyKey?.startsWith(`cron:${cron.id}:`)).length;
      await until(() => fires() >= 3, 45_000);
      assert.ok(fires() >= 3, "a recurring cron chains fire jobs across instances");
      const keys = calls.map((c) => c.idempotencyKey);
      assert.equal(new Set(keys).size, keys.length, "no slot fires twice");

      await b.crons.update(cron.id, { schedule: { everyMs: 60_000 } });
      b.scheduler.notifyChanged(cron.id);
      const at = fires();
      await new Promise((r) => setTimeout(r, 6_000));
      assert.equal(fires(), at, "a rescheduled cron's stale slot jobs do not fire");
    } finally {
      await Promise.all([a.jobs.stop(), b.jobs.stop()]);
    }
  },
);

test(
  "cron job queue: a cron persisted without its fire job is enqueued once by repair",
  { skip, timeout: 120_000 },
  async () => {
    const calls: TurnRequest[] = [];
    const fires = createPostgresCronFireStore(testDatabaseUrl());
    const a = instance(calls, 0, fires);
    const b = instance(calls, 0, fires);
    const cron = await a.crons.create({
      schedule: { firstFireAt: Date.now() - 1000 },
      action: "survive the crash",
      owner: "U3",
      createdBy: "U3",
      ownerScopeId: scopeId("personal", "U3"),
    });
    await a.jobs.start();
    await b.jobs.start();
    try {
      await Promise.all([a.scheduler.repair(), b.scheduler.repair()]);
      const fired = () => calls.filter((c) => c.idempotencyKey?.startsWith(`cron:${cron.id}:`)).length;
      await until(() => fired() >= 1, 30_000);
      await new Promise((r) => setTimeout(r, 3_000));
      assert.equal(fired(), 1, "the orphaned slot fires exactly once across both instances");
      assert.equal((await a.crons.listFires(cron.id)).total, 1);
    } finally {
      await Promise.all([a.jobs.stop(), b.jobs.stop()]);
    }
  },
);

test(
  "job worker: a released slot is re-armed by the next enqueue, a consumed one is not",
  { skip, timeout: 60_000 },
  async () => {
    const queue = createJobWorker(URL!);
    const seen: number[] = [];
    const key = `cron:rearm-${Date.now()}`;
    const job = { cronId: key };
    queue.handle(CRON_FIRE_JOB, async () => {
      seen.push(Date.now());
      return seen.length === 1 ? "release" : "done";
    });
    await queue.start();
    try {
      await queue.spawn(CRON_FIRE_JOB, job, key);
      await until(() => seen.length >= 1, 15_000);
      await new Promise((r) => setTimeout(r, 300));
      await queue.spawn(CRON_FIRE_JOB, job, key);
      await until(() => seen.length >= 2, 15_000);
      assert.equal(seen.length, 2, "the released slot fired again");
      await new Promise((r) => setTimeout(r, 300));
      await queue.spawn(CRON_FIRE_JOB, job, key);
      await new Promise((r) => setTimeout(r, 2_500));
      assert.equal(seen.length, 2, "a consumed slot never fires twice");
    } finally {
      await queue.stop();
    }
  },
);

test(
  "job worker: an every job runs on one of two workers and keeps its cadence after a throw",
  { skip, timeout: 60_000 },
  async () => {
    const name = `cadence-${Date.now()}`;
    const runs: number[] = [];
    const workers = [createJobWorker(URL!), createJobWorker(URL!)];
    for (const worker of workers)
      worker.every(name, 1000, () => {
        runs.push(Date.now());
        if (runs.length === 1) throw new Error("first run fails");
      });
    try {
      await Promise.all(workers.map((worker) => worker.start()));
      await until(() => runs.length >= 3, 20_000);
      assert.ok(runs.length >= 3, "the job reschedules itself, even after a failed run");
      for (let i = 1; i < runs.length; i++)
        assert.ok(runs[i]! - runs[i - 1]! >= 900, "runs never overlap or double up");
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
  },
);
