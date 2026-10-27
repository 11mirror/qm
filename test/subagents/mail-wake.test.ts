import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createSessionSyscalls } from "../../src/subagents/session-tools.ts";
import { deliverSubagentMail } from "../../src/subagents/mail.ts";
import { delegatedAuthorizationOrigin } from "../../src/subagents/delegation.ts";
import { createMailWaker } from "../../src/subagents/mail-wake.ts";
import { createSessionMailbox } from "../../src/sessions/session-mailbox.ts";
import { mailJobExit } from "../../src/processes/job-exit-mail.ts";
import type { Run } from "../../src/runs/run-store.ts";
import type { Session } from "../../src/types.ts";
import { claimTurn, completeTurn, finishTurn } from "../support/turns.ts";
import { actor, conversation, scope, rig, freshSession, closeRigStores, type Rig } from "../support/subagent-rig.ts";

after(closeRigStores);

async function rootTurn(r: Rig) {
  const root = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, surface: "slack", origin: { kind: "human" }, addressed: true, text: "work" },
  });
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { ...root.run.request, runId: root.run.id },
  });
  return { root: root.run, api };
}

function apiFor(r: Rig, session: Session, run: Run) {
  return createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session,
    scopeId: scope,
    request: { ...run.request, runId: run.id },
  });
}

const mailWakes = async (r: Rig, session: Session) =>
  (await r.runs.inFlightForThread(session.threadRef)).filter((run) => run.request.wakeCause === "mail");

test("a nested coordinator that ended its turn is woken by its child's result and reports once", async () => {
  const r = await rig();
  const { root, api } = await rootTurn(r);
  const opened = await api.open({ task: "coordinate" });
  assert.ok(opened.ok);
  const coord = await freshSession(r.sessions, opened.sessionId);
  const coordRun = (await r.runs.inFlightForThread(coord.threadRef))[0]!;
  const coordTurn = (await claimTurn(r.ledger, coordRun.id))!;
  const worker = await apiFor(r, coord, coordRun).open({ task: "slow part" });
  assert.ok(worker.ok);
  await finishTurn(coordTurn, { status: "ok", reply: "the slow part is running in a subagent" });
  await completeTurn(r.ledger, root.id, { status: "silent" });
  await deliverSubagentMail(r, (await r.runs.get(coordRun.id))!);
  const [rootWake] = await mailWakes(r, r.room);
  assert.match(rootWake!.request.text, /slow part is running/);

  const workerSession = await freshSession(r.sessions, worker.sessionId);
  const workerRun = (await r.runs.inFlightForThread(workerSession.threadRef))[0]!;
  await completeTurn(r.ledger, workerRun.id, { status: "ok", reply: "slow part done" });
  await deliverSubagentMail(r, (await r.runs.get(workerRun.id))!);
  const [wake] = await mailWakes(r, coord);
  assert.ok(wake, "the idle coordinator is woken");
  assert.match(wake.request.text, /slow part done/);
  assert.equal(wake.request.delegatingRunId, coordRun.id);
  assert.equal((await delegatedAuthorizationOrigin(wake.request, r))?.kind, "human");
  assert.deepEqual(await r.mailbox.pending(coord.id), []);

  await completeTurn(r.ledger, wake.id, { status: "ok", reply: "all done: slow part done" });
  await deliverSubagentMail(r, (await r.runs.get(wake.id))!);
  const report = await r.mailbox.pending(r.room.id);
  assert.equal(report.length, 1, "the root is busy with its first wake, so the report waits in its mailbox");
  assert.match(report[0]!.text, /all done: slow part done/);
  await completeTurn(r.ledger, rootWake!.id, { status: "silent" });
  await r.waker.wakeThread(r.room.threadRef);
  const [second] = await mailWakes(r, r.room);
  assert.match(second!.request.text, /all done: slow part done/);
});

test("three near-simultaneous child results wake an idle parent once", async () => {
  const r = await rig();
  const { root, api } = await rootTurn(r);
  const runs: Run[] = [];
  for (const task of ["a", "b", "c"]) {
    const opened = await api.open({ task, requestId: task });
    assert.ok(opened.ok);
    const child = await freshSession(r.sessions, opened.sessionId);
    const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
    await completeTurn(r.ledger, run.id, { status: "ok", reply: `${task} done` });
    runs.push((await r.runs.get(run.id))!);
  }
  await completeTurn(r.ledger, root.id, { status: "ok", reply: "delegated" });
  const quiet = createSessionMailbox(r.mailboxUrl);
  await Promise.all(runs.map((run) => deliverSubagentMail({ ...r, mailbox: quiet }, run)));
  await Promise.all([r.waker.wake(r.room.id), r.waker.wake(r.room.id), r.waker.sweep()]);
  const wakes = await mailWakes(r, r.room);
  assert.equal(wakes.length, 1);
  for (const task of ["a", "b", "c"]) assert.match(wakes[0]!.request.text, new RegExp(`${task} done`));
  assert.deepEqual(await r.mailbox.pending(r.room.id), []);
});

test("send_message to an idle session wakes it; to a busy one it waits for the tool boundary", async () => {
  const r = await rig();
  const { root, api } = await rootTurn(r);
  const opened = await api.open({ task: "watch for instructions" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const childRun = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.ok((await api.write({ target: child.id, text: "while busy" })).ok);
  assert.deepEqual(await mailWakes(r, child), []);
  const childTurn = (await claimTurn(r.ledger, childRun.id))!;
  const busyApi = apiFor(r, child, childRun);
  await busyApi.acknowledge!((await busyApi.receive!(0)).map((message) => message.id));
  await finishTurn(childTurn, { status: "ok", reply: "waiting" });
  await r.waker.wakeThread(child.threadRef);
  assert.deepEqual(await mailWakes(r, child), []);
  assert.ok((await api.write({ target: child.id, text: "now go" })).ok);
  const [wake] = await mailWakes(r, child);
  assert.match(wake!.request.text, /now go/);
  assert.equal(wake!.request.actor.id, actor.id);
  await completeTurn(r.ledger, root.id, { status: "silent" });
});

test("mail that arrived while a core was down wakes its idle recipient on the next sweep", async () => {
  const r = await rig();
  const { root } = await rootTurn(r);
  await completeTurn(r.ledger, root.id, { status: "silent" });
  const restarted = createSessionMailbox(r.mailboxUrl);
  await restarted.send({
    id: `late-${r.room.id}`,
    recipientId: r.room.id,
    senderId: r.room.id,
    actor,
    text: "<note>late</note>",
    audience: conversation.audience,
    createdAt: Date.now(),
  });
  assert.deepEqual(await mailWakes(r, r.room), []);
  const waker = createMailWaker({ ...r, lock: r.advisoryLock, maxAttempts: 3 });
  await waker.sweep();
  const [wake] = await mailWakes(r, r.room);
  assert.match(wake!.request.text, /<note>late<\/note>/);
});

test("a background job's exit mails its idle session, which wakes with the exit code and output tail", async () => {
  const r = await rig();
  const { root } = await rootTurn(r);
  await completeTurn(r.ledger, root.id, { status: "silent" });
  await mailJobExit(r, job(r.room, "p-1"), { kind: "exited", code: 1, tail: "2 failing\n" });
  await mailJobExit(r, job(r.room, "p-1"), { kind: "exited", code: 1, tail: "2 failing\n" });
  const wakes = await mailWakes(r, r.room);
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]!.request.text, /run the suite.*exited with code 1/);
  assert.match(wakes[0]!.request.text, /2 failing/);
  assert.equal((await delegatedAuthorizationOrigin(wakes[0]!.request, r))?.kind, "human");
});

test("a job exit leaves a scheduled turn's thread alone", async () => {
  const r = await rig();
  const cron = await r.sessions.getOrCreateByThread("cron:fire:1", "dm", scope, undefined, "cron");
  await r.runs.enqueue({
    sessionId: cron.threadRef,
    request: {
      actor,
      conversation: { ...conversation, threadRef: cron.threadRef },
      surface: "cron",
      origin: { kind: "automation", destination: { type: "slack", target: "D1" } },
      text: "fire",
    },
  });
  await mailJobExit(r, job(cron, "p-2"), { kind: "expired" });
  assert.deepEqual(await r.mailbox.pending(cron.id), []);
});

function job(session: Session, processId: string) {
  return {
    processId,
    scopeId: scope,
    sandboxId: "sandbox-1",
    kind: "background" as const,
    command: "bg: npm test",
    purpose: "run the suite",
    startedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: "running" as const,
    sessionRef: session.threadRef,
  };
}
