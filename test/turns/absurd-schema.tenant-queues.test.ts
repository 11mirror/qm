import { before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { TURN_QUEUES, ensureTenantQueues, registerAbsurdSchema, tenantQueue } from "../../src/turns/absurd-schema.ts";
import { claimTasks, spawnTask } from "../../src/turns/absurd.ts";
import { tenantFor, withTenant } from "../../src/tenant.ts";

const URL = process.env.DATABASE_URL!;

const acme = tenantFor("acme", "7d3f5e1a-0000-4000-8000-00000000a001", "acme");
const beta = tenantFor("beta", "9a1b2c3d-0000-4000-8000-00000000b002", "beta");

let pool: pg.Pool;

before(async () => {
  pool = new pg.Pool({ connectionString: URL, max: 4 });
  await registerAbsurdSchema(URL).pool();
});

test("tenants in one process claim only their own turn tasks", async (t) => {
  const queues = [acme, beta].flatMap((each) => TURN_QUEUES.map((queue) => tenantQueue(queue, each.id)));
  t.after(async () => {
    for (const queue of queues) await pool.query("SELECT absurd.drop_queue($1)", [queue]);
    await pool.end();
  });
  for (const each of [acme, beta]) await withTenant(each, () => ensureTenantQueues(URL));
  const spawned = await withTenant(acme, () =>
    spawnTask(pool, "turns_people", "turn", { turn: "acme-1" }, { maxAttempts: 1 }),
  );
  const stolen = await withTenant(beta, () => claimTasks(pool, "turns_people", "beta-worker", 60));
  assert.equal(stolen.length, 0);
  const [claimed] = await withTenant(acme, () => claimTasks(pool, "turns_people", "acme-worker", 60));
  assert.equal(claimed?.taskId, spawned.taskId);
  assert.deepEqual(claimed?.params, { turn: "acme-1" });
});
