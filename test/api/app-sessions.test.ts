import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { dmFor } from "../support/dm-turn.ts";
import type { Principal, TurnRequest } from "../../src/types.ts";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import { claimTurn, finishTurn } from "../support/turns.ts";
import { projectGroupRef, projectScopeId } from "../../src/projects/project-store.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-sessions-"));
  return buildApp(testConfig({ dataDir }));
}

const actor = { externalId: "U1" };
const dm = dmFor(actor);

const BLOCKED_CMD = ["git", "push", `--${"force"}`, "origin", "main"].join(" ");

test("listSessions flags a session whose turn paused on a blocking approval", async () => {
  const { app } = freshApp();

  await app.turn(dm("Just a question", "web:U1:done"));

  const paused = await app.turn(dm(`!run ${BLOCKED_CMD}`, "dm:U1:waiting"));
  assert.equal(paused.status, "pending_approval");
  const waitingId = paused.sessionId!;
  assert.ok(waitingId);

  const list = await app.listSessions("U1");
  const waiting = list.find((s) => s.id === waitingId);
  const done = list.find((s) => s.threadRef === "web:U1:done");

  assert.equal(waiting?.awaitingInput, true, "the paused session is flagged");
  assert.ok(done, "the completed session is still listed");
  assert.ok(!done!.awaitingInput, "a completed session is not flagged");
});

test("the awaitingInput flag clears once the pending approval is resolved", async () => {
  const { app } = freshApp();
  const paused = await app.turn(dm(`!run ${BLOCKED_CMD}`, "dm:U1:resolve"));
  assert.equal(paused.status, "pending_approval");
  const sid = paused.sessionId!;
  const requestId = paused.pendingApprovals?.[0]?.requestId;
  assert.ok(requestId);

  assert.equal((await app.listSessions("U1")).find((s) => s.id === sid)?.awaitingInput, true);

  await app.turn({
    origin: { kind: "direct" },
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:resolve" },
    text: "",
    approval: { requestId: requestId!, approved: false },
  });

  assert.ok(
    !(await app.listSessions("U1")).find((s) => s.id === sid)?.awaitingInput,
    "the flag clears after the approval is denied",
  );
});

async function strandShell(sessions: ReturnType<typeof freshApp>["sessions"], threadRef: string): Promise<string> {
  const s = await sessions.getOrCreateByThread(threadRef, "dm", "personal:U1");
  await sessions.addParticipant(s.id, "U1");
  return s.id;
}

test("listSessions hides a stranded entry-less session", async () => {
  const { app, sessions } = freshApp();

  await app.turn(dm("Just a question", "web:U1:real"));
  const strandedId = await strandShell(sessions, "web:U1:stranded");

  const list = await app.listSessions("U1");
  assert.ok(
    list.find((s) => s.threadRef === "web:U1:real"),
    "the real conversation is listed",
  );
  assert.ok(!list.find((s) => s.id === strandedId), "the entry-less shell is not");

  const raw = await sessions.listByParticipant("U1");
  assert.equal(raw.find((s) => s.id === strandedId)?.hasEntries, false);
});

test("an entry-less session with an in-flight turn stays visible", async () => {
  const { app, sessions, runs, turnLedger } = freshApp();

  const thread = "web:U1:fresh";
  const id = await strandShell(sessions, thread);
  await runs.enqueue({ sessionId: thread, request: enqueueRequest(thread, "hi") });

  const row = (await app.listSessions("U1")).find((s) => s.id === id);
  assert.equal(row?.working, true, "a brand-new chat is visible (and working) while its first turn runs");

  const claimed = await claimTurn(turnLedger);
  await finishTurn(claimed!, { status: "failed", reason: "boom" });

  assert.ok(
    !(await app.listSessions("U1")).find((s) => s.id === id),
    "once the failed turn settles with nothing written, the shell disappears",
  );
});

test("a titled entry-less session stays listed", async () => {
  const { app, sessions } = freshApp();

  const id = await strandShell(sessions, "web:U1:titled");
  await sessions.updateTitle(id, "Planning (fork)");

  assert.ok(
    (await app.listSessions("U1")).find((s) => s.id === id),
    "a title marks the session deliberately created, so it is listed even with no entries",
  );
});

test("a turn refused with 'session busy' does not surface a stranded shell", async () => {
  const { app, sessions } = freshApp();

  const thread = "web:U1:busy-race";
  const shell = await sessions.getOrCreateByThread(thread, "dm", "personal:U1");
  const { lease: held } = await sessions.acquireLease(shell.id);
  assert.ok(held);

  const outcome = await app.turn(dm("hello again", thread));
  assert.equal(outcome.status, "refused");
  assert.equal((outcome as { refusalKind?: string }).refusalKind, "session_busy");

  const raw = await sessions.listByParticipant("U1");
  assert.equal(raw.find((s) => s.id === shell.id)?.hasEntries, false, "the shell exists, participant attached");
  assert.ok(!(await app.listSessions("U1")).find((s) => s.id === shell.id), "but it is not listed");
});

test("context cards do not count hidden shells or treat them as shared-scope authority", async () => {
  const { app, sessions } = freshApp();

  await app.turn(dm("real conversation", "web:U1:ctx-real"));
  await strandShell(sessions, "web:U1:ctx-stranded");

  const personal = (await app.listContexts("U1")).find((c) => c.kind === "personal");
  assert.equal(personal?.sessionCount, 1, "the stranded shell is not counted");

  const g = await sessions.getOrCreateByThread("grp:G1", "group", "group:G1");
  await sessions.addParticipant(g.id, "U1");
  const group = (await app.listContexts("U1")).find((c) => c.scopeId === "group:G1");
  assert.equal(group, undefined);
});

test("a session becomes visible once its first entry lands", async () => {
  const { app, sessions } = freshApp();

  const thread = "web:U1:lands";
  const id = await strandShell(sessions, thread);
  assert.ok(!(await app.listSessions("U1")).find((s) => s.id === id));

  const outcome = await app.turn(dm("hello", thread));
  assert.equal(outcome.sessionId, id, "the turn reuses the existing shell");
  assert.ok(
    (await app.listSessions("U1")).find((s) => s.id === id),
    "listed once the transcript exists",
  );
});

/** A listed session with no turn run yet, so the app's turn runner stays idle and tests can claim by hand. */
async function chat(sessions: ReturnType<typeof freshApp>["sessions"], threadRef: string): Promise<string> {
  const session = await sessions.getOrCreateByThread(threadRef, "dm", "personal:U1");
  await sessions.addParticipant(session.id, "U1");
  await sessions.updateTitle(session.id, threadRef);
  return session.id;
}

function enqueueRequest(threadRef = "t", text = "working"): OrchestratorInput {
  const principal: Principal = { id: "internal:U1", type: "internal" };
  return {
    actor: principal,
    conversation: { kind: "dm", threadRef, audience: [principal] },
    origin: { kind: "direct" },
    text,
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
  const { app, runs, sessions, turnLedger } = freshApp();
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
  const { app, runs, sessions, turnLedger } = freshApp();
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

test("background output selects the recorded private resource and fails closed when it is unavailable", async () => {
  const built = buildApp(testConfig({}));
  try {
    const root = await built.app.turn(dm("Start", "resource-output"));
    const resource = await built.sandboxResources.create("U1", "personal:U1", "sprites", "Worker");
    const fallback = await built.sandboxResources.create("U1", "personal:U1", "sprites", "Default");
    await built.sandboxResources.setDefault("U1", "personal:U1", fallback.id);
    await built.processes!.register({ ...registryRow("private-output", "resource-output"), sandboxId: resource.id });
    let selected: string | undefined;
    const provision = built.sandbox.provision.bind(built.sandbox);
    built.sandbox.provision = (layers, options) => {
      selected = options?.sandboxId;
      return provision(layers, options);
    };
    let reads = 0;
    built.sandbox.readProcess = async () => {
      reads++;
      return { chunks: "private output", cursor: 14, status: { state: "exited", code: 0 } };
    };
    const output = await built.app.readSessionBackgroundOutput(root.sessionId!, "private-output", "U1", 0);
    assert.equal(output?.chunk, "private output");
    assert.equal(selected, resource.id);
    await built.processes!.markStatus("private-output", "exited");
    await built.sandboxResources.retire("U1", resource.id);
    await assert.rejects(built.app.readSessionBackgroundOutput(root.sessionId!, "private-output", "U1", 0), /retired/);
    assert.equal(reads, 1);
    assert.equal(selected, resource.id);
  } finally {
    await built.runtime.stop();
  }
});

function registryRow(
  processId: string,
  sessionRef: string | undefined,
  over: Partial<{ kind: "build" | "dev-server" | "background"; ttlMs: number }> = {},
) {
  return {
    processId,
    scopeId: "personal:U1",
    kind: over.kind ?? ("background" as const),
    command: "sleep 600",
    sandboxId: "sandbox-1",
    ttlMs: over.ttlMs ?? 60_000,
    ...(sessionRef ? { sessionRef } : {}),
  };
}

function watchInput(
  threadRef: string,
  over: Partial<{ expiresAt: number; pattern: string; instructions: string }> = {},
) {
  return {
    ownerScopeId: "personal:U1" as const,
    owner: "U1",
    createdBy: "U1",
    processId: "p-watch",
    command: "npm test",
    threadRef,
    expiresAt: over.expiresAt ?? Date.now() + 60_000,
    ...(over.pattern ? { pattern: over.pattern } : {}),
    ...(over.instructions ? { instructions: over.instructions } : {}),
  };
}

test("listSessions counts detached work per conversation — live jobs and armed watches, keyed by threadRef", async () => {
  const { app, processes, monitors } = freshApp();
  assert.ok(processes, "test sandbox supports process sessions");

  const busy = "web:U1:busy";
  const idle = "web:U1:idle";
  await app.turn(dm("kick off something long", busy));
  await app.turn(dm("just a question", idle));

  await processes!.register(registryRow("p-1", busy));
  await processes!.register(registryRow("p-2", busy));
  await monitors.create(watchInput(busy));

  await processes!.register(registryRow("p-devserver", busy, { kind: "dev-server" }));
  await processes!.register(registryRow("p-expired", busy, { ttlMs: -1 }));
  const exited = await processes!.register(registryRow("p-exited", busy));
  await processes!.markStatus(exited.processId, "exited");
  await processes!.register(registryRow("p-unowned", undefined));
  await monitors.create(watchInput(busy, { expiresAt: Date.now() - 1 }));

  const list = await app.listSessions("U1");
  const busyRow = list.find((s) => s.threadRef === busy);
  const idleRow = list.find((s) => s.threadRef === idle);
  assert.equal(busyRow?.backgroundJobs, 2, "live background jobs, this conversation's only");
  assert.equal(busyRow?.watches, 1, "armed unexpired watches only");
  assert.equal(idleRow?.backgroundJobs, undefined, "clean rows carry no zero-count fields");
  assert.equal(idleRow?.watches, undefined);
});

test("sessionBackground spells the badge out for the viewer — and stays invisible to strangers", async () => {
  const { app, processes, monitors } = freshApp();
  const thread = "web:U1:inspect";
  const r = await app.turn(dm("start the job", thread));
  const sessionId = r.sessionId!;

  await processes!.register({ ...registryRow("p-1", thread), purpose: "Preview app server" });
  await monitors.create(watchInput(thread, { pattern: "error|FAILED", instructions: "summarize failures" }));

  const view = await app.sessionBackground(sessionId, "U1");
  assert.equal(view?.jobs.length, 1);
  assert.equal(view?.jobs[0]?.processId, "p-1");
  assert.equal(view?.jobs[0]?.command, "sleep 600");
  assert.equal(view?.jobs[0]?.purpose, "Preview app server");
  assert.ok((view?.jobs[0]?.expiresAt ?? 0) > Date.now(), "jobs carry their TTL deadline");
  assert.equal(view?.watches.length, 1);
  assert.equal(view?.watches[0]?.pattern, "error|FAILED");
  assert.equal(view?.watches[0]?.instructions, "summarize failures");

  assert.equal(await app.sessionBackground(sessionId, "U2"), null, "not the viewer's session — not even a 404 hint");
  assert.equal(await app.sessionBackground("nope", "U1"), null);
});

test("readSessionBackgroundOutput binds the job to the conversation, not just the scope", async () => {
  const { app, processes } = freshApp();
  const mine = "web:U1:mine";
  const other = "web:U1:other";
  const r1 = await app.turn(dm("conversation A", mine));
  const r2 = await app.turn(dm("conversation B", other));

  await processes!.register(registryRow("p-mine", mine));
  await processes!.register(registryRow("p-other", other));

  assert.equal(await app.readSessionBackgroundOutput(r1.sessionId!, "p-other", "U1", 0), null);
  assert.equal(await app.readSessionBackgroundOutput(r2.sessionId!, "p-other", "U2", 0), null);
  assert.equal(await app.readSessionBackgroundOutput(r1.sessionId!, "p-ghost", "U1", 0), null);
});

function cronInput(target: string | undefined, action: string) {
  return {
    ownerScopeId: "personal:U1" as const,
    owner: "U1",
    createdBy: "U1",
    schedule: { everyMs: 60_000 },
    action,
    ...(target ? { destination: { type: "web", target } } : {}),
  };
}

test("listSessions counts session-targeted crons — enabled and unarchived only, keyed by destination target", async () => {
  const { app, crons } = freshApp();
  const here = "web:U1:cronned";
  const elsewhere = "web:U1:plain";
  await app.turn(dm("watch my PR", here));
  await app.turn(dm("nothing scheduled", elsewhere));

  await crons.create(cronInput(here, "check the pipeline"));
  await crons.create(cronInput(here, "refresh the dashboard"));
  const paused = await crons.create(cronInput(here, "poll the checks"));
  await crons.setEnabled(paused.id, false);
  const archived = await crons.create(cronInput(here, "sweep the queue"));
  await crons.update(archived.id, { archived: true });
  await crons.create(cronInput(undefined, "cron with no destination"));
  await crons.create(cronInput("slack:C123", "cron aimed elsewhere"));

  const list = await app.listSessions("U1");
  const hereRow = list.find((s) => s.threadRef === here);
  const plainRow = list.find((s) => s.threadRef === elsewhere);
  assert.equal(hereRow?.crons, 2, "enabled, unarchived crons aimed at this conversation");
  assert.equal(plainRow?.crons, undefined, "clean rows carry no zero-count fields");
});

test("sessionBackground lists the session's crons alongside jobs and watches", async () => {
  const { app, crons } = freshApp();
  const thread = "web:U1:cron-inspect";
  const r = await app.turn(dm("schedule it", thread));

  const made = await crons.create({ ...cronInput(thread, "watch PR checks"), title: "PR watch" });
  const paused = await crons.create(cronInput(thread, "poll the checks"));
  await crons.setEnabled(paused.id, false);

  const view = await app.sessionBackground(r.sessionId!, "U1");
  assert.equal(view?.crons.length, 1);
  assert.equal(view?.crons[0]?.id, made.id);
  assert.equal(view?.crons[0]?.title, "PR watch");
  assert.ok(view?.crons[0]?.nextFireAt, "carries the next fire time");
});

function directTurn(text: string, thread: string, externalId: string): TurnRequest {
  return {
    origin: { kind: "direct" },
    surface: "test",
    actor: { externalId },
    conversation: { kind: "dm", threadRef: thread },
    text,
  };
}

test("getSessionForViewer withholds metadata from a non-participant (no session-metadata IDOR)", async () => {
  const { app } = freshApp();

  const outcome = await app.turn(directTurn("my private question", "web:alice:private", "alice"));
  const sessionId = outcome.sessionId!;
  assert.ok(sessionId);

  const asAlice = await app.getSessionForViewer(sessionId, "alice");
  assert.ok(asAlice, "the owner reads her own session");
  assert.equal(asAlice!.session.id, sessionId);
  assert.equal(asAlice!.session.threadRef, "web:alice:private");

  const asCarol = await app.getSessionForViewer(sessionId, "carol");
  assert.equal(asCarol, null, "a non-participant cannot read the session row");
});

test("the single-session read applies the managed-project check the session list applies", async () => {
  const built = freshApp();
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  const project = await built.projects.create({ name: "Launch Cohort", ownerId: "owner" });
  const groupRef = projectGroupRef(project.id);

  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  const outcome = await built.app.turn({
    origin: { kind: "direct" },
    surface: "web",
    actor: { externalId: "member" },
    conversation: { kind: "group", channelRef: groupRef, threadRef: "web:member:project" },
    text: "!run git push --force origin main",
  });
  assert.equal(outcome.status, "pending_approval", "the member's own turn parks on an approval only they can read");
  const sessionId = outcome.sessionId!;
  assert.ok(sessionId);

  assert.ok(await built.sessions.getForParticipant(sessionId, "member"), "the member is a participant of the row");
  assert.ok(await built.app.getSessionForViewer(sessionId, "member"), "a project member reads the session");
  assert.ok(
    (await built.app.listSessionApprovals(sessionId, "member")).length,
    "and reads the pending approval while membership stands",
  );
  assert.ok(
    (await built.app.listSessions("member")).some((session) => session.id === sessionId),
    "the list agrees while membership stands",
  );

  assert.ok((await built.app.searchSessions("member", "push")).some((hit) => hit.sessionId === sessionId));
  assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");
  assert.deepEqual(await built.app.searchSessions("member", "push"), []);
  assert.ok(
    await built.sessions.getForParticipant(sessionId, "member"),
    "the participant row outlives the project membership, so the project check is what must reject",
  );
  assert.equal(
    await built.app.getSessionForViewer(sessionId, "member"),
    null,
    "a dropped project member cannot read the session one at a time",
  );
  assert.equal(await built.app.getSessionItemForViewer(sessionId, "member", 1), null, "nor a single item");
  assert.equal(await built.app.sessionBackground(sessionId, "member"), null, "nor its background work");
  assert.equal(await built.app.updateSession(sessionId, "member", { title: "stolen" }), null, "nor rename it");
  assert.ok(
    !(await built.app.listSessions("member")).some((session) => session.id === sessionId),
    "the list rejects it too, so both paths agree",
  );
});

test("a dropped project member cannot discard or retitle a session they can no longer read", async () => {
  const built = freshApp();
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  const project = await built.projects.create({ name: "Launch Cohort", ownerId: "owner" });
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");

  const spawned = await built.app.spawnSession("owner", { scopeId: projectScopeId(project.id) });
  const sessionId = spawned!.session.id;
  assert.ok(await built.app.getSessionForViewer(sessionId, "member"), "a project member reads the empty shell");

  assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");
  assert.ok(
    await built.sessions.getForParticipant(sessionId, "member"),
    "the participant row outlives the project membership",
  );
  assert.equal(await built.app.regenerateTitle(sessionId, "member"), null, "no retitling a session they cannot read");
  assert.equal(await built.app.discardSession(sessionId, "member"), false, "no discarding it either");
  assert.ok(await built.sessions.get(sessionId), "the session survives the refused discard");
  assert.equal(await built.app.discardSession(sessionId, "owner"), true, "the owner can still discard it");
});
