import assert from "node:assert/strict";
import test from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../src/runs/background-ownership.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const databaseUrl = process.env.DATABASE_URL;
test("Postgres serializes concurrent owner changes", { skip: !databaseUrl }, async () => {
  const url = testDatabaseUrl();
  const stores = [createBackgroundOwnershipStore(url), createBackgroundOwnershipStore(url)];
  const claims = await Promise.allSettled(
    stores.map((store, i) =>
      store.set({ ownerDeploymentId: `d${i}`, expectedOwnerDeploymentId: null, setBy: `d${i}` }),
    ),
  );
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(claims.filter((result) => result.status === "rejected").length, 1);
  const state = await stores[0]!.get();
  assert.ok(["d0", "d1"].includes(state.ownerDeploymentId!));
  assert.deepEqual(await stores[1]!.get(), state);
});

test(
  "cron job queue resumes polling without terminating a prior generation callback",
  { skip: !databaseUrl, timeout: 20_000 },
  async () => {
    const { cronJobQueue } = await import("../src/cron/job-queue.ts");
    const { createJobWorker } = await import("../src/jobs/job-worker.ts");
    const queue = cronJobQueue(createJobWorker(databaseUrl!), 1);
    const oldEntered = Promise.withResolvers<void>();
    const oldFinish = Promise.withResolvers<void>();
    const newEntered = Promise.withResolvers<void>();
    let oldFinished = false;
    try {
      await queue.start({
        onFire: async () => {
          oldEntered.resolve();
          await oldFinish.promise;
          oldFinished = true;
          return "done";
        },
      });
      await queue.enqueueFire({ cronId: "old", scheduledAt: Date.now() });
      await oldEntered.promise;
      await queue.stopClaims!();
      assert.equal(oldFinished, false);
      await queue.start({
        onFire: async () => {
          newEntered.resolve();
          return "done";
        },
      });
      await queue.enqueueFire({ cronId: "new", scheduledAt: Date.now() });
      await newEntered.promise;
      assert.equal(oldFinished, false);
      oldFinish.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(oldFinished, true);
    } finally {
      oldFinish.resolve();
      await queue.stop();
    }
  },
);

test(
  "a delayed owner change committed after the client gave up is confirmed by the readback",
  { skip: !databaseUrl, timeout: 20_000 },
  async () => {
    const { setBackgroundOwner } = await import("../cli/src/background-work.ts");
    const url = testDatabaseUrl();
    const store = createBackgroundOwnershipStore(url);
    const pg = createPgPool(url);
    const pool = await pg.pool();
    const blocker = await pool.connect();
    let first: Promise<BackgroundOwnership> | undefined;
    const status = (state: BackgroundOwnership) =>
      JSON.stringify({ ...state, protocol: 2, deploymentId: "b", instanceId: "b-1", active: false });
    try {
      await store.set({ ownerDeploymentId: "a", setBy: "a" });
      await blocker.query("BEGIN");
      await blocker.query("SELECT * FROM background_ownership WHERE id = 'ownership' FOR UPDATE");
      const change = { ownerDeploymentId: "b", expectedOwnerDeploymentId: "a" };
      let posts = 0;
      let reads = 0;
      const result = await setBackgroundOwner(
        async (method, body) => {
          if (method === "POST") {
            posts++;
            assert.equal(body, JSON.stringify(change));
            if (posts === 1) {
              first = store.set({ ...change, setBy: "b" });
              throw new Error("client timeout while server transaction is pending");
            }
            await blocker.query("COMMIT");
            await first;
            return { status: 200, body: status(await store.set({ ...change, setBy: "b" })) };
          }
          reads++;
          const current = await store.get();
          if (reads === 1) assert.equal(current.ownerDeploymentId, "a");
          return { status: 200, body: status(current) };
        },
        "b",
        change,
      );
      assert.equal(result.ownerDeploymentId, "b");
      assert.equal(posts, 2);
      assert.equal(reads, 1);
      assert.equal((await store.get()).ownerDeploymentId, "b");
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await first?.catch(() => {});
      await pg.close();
    }
  },
);
