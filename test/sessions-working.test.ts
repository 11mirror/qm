import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import type { Principal } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testConfig } from "./support/test-config.ts";
import { appTurns, claimTurn, finishTurn } from "./support/turns.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-working-"));
  return buildApp(testConfig({ dataDir }));
}

async function chat(sessions: ReturnType<typeof freshApp>["sessions"], threadRef: string): Promise<string> {
  const session = await sessions.getOrCreateByThread(threadRef, "dm", "personal:U1");
  await sessions.addParticipant(session.id, "U1");
  await sessions.updateTitle(session.id, threadRef);
  return session.id;
}

function enqueueRequest(): OrchestratorInput {
  const principal: Principal = { id: "internal:U1", type: "internal" };
  return {
    actor: principal,
    conversation: { kind: "dm", threadRef: "t", audience: [principal] },
    origin: { kind: "direct" },
    text: "working",
  };
}

test("listSessions flags a session with an in-flight turn as working", async () => {
  const { app, runs, sessions } = freshApp();

  await chat(sessions, "web:U1:idle");

  const busyThread = "web:U1:busy";
  const busyId = await chat(sessions, busyThread);
  assert.notEqual(busyId, busyThread, "session UUID and threadRef are distinct (the trap)");
  await runs.enqueue({ sessionId: busyThread, request: enqueueRequest() });

  const list = await app.listSessions("U1");
  const busyRow = list.find((s) => s.threadRef === busyThread);
  const idleRow = list.find((s) => s.threadRef === "web:U1:idle");

  assert.equal(busyRow?.working, true, "the session with an in-flight run is flagged working");
  assert.ok(idleRow, "the idle session is still listed");
  assert.ok(!idleRow!.working, "a settled session is not flagged");
});

test("the working flag clears once the in-flight run settles", async () => {
  const built = freshApp();
  const { app, runs, sessions } = built;
  const turnLedger = appTurns(built);
  const thread = "web:U1:settle";
  await chat(sessions, thread);
  await runs.enqueue({ sessionId: thread, request: enqueueRequest() });

  assert.equal((await app.listSessions("U1")).find((r) => r.threadRef === thread)?.working, true);

  const claimed = await claimTurn(turnLedger);
  assert.equal(claimed?.run.sessionId, thread, "the run is keyed by threadRef");
  await finishTurn(claimed!, { status: "ok", reply: "done" });

  assert.ok(
    !(await app.listSessions("U1")).find((r) => r.threadRef === thread)?.working,
    "the flag clears once the run is terminal",
  );
});

test("listSessions flags a subagent whose latest turn failed, and only while it stays failed", async () => {
  const built = freshApp();
  const { app, runs, sessions } = built;
  const turnLedger = appTurns(built);
  const parent = await chat(sessions, "web:U1:parent");
  const child = await chat(sessions, "web:U1:child");
  const loose = await chat(sessions, "web:U1:loose");
  await sessions.setParentSession(child, parent);

  for (const thread of ["web:U1:child", "web:U1:loose"]) {
    await runs.enqueue({ sessionId: thread, request: enqueueRequest() });
    const claimed = await claimTurn(turnLedger);
    await finishTurn(claimed!, { status: "failed", reason: "boom" });
  }

  const list = await app.listSessions("U1");
  assert.equal(list.find((s) => s.id === child)?.lastTurnFailed, true);
  assert.ok(!list.find((s) => s.id === loose)?.lastTurnFailed, "only subagents carry the flag");

  await runs.enqueue({ sessionId: "web:U1:child", request: enqueueRequest() });
  const retry = await claimTurn(turnLedger);
  await finishTurn(retry!, { status: "ok", reply: "fine" });
  assert.ok(!(await app.listSessions("U1")).find((s) => s.id === child)?.lastTurnFailed);
});

test("sidebar batches visible goals from the session rows and drops inactive ones", async () => {
  const { app, sessions, runs } = freshApp();
  const visible: string[] = [];
  const refs: string[] = [];
  for (const [index, owner] of ["U1", "U1", "hidden"].entries()) {
    const ref = `web:${owner}:batch:${index}`;
    const session = await sessions.getOrCreateByThread(ref, "dm", `personal:${owner}`);
    await sessions.addParticipant(session.id, owner);
    const { lease } = await sessions.acquireLease(session.id);
    assert.ok(lease);
    await sessions.setGoal(lease, {
      objective: `goal ${index}`,
      status: index === 1 ? "complete" : "active",
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 1,
      activeMs: 123,
    });
    await sessions.releaseLease(lease);
    await runs.enqueue({ sessionId: ref, request: enqueueRequest() });
    if (owner === "U1") {
      visible.push(session.id);
      refs.push(ref);
    }
  }
  const goals = sessions.goals.bind(sessions);
  const latest = runs.latestForThreads.bind(runs);
  let reads = 0;
  let runReads = 0;
  sessions.goals = async (ids) => {
    reads++;
    assert.deepEqual(new Set(ids), new Set(visible));
    return goals(ids);
  };
  runs.latestForThreads = async (ids, opts) => {
    runReads++;
    assert.deepEqual(new Set(ids), new Set(refs));
    return latest(ids, opts);
  };
  const list = await app.listSessions("U1");
  assert.deepEqual({ reads, runReads }, { reads: 1, runReads: 1 });
  assert.equal(list.length, 2);
  assert.equal(list.find((row) => row.id === visible[0])?.goal?.objective, "goal 0");
  assert.equal(list.find((row) => row.id === visible[0])?.goal?.activeMs, 123);
  assert.equal(list.find((row) => row.id === visible[1])?.goal, undefined);
});
