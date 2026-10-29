import { configureTestTenancy } from "../support/tenant-test.ts";
import assert from "node:assert/strict";
import { test } from "../support/tenant-test.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../../src/runs/background-ownership.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const databaseUrl = process.env.DATABASE_URL;
test("a fresh record has no owner and the first set records who set it and when", async () => {
  const store = createBackgroundOwnershipStore(testDatabaseUrl());
  assert.deepEqual(await store.get(), { ownerDeploymentId: null, setAt: null, setBy: null });
  const before = Date.now();
  const state = await store.set({ ownerDeploymentId: "a", setBy: "a" });
  assert.equal(state.ownerDeploymentId, "a");
  assert.equal(state.setBy, "a");
  assert.ok(Date.parse(state.setAt!) >= before);
  assert.deepEqual(await store.get(), state);
});

test("compare-and-swap refuses a stale expectation but accepts an idempotent retry", async () => {
  const store = createBackgroundOwnershipStore(testDatabaseUrl());
  await store.set({ ownerDeploymentId: "a", setBy: "a" });
  await assert.rejects(store.set({ ownerDeploymentId: "b", expectedOwnerDeploymentId: null, setBy: "b" }), /changed/);
  assert.equal((await store.get()).ownerDeploymentId, "a");
  const handover = await store.set({ ownerDeploymentId: "b", expectedOwnerDeploymentId: "a", setBy: "b" });
  assert.equal(handover.ownerDeploymentId, "b");
  const retried = await store.set({ ownerDeploymentId: "b", expectedOwnerDeploymentId: "a", setBy: "b" });
  assert.deepEqual(retried, handover);
  const paused = await store.set({ ownerDeploymentId: null, expectedOwnerDeploymentId: "b", setBy: "b" });
  assert.equal(paused.ownerDeploymentId, null);
  assert.equal(paused.setBy, "b");
});

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
  "the job worker resumes polling without terminating a prior generation's job",
  { skip: !databaseUrl, timeout: 20_000 },
  async () => {
    const { createJobWorker } = await import("../../src/jobs/job-worker.ts");
    await configureTestTenancy(databaseUrl!);
    const queue = createJobWorker(databaseUrl!);
    const oldEntered = Promise.withResolvers<void>();
    const oldFinish = Promise.withResolvers<void>();
    const newEntered = Promise.withResolvers<void>();
    let oldFinished = false;
    const run = `${Date.now()}`;
    queue.handle("generation-test", async (params) => {
      if ((params as { old: boolean }).old) {
        oldEntered.resolve();
        await oldFinish.promise;
        oldFinished = true;
      } else newEntered.resolve();
      return "done";
    });
    try {
      await queue.start();
      await queue.spawn("generation-test", { old: true }, `old-${run}`);
      await oldEntered.promise;
      await queue.stopClaims();
      assert.equal(oldFinished, false);
      await queue.start();
      await queue.spawn("generation-test", { old: false }, `new-${run}`);
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
    const { setBackgroundOwner } = await import("../../cli/src/background-work.ts");
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
