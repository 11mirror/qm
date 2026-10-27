import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import type { RunPriority } from "../../src/runs/run-store.ts";
import { claimTurn, testRunStore } from "../support/turns.ts";

const store = testRunStore();
const admin = new pg.Pool({ connectionString: store.databaseUrl });
after(async () => {
  await store.close();
  await admin.end();
});

function request(thread: string, text = "hello"): OrchestratorInput {
  return {
    surface: "web",
    text,
    actor: { id: "alice@example.com", externalId: "alice@example.com", displayName: "Alice" },
    conversation: { kind: "dm", threadRef: thread },
    origin: { kind: "human" },
  } as unknown as OrchestratorInput;
}

async function legacyRun(
  thread: string,
  status: "pending" | "running",
  opts: { leaseExpiresAt?: number; priority?: RunPriority; attempts?: number } = {},
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO runs(id, session_id, status, request, attempts, max_attempts, created_at, claim_priority,
       lease_token, lease_expires_at, worker_id, started_at)
     VALUES ($1, $2, $3, $4, $5, 3, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      thread,
      status,
      JSON.stringify(request(thread)),
      opts.attempts ?? (status === "running" ? 1 : 0),
      Date.now(),
      opts.priority ?? 0,
      status === "running" ? randomUUID() : null,
      status === "running" ? (opts.leaseExpiresAt ?? Date.now() - 1_000) : null,
      status === "running" ? "w-old" : null,
      status === "running" ? Date.now() - 5_000 : null,
    ],
  );
  return id;
}

async function row(id: string) {
  const { rows } = await admin.query("SELECT engine, status, absurd_queue, last_stop FROM runs WHERE id = $1", [id]);
  return rows[0] as { engine: string; status: string; absurd_queue: string | null; last_stop: string | null };
}

test("a pending legacy run becomes an Absurd turn and starts", async () => {
  const thread = `web:adopt-pending:${randomUUID()}`;
  const id = await legacyRun(thread, "pending", { priority: 2 });
  assert.ok((await store.ledger.adoptLegacy()) >= 1);
  assert.deepEqual(await row(id), {
    engine: "absurd",
    status: "pending",
    absurd_queue: "turns_background",
    last_stop: null,
  });
  const claimed = await claimTurn(store.ledger, id);
  assert.equal(claimed?.run.id, id, "the adopted run is claimable on its queue");
  await store.ledger.finish(claimed!.run, claimed!.token, {
    status: "done",
    result: { status: "ok", sessionId: thread, reply: "done" },
  });
  assert.equal((await store.runs.get(id))?.status, "done");
});

test("a running legacy run whose lease lapsed resumes on Absurd as an interrupted turn", async () => {
  const thread = `web:adopt-lapsed:${randomUUID()}`;
  const id = await legacyRun(thread, "running", { leaseExpiresAt: Date.now() - 1_000 });
  await store.ledger.adoptLegacy();
  const adopted = await row(id);
  assert.equal(adopted.engine, "absurd");
  assert.equal(adopted.status, "pending");
  assert.deepEqual(JSON.parse(adopted.last_stop!), { kind: "lease_expired" });
  const claimed = await claimTurn(store.ledger, id);
  assert.equal(claimed?.run.attempts, 2, "the earlier attempt still counts");
  assert.equal(claimed?.run.lastStop?.kind, "lease_expired");
});

test("a legacy run an old process still holds is left alone, and new turns wait behind it", async () => {
  const thread = `web:adopt-held:${randomUUID()}`;
  const held = await legacyRun(thread, "running", { leaseExpiresAt: Date.now() + 60_000 });
  const { run: queued } = await store.runs.enqueue({ sessionId: thread, request: request(thread, "next") });
  assert.equal(queued.status, "queued", "a new turn does not start beside a live legacy turn");
  await store.ledger.adoptLegacy();
  assert.equal((await row(held)).engine, "legacy");
  assert.equal((await row(queued.id)).status, "queued");

  await admin.query("UPDATE runs SET status = 'done', lease_token = NULL, finished_at = $2 WHERE id = $1", [
    held,
    Date.now(),
  ]);
  await store.ledger.adoptLegacy();
  assert.equal((await row(queued.id)).status, "pending", "once the old process finishes, the queued turn starts");
});
