import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../../plugins/chassis/src/portal-identity.ts";
import "../../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { attributedSteerText } from "../../../src/api/app-turn-pipeline.ts";
import { CORE_SECRET } from "../../support/core-route-server.ts";
import type { OrchestratorInput } from "../../../src/core/orchestrator.ts";
import type { TurnRequest } from "../../../src/types.ts";
import { completeTurn } from "../../support/turns.ts";
import { serveSignalRoute, request, steererRequest } from "../../support/turn-signal-route.ts";
import { takePending } from "../../support/memory-run-signal-store.ts";

const { built, core, coreSignal } = await serveSignalRoute();

test("core route: signals for a pending run are accepted (abort, steer)", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-accept", request: request("hi") });
  for (const body of [{ kind: "steer", text: "go left" }, { kind: "abort" }]) {
    const r = await coreSignal(run.id, body);
    assert.equal(r.status, 200);
    assert.equal(r.json.accepted, true);
  }
});

test("core route: a steer's ts and request thread through to the signal store", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-fields", request: request("hi", "t-fields") });
  const body = {
    kind: "steer",
    text: "go left",
    ts: "1712.001",
    request: steererRequest("internal:U1", "t-fields", "go left"),
  };
  const r = await coreSignal(run.id, body);
  assert.equal(r.status, 200);
  const [signal] = await takePending(built.signals, run.id);
  assert.ok(signal);
  assert.equal(signal.ts, "1712.001");
  assert.equal(signal.request?.actor.externalId, "internal:U1");
  assert.equal(signal.text, "go left", "the run owner's own steer is not attributed");
});

test("core route: another person's steer is attributed with their display name", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-foreign", request: request("hi", "t-foreign") });
  const r = await coreSignal(run.id, {
    kind: "steer",
    text: "go right",
    ts: "1712.002",
    request: steererRequest("web-eve", "t-foreign", "go right", "Eve Example"),
  });
  assert.equal(r.status, 200);
  const [signal] = await takePending(built.signals, run.id);
  assert.equal(signal?.text, "Eve Example: go right");
  assert.equal(signal?.request?.text, "go right", "the replayable request keeps the steerer's own words");
});

test("core route: a malformed request is rejected 400, and privileged fields are stripped", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-sanitize", request: request("hi", "t-sanitize") });
  const bad = await coreSignal(run.id, { kind: "steer", text: "x", request: { text: "x" } });
  assert.equal(bad.status, 400);

  const smuggled = {
    ...steererRequest("internal:U1", "t-sanitize", "x"),
    origin: { kind: "automation", useOwnerKeychain: true },
    spawned: true,
    unattendedGrants: ["admin-read"],
  };
  const r = await coreSignal(run.id, { kind: "steer", text: "x", request: smuggled });
  assert.equal(r.status, 200);
  const [signal] = await takePending(built.signals, run.id);
  assert.ok(signal?.request);
  assert.deepEqual(signal.request.origin, { kind: "automation" });
  assert.equal("spawned" in signal.request, false);
  assert.equal("unattendedGrants" in signal.request, false);
});

test("core route: a bare steer without a ts gets one minted so harnesses persist it", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-mint", request: request("hi", "t-mint") });
  const r = await coreSignal(run.id, { kind: "steer", text: "keep going" });
  assert.equal(r.status, 200);
  const [signal] = await takePending(built.signals, run.id);
  assert.ok(signal?.ts, "signalRun mints a ts when the caller sends none");
});

test("signalRun attributes a bare steer from a shared-scope viewer who is not the run's owner", async () => {
  await built.app.upsertChannels(
    [{ channelId: "C-STEER", name: "steer-room", isPrivate: true }],
    [
      { channelId: "C-STEER", principalId: "steer-owner" },
      { channelId: "C-STEER", principalId: "steer-member" },
    ],
  );
  await built.app.upsertDirectory([{ principalId: "steer-member", displayName: "Steer Member", type: "internal" }]);
  const threadRef = "shared-steer:C-STEER";
  const owner = { id: "steer-owner", type: "internal" as const };
  const { run } = await built.runs.enqueue({
    sessionId: threadRef,
    request: {
      modelAccount: "company",
      actor: owner,
      conversation: { kind: "channel", channelRef: "C-STEER", threadRef, audience: [owner] },
      origin: { kind: "direct" },
      text: "queued shared work",
    },
  });
  const session = await built.sessions.getOrCreateByThread(threadRef, "channel", "channel:C-STEER", "C-STEER", "web");
  await built.sessions.addParticipant(session.id, "steer-member");
  const outcome = await built.app.signalRun(run.id, { kind: "steer", text: "try harder" }, "steer-member");
  assert.equal(outcome.accepted, true);
  const [signal] = await takePending(built.signals, run.id);
  assert.equal(signal?.text, "Steer Member: try harder");
  assert.ok(signal?.ts);
});

test("core route: a request claiming a different conversation than the run's is refused 400", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-bind", request: request("hi", "t-bind") });
  const r = await coreSignal(run.id, {
    kind: "steer",
    text: "over here instead",
    request: steererRequest("internal:U1", "somewhere-else", "over here instead"),
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, "conversation_mismatch");
  assert.deepEqual(await takePending(built.signals, run.id), []);
});

test("core route: a portal identity that does not match the request actor is refused 403", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-mismatch", request: request("hi", "t-mismatch") });
  const r = await coreSignal(
    run.id,
    {
      kind: "steer",
      text: "as someone else",
      request: steererRequest("mallory", "t-mismatch", "as someone else"),
    },
    { [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "eve", exp: Date.now() + 60_000 }, CORE_SECRET) },
  );
  assert.equal(r.status, 403);
  assert.deepEqual(await takePending(built.signals, run.id), []);
});

test("an orphaned steer with a request replays as the steerer, not the run's owner", async () => {
  const threadRef = `web:web-eve:${crypto.randomUUID()}`;
  const { run } = await built.runs.enqueue({
    sessionId: "t-orphan",
    request: { ...request("hi", "t-orphan"), timezone: "America/New_York" },
  });
  const attachment = { name: "notes.txt", mimetype: "text/plain", sizeBytes: 5, blobId: "blob-1" };
  await built.signals.send(run.id, {
    kind: "steer",
    text: "finish this instead",
    ts: "1712.003",
    request: { ...steererRequest("web-eve", threadRef, "finish this instead"), attachments: [attachment] },
  });
  await completeTurn(built.turnLedger, run.id, { status: "ok", reply: "done" });
  await built.app.replayOrphanedRunSignals(run.id);
  let replayed = await built.runs.activeForThread(threadRef);
  for (let i = 0; !replayed && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    replayed = await built.runs.activeForThread(threadRef);
  }
  assert.ok(replayed, "the steer text was re-enqueued as its own turn");
  assert.equal(replayed!.request.actor.id, "web-eve");
  assert.equal(replayed!.request.text, "finish this instead");
  assert.deepEqual(replayed!.request.attachments, [attachment], "the steer's own files survive the replay");
  assert.equal(replayed!.request.timezone, "America/New_York", "turn options are inherited from the ended run");
});

test("an orphaned steer whose replay fails stays pending for the next replay", async () => {
  const threadRef = `web:web-eve:${crypto.randomUUID()}`;
  const { run } = await built.runs.enqueue({ sessionId: "t-orphan-retry", request: request("hi", "t-orphan-retry") });
  await built.signals.send(run.id, {
    kind: "steer",
    text: "try again later",
    ts: "1712.009",
    request: steererRequest("web-eve", threadRef, "try again later"),
  });
  const turn = built.app.turn;
  built.app.turn = async () => {
    throw new Error("database unavailable");
  };
  try {
    await completeTurn(built.turnLedger, run.id, { status: "ok", reply: "done" });
    await built.app.replayOrphanedRunSignals(run.id);
    assert.equal((await built.signals.pending(run.id)).length, 1, "a failed replay leaves the steer pending");
  } finally {
    built.app.turn = turn;
  }
  await built.app.replayOrphanedRunSignals(run.id);
  assert.deepEqual(await built.signals.pending(run.id), [], "the next replay delivers it");
  let replayed = await built.runs.activeForThread(threadRef);
  for (let i = 0; !replayed && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    replayed = await built.runs.activeForThread(threadRef);
  }
  assert.equal(replayed?.request.text, "try again later");
});

test("an orphaned steer whose own request is refused falls back to replaying on the run's request", async () => {
  const threadRef = "t-orphan-fallback";
  const { run } = await built.runs.enqueue({ sessionId: threadRef, request: request("hi", threadRef) });
  await built.signals.send(run.id, {
    kind: "steer",
    text: "still matters",
    ts: "1712.004",
    request: {
      surface: "web",
      actor: { externalId: "web-eve" },
      conversation: { kind: "group", threadRef: `web:web-eve:${crypto.randomUUID()}`, channelRef: "G-NOPE" },
      text: "still matters",
      origin: { kind: "human" },
    },
  });
  await completeTurn(built.turnLedger, run.id, { status: "ok", reply: "done" });
  await built.app.replayOrphanedRunSignals(run.id);
  let replayed = await built.runs.activeForThread(threadRef);
  for (let i = 0; !replayed && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    replayed = await built.runs.activeForThread(threadRef);
  }
  assert.ok(replayed, "a refused steerer request still replays the text on the run's own request");
  assert.equal(replayed!.request.actor.id, "internal:U1");
  assert.equal(replayed!.request.text, "still matters");
});

test("attributedSteerText prefixes foreign and ambient steers only", () => {
  const eve = { id: "web-eve", displayName: "Eve Example" };
  assert.equal(attributedSteerText(eve, "web-eve", "hello"), "hello");
  assert.equal(attributedSteerText(eve, "web-alice", "hello"), "Eve Example: hello");
  assert.equal(attributedSteerText({ id: "web-eve" }, "web-alice", "hello"), "web-eve: hello");
  assert.equal(attributedSteerText({ id: "web-eve", displayName: "  " }, "web-alice", "hi"), "web-eve: hi");
  assert.equal(attributedSteerText(eve, null, "hello"), "Eve Example: hello");
});

test("core route: steer without text is rejected 400", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-notext", request: request("hi") });
  for (const body of [{ kind: "steer" }, { kind: "steer", text: "   " }]) {
    const r = await coreSignal(run.id, body);
    assert.equal(r.status, 400);
    assert.equal(r.json.accepted, false);
  }
});

test("core route: a bad kind is rejected 400, an unknown run 404", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-bad", request: request("hi") });
  assert.equal((await coreSignal(run.id, { kind: "explode" })).status, 400);
  assert.equal((await coreSignal("no-such-run", { kind: "abort" })).status, 404);
});

test("core route: a terminal run rejects signals with reason=terminal", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-terminal", request: request("hi") });
  await completeTurn(built.turnLedger, run.id, { status: "ok", reply: "done" });
  const r = await coreSignal(run.id, { kind: "abort" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { accepted: false, reason: "terminal" });
});

test("run control follows current shared membership while public history requires an active principal", async () => {
  await built.app.upsertChannels(
    [
      { channelId: "C-RUN", name: "run-room", isPrivate: true },
      { channelId: "C-PUBLIC-RUN", name: "public-run", isPrivate: false },
    ],
    [
      { channelId: "C-RUN", principalId: "shared-owner" },
      { channelId: "C-RUN", principalId: "shared-member" },
    ],
  );
  await built.app.upsertGroups([
    { groupId: "G-RUN", principalId: "shared-owner" },
    { groupId: "G-RUN", principalId: "shared-member" },
  ]);

  for (const shared of [
    { kind: "channel" as const, ref: "C-RUN", scope: "channel:C-RUN" as const },
    { kind: "group" as const, ref: "G-RUN", scope: "group:G-RUN" as const },
  ]) {
    const threadRef = `shared-run:${shared.ref}`;
    const owner = { id: "shared-owner", type: "internal" as const };
    const { run } = await built.runs.enqueue({
      sessionId: threadRef,
      request: {
        modelAccount: "company",
        actor: owner,
        conversation: { kind: shared.kind, channelRef: shared.ref, threadRef, audience: [owner] },
        origin: { kind: "direct" },
        text: "queued shared work",
      },
    });
    const session = await built.sessions.getOrCreateByThread(threadRef, shared.kind, shared.scope, shared.ref, "web");
    await built.sessions.addParticipant(session.id, "shared-member");
    assert.ok(await built.app.getRun(run.id, "shared-member"));
    if (shared.kind === "channel") {
      await built.app.upsertChannels(
        [
          { channelId: "C-RUN", name: "run-room", isPrivate: true },
          { channelId: "C-PUBLIC-RUN", name: "public-run", isPrivate: false },
        ],
        [{ channelId: "C-RUN", principalId: "shared-owner" }],
      );
    } else {
      await built.app.upsertGroups([{ groupId: "G-RUN", principalId: "shared-owner" }]);
    }
    assert.ok(
      await built.app.getSessionForViewer(session.id, "shared-member"),
      "history remains readable through the participant window",
    );
    assert.equal(await built.app.getRun(run.id, "shared-member"), null);
    assert.deepEqual(await built.app.signalRun(run.id, { kind: "abort" }, "shared-member"), {
      accepted: false,
      reason: "not_found",
    });
  }

  const publicMember = "public-history-member";
  const publicThread = "shared-run:public";
  const publicOwner = { id: "public-owner", type: "internal" as const };
  const { run: publicRun } = await built.runs.enqueue({
    sessionId: publicThread,
    request: {
      actor: publicOwner,
      conversation: { kind: "channel", channelRef: "C-PUBLIC-RUN", threadRef: publicThread, audience: [publicOwner] },
      origin: { kind: "direct" },
      text: "queued public work",
    },
  });
  const publicSession = await built.sessions.getOrCreateByThread(
    publicThread,
    "channel",
    "channel:C-PUBLIC-RUN",
    "public-run",
    "web",
  );
  await built.sessions.addParticipant(publicSession.id, publicMember);
  assert.ok(await built.app.getRun(publicRun.id, publicMember));
  await built.identity.deactivate(publicMember);
  assert.equal(await built.app.getRun(publicRun.id, publicMember), null);
  await built.identity.reactivate(publicMember);
});

const coreTurn = (body: unknown) => core.post("/v1/turns", body);

const pageTool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: "Read the rows the user has selected",
  inputSchema: { type: "object", properties: {} },
  ...extra,
});

function turnWithTools(clientTools: unknown, threadRef = `web:internal:U1:${crypto.randomUUID()}`): TurnRequest {
  return {
    origin: { kind: "direct" },
    surface: "web",
    actor: { externalId: "internal:U1" },
    conversation: { kind: "dm", threadRef },
    text: "what have I selected?",
    async: true,
    clientTools: clientTools as TurnRequest["clientTools"],
  };
}

test("core route: malformed clientTools declarations are rejected 400", async () => {
  const cases: Array<[string, unknown]> = [
    ["not an array", { name: "ui__x" }],
    ["core tool name", [pageTool("execute")]],
    ["missing prefix", [pageTool("get_selection")]],
    ["uppercase", [pageTool("ui__GetSelection")]],
    ["too long", [pageTool(`ui__${"a".repeat(61)}`)]],
    ["too many", Array.from({ length: 33 }, (_, i) => pageTool(`ui__tool_${i}`))],
    ["duplicate", [pageTool("ui__get_selection"), pageTool("ui__get_selection")]],
    ["oversize description", [pageTool("ui__x", { description: "d".repeat(2_001) })]],
    ["empty description", [pageTool("ui__x", { description: " " })]],
    ["schema not an object type", [pageTool("ui__x", { inputSchema: { type: "string" } })]],
    ["schema properties not an object", [pageTool("ui__x", { inputSchema: { type: "object", properties: 5 } })]],
    ["schema required not strings", [pageTool("ui__x", { inputSchema: { type: "object", required: [1] } })]],
    ["schema properties an array", [pageTool("ui__x", { inputSchema: { type: "object", properties: [] } })]],
    ["schema combinator", [pageTool("ui__x", { inputSchema: { type: "object", anyOf: [] } })]],
    ["schema not", [pageTool("ui__x", { inputSchema: { type: "object", not: { required: ["a"] } } })]],
    [
      "schema with an unconvertible property",
      [pageTool("ui__x", { inputSchema: { type: "object", properties: { a: { type: "nonsense" } } } })],
    ],
    [
      "schema with a dangling ref",
      [pageTool("ui__x", { inputSchema: { type: "object", properties: { a: { $ref: "#/$defs/missing" } } } })],
    ],
    ["oversize schema", [pageTool("ui__x", { inputSchema: { type: "object", description: "s".repeat(16_000) } })]],
    ["timeout too short", [pageTool("ui__x", { timeoutMs: 999 })]],
    ["timeout too long", [pageTool("ui__x", { timeoutMs: 60_001 })]],
    ["timeout not an integer", [pageTool("ui__x", { timeoutMs: 1500.5 })]],
  ];
  for (const [label, clientTools] of cases) {
    const r = await coreTurn(turnWithTools(clientTools));
    assert.equal(r.status, 400, label);
    assert.equal(r.json.error, "bad_request", label);
    assert.match(String(r.json.message), /^clientTools/, label);
  }
  const timeout = await coreTurn(turnWithTools([pageTool("ui__x"), pageTool("ui__y", { timeoutMs: 999 })]));
  assert.match(String(timeout.json.message), /^clientTools\.1\.timeoutMs: /, "the message names the failing field");
});

test("core route: valid clientTools reach the queued run, stripped to the declared fields", async () => {
  const r = await coreTurn(
    turnWithTools([
      { ...pageTool("ui__highlight_rows", { timeoutMs: 60_000 }), smuggled: true },
      pageTool("ui__get_selection", { timeoutMs: 1_000 }),
    ]),
  );
  assert.equal(r.status, 202);
  const run = await built.runs.get(r.json.runId as string);
  assert.deepEqual(run?.request.clientTools, [
    pageTool("ui__highlight_rows", { timeoutMs: 60_000 }),
    pageTool("ui__get_selection", { timeoutMs: 1_000 }),
  ]);
});

function withPageTools(threadRef: string): OrchestratorInput {
  return { ...request("hi", threadRef), clientTools: [pageTool("ui__get_selection")] };
}

test("core route: a client_result is refused for a run that declared no client tools", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-client-none", request: request("hi", "t-client-none") });
  const r = await coreSignal(run.id, { kind: "client_result", callId: "c1", result: { content: "x" } });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { accepted: false, reason: "no_client_tools" });
  assert.deepEqual(await takePending(built.signals, run.id), []);
});

test("signalRun refuses a client_result from anyone but the run's own actor", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-client-other", request: withPageTools("t-client-other") });
  const outcome = await built.app.signalRun(
    run.id,
    { kind: "client_result", callId: "c1", result: { content: "x" } },
    "web-eve",
  );
  assert.deepEqual(outcome, { accepted: false, reason: "not_found" });
  assert.deepEqual(await takePending(built.signals, run.id), []);
});

test("core route: a client_result is accepted once, with a per-call dedupe key", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-client", request: withPageTools("t-client") });
  const body = {
    kind: "client_result",
    callId: "call-1",
    result: { content: "rows 3-5", structured: { rows: [3, 4, 5] }, isError: false },
  };
  const first = await coreSignal(run.id, body);
  assert.equal(first.status, 200);
  assert.equal(first.json.accepted, true);
  const second = await coreSignal(run.id, { ...body, result: { content: "late" } });
  assert.equal(second.status, 409);
  assert.deepEqual(second.json, { accepted: false, reason: "duplicate" });
  const signals = await takePending(built.signals, run.id);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "client_result");
  assert.equal(signals[0]!.callId, "call-1");
  assert.equal(signals[0]!.dedupeKey, `client:${run.id}:call-1`);
  assert.deepEqual(signals[0]!.result, body.result);
});

test("core route: malformed client_result signals are rejected 400", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-client-bad", request: withPageTools("t-client-bad") });
  for (const body of [
    { kind: "client_result", result: { content: "x" } },
    { kind: "client_result", callId: "", result: { content: "x" } },
    { kind: "client_result", callId: "c".repeat(257), result: { content: "x" } },
    { kind: "client_result", callId: "c1" },
    { kind: "client_result", callId: "c1", result: "x" },
    { kind: "client_result", callId: "c1", result: { content: 5 } },
    { kind: "client_result", callId: "c1", result: { content: "x", isError: "yes" } },
  ]) {
    const r = await coreSignal(run.id, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await takePending(built.signals, run.id), []);
  const named = await coreSignal(run.id, { kind: "client_result", callId: "c2", result: { content: ["x"] } });
  assert.match(String(named.json.message), /^client_result\.result\.content: /);
});

test("core route: a client_result keeps only the declared result fields", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "t-client-strip", request: withPageTools("t-client-strip") });
  const r = await coreSignal(run.id, {
    kind: "client_result",
    callId: "c1",
    result: { content: "ok", smuggled: true },
    extra: "ignored",
  });
  assert.equal(r.status, 200);
  const [signal] = await takePending(built.signals, run.id);
  assert.deepEqual(signal?.result, { content: "ok" });
});

test("core route: client_result for an unknown run is 404 and for a terminal run is 409", async () => {
  const body = { kind: "client_result", callId: "c1", result: { content: "x" } };
  assert.equal((await coreSignal("no-such-run", body)).status, 404);
  const { run } = await built.runs.enqueue({ sessionId: "t-client-done", request: withPageTools("t-client-done") });
  await completeTurn(built.turnLedger, run.id, { status: "ok", reply: "done" });
  const r = await coreSignal(run.id, body);
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { accepted: false, reason: "terminal" });
});

async function settleNoReplay(threadRef: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await built.runs.activeForThread(threadRef), null, "no replay turn was started");
  }
}

test("orphan replay drops a late client_result instead of starting a turn", async () => {
  const threadRef = `t-client-orphan-${crypto.randomUUID()}`;
  const { run } = await built.runs.enqueue({ sessionId: threadRef, request: request("hi", threadRef) });
  await built.signals.send(run.id, {
    kind: "client_result",
    callId: "late",
    text: "a late page answer",
    result: { content: "a late page answer" },
  });
  await completeTurn(built.turnLedger, run.id, { status: "ok", reply: "done" });
  await built.app.replayOrphanedRunSignals(run.id);
  await settleNoReplay(threadRef);
  assert.deepEqual(await built.signals.pending(run.id), [], "the late answer is consumed");
});

test("orphan replays never carry client tools into the new run", async () => {
  const requestless = `t-client-replay-${crypto.randomUUID()}`;
  const { run: first } = await built.runs.enqueue({ sessionId: requestless, request: withPageTools(requestless) });
  await built.signals.send(first.id, { kind: "steer", text: "carry on", ts: "1712.101" });
  await completeTurn(built.turnLedger, first.id, { status: "ok", reply: "done" });
  await built.app.replayOrphanedRunSignals(first.id);
  let replayed = await built.runs.activeForThread(requestless);
  for (let i = 0; !replayed && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    replayed = await built.runs.activeForThread(requestless);
  }
  assert.ok(replayed, "the requestless steer replays on the dead run's request");
  assert.equal(replayed!.request.text, "carry on");
  assert.equal(replayed!.request.clientTools, undefined, "the dead run's client tools are not inherited");

  const threadRef = `web:web-eve:${crypto.randomUUID()}`;
  const { run: second } = await built.runs.enqueue({
    sessionId: "t-client-replay-own",
    request: request("hi", "t-client-replay-own"),
  });
  await built.signals.send(second.id, {
    kind: "steer",
    text: "and this",
    ts: "1712.102",
    request: { ...steererRequest("web-eve", threadRef, "and this"), clientTools: [pageTool("ui__get_selection")] },
  });
  await completeTurn(built.turnLedger, second.id, { status: "ok", reply: "done" });
  await built.app.replayOrphanedRunSignals(second.id);
  let own = await built.runs.activeForThread(threadRef);
  for (let i = 0; !own && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    own = await built.runs.activeForThread(threadRef);
  }
  assert.ok(own, "the steer replays on its own request");
  assert.equal(own!.request.text, "and this");
  assert.equal(own!.request.clientTools, undefined, "the steer's own client tools are not carried into the replay");
});

test("subagent orphan replay never carries client tools into the new run", async () => {
  const threadRef = `agent:main:subagent:${crypto.randomUUID()}`;
  const { run } = await built.runs.enqueue({ sessionId: threadRef, request: withPageTools(threadRef) });
  await built.signals.send(run.id, { kind: "steer", text: "keep going" });
  await completeTurn(built.turnLedger, run.id, { status: "ok", reply: "done" });
  await built.app.replayOrphanedRunSignals(run.id);
  let replayed = await built.runs.activeForThread(threadRef);
  for (let i = 0; !replayed && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    replayed = await built.runs.activeForThread(threadRef);
  }
  assert.ok(replayed, "the subagent steer replays on the dead run's request");
  assert.equal(replayed!.request.text, "keep going");
  assert.equal(replayed!.request.clientTools, undefined);
});

test("subagent orphan replay drops a late client_result instead of starting a turn", async () => {
  const threadRef = `agent:main:subagent:${crypto.randomUUID()}`;
  const { run } = await built.runs.enqueue({ sessionId: threadRef, request: request("hi", threadRef) });
  await built.signals.send(run.id, {
    kind: "client_result",
    callId: "late",
    text: "a late page answer",
    result: { content: "a late page answer" },
  });
  await completeTurn(built.turnLedger, run.id, { status: "ok", reply: "done" });
  await built.app.replayOrphanedRunSignals(run.id);
  await settleNoReplay(threadRef);
  assert.deepEqual(await built.signals.pending(run.id), [], "the late answer is acknowledged");
});
