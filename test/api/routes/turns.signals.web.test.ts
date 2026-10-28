import "../../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../../../src/types.ts";
import { completeTurn } from "../../support/turns.ts";
import { serveSignalRoute, request, asUser, steererRequest } from "../../support/turn-signal-route.ts";
import { takePending } from "../../support/memory-run-signal-store.ts";

const { built, runTurns, webBase } = await serveSignalRoute({ web: true });

test("web proxy: the submitting user can signal their run; others (and token-less strangers) cannot", async () => {
  const threadRef = `web:alice:${crypto.randomUUID()}`;
  const submit = (await (
    await fetch(
      `${webBase}/api/turn`,
      asUser("alice", { method: "POST", body: JSON.stringify({ text: "queue me", threadRef }) }),
    )
  ).json()) as { runId?: string; runToken?: string };
  assert.ok(submit.runId, "async turn returns a runId");
  assert.equal(submit.runToken, undefined, "no bearer credential is exposed to browser code or URLs");

  const ok = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId!)}/signal`,
    asUser("alice", { method: "POST", body: JSON.stringify({ kind: "steer", text: "louder" }) }),
  );
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { accepted?: boolean }).accepted, true);

  const stranger = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId!)}/signal`,
    asUser("bob", { method: "POST", body: JSON.stringify({ kind: "abort" }) }),
  );
  assert.equal(stranger.status, 404, "a non-owner without a token is told the run does not exist");
});

test("web proxy: a steer carries a server-built ts and TurnRequest for the signed-in user", async () => {
  const threadRef = `web:alice:${crypto.randomUUID()}`;
  const submit = (await (
    await fetch(
      `${webBase}/api/turn`,
      asUser("alice", { method: "POST", body: JSON.stringify({ text: "queue me", threadRef }) }),
    )
  ).json()) as { runId?: string };
  assert.ok(submit.runId);

  const steer = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId!)}/signal`,
    asUser("alice", {
      method: "POST",
      body: JSON.stringify({
        kind: "steer",
        text: "louder",
        threadRef,
        ts: "client-forged",
        request: steererRequest("mallory", threadRef, "louder"),
      }),
    }),
  );
  assert.equal(steer.status, 200);

  const [signal] = await takePending(built.signals, submit.runId!);
  assert.ok(signal);
  assert.equal(signal.text, "louder");
  assert.ok(
    signal.ts && signal.ts !== "client-forged",
    "the ts is minted server-side; a client-supplied one is ignored",
  );
  assert.equal(signal.request?.actor.externalId, "alice", "a client-supplied request/actor is ignored");
  assert.equal(signal.request?.surface, "web");
  assert.deepEqual(signal.request?.conversation, { kind: "dm", threadRef });
});

test("web proxy: inbox steering cannot omit or disguise its context to bypass rollout gates", async () => {
  const threadRef = "web:alice:inbox";
  const { run } = await built.runs.enqueue({
    sessionId: "inbox-steer-gates",
    request: {
      ...request("Review my inbox", threadRef),
      surface: "web",
      actor: { id: "alice", type: "internal" },
      conversation: { kind: "dm", threadRef, audience: [{ id: "alice", type: "internal" }] },
    },
  });
  const steer = (body: Record<string, unknown>) =>
    fetch(`${webBase}/api/runs/${run.id}/signal`, asUser("alice", { method: "POST", body: JSON.stringify(body) }));
  try {
    for (const enabled of [false, true]) {
      await built.featureFlags.setEnabled("inbox_loops", scopeId("personal", "alice"), enabled, "test");
      for (const context of [{}, { threadRef: "" }, { threadRef: "invalid" }, { threadRef: "web:alice:ordinary" }]) {
        const response = await steer({
          kind: "steer",
          text: "Prioritize these",
          request: steererRequest("alice", threadRef, "forged"),
          ...context,
        });
        assert.equal(response.status, 400);
        assert.equal(((await response.json()) as { reason?: string }).reason, "conversation_mismatch");
        assert.deepEqual(await takePending(built.signals, run.id), []);
      }
      const response = await steer({ kind: "steer", text: "Prioritize these", threadRef });
      assert.equal(response.status, enabled ? 200 : 403);
      const signals = await takePending(built.signals, run.id);
      assert.equal(signals.length, enabled ? 1 : 0);
      if (enabled) {
        assert.equal(signals[0]?.request?.conversation.threadRef, threadRef);
        assert.match(signals[0]?.request?.conversationHeader ?? "", /fresh snapshot/);
      }
    }
    const abort = await steer({ kind: "abort" });
    assert.equal(abort.status, 200);
  } finally {
    await built.featureFlags.setEnabled("inbox_loops", scopeId("personal", "alice"), false, "test");
  }
});

test("web proxy: shared scopes cannot disguise an alias-owned inbox thread", async () => {
  const user = "alice@example.com";
  const threadRef = "web:ALICE@example.com:inbox";
  const { run } = await built.runs.enqueue({
    sessionId: "inbox-alias-steer-gates",
    request: {
      ...request("Review my inbox", threadRef),
      surface: "web",
      actor: { id: user, type: "internal" },
      conversation: { kind: "dm", threadRef, audience: [{ id: user, type: "internal" }] },
    },
  });
  for (const scopeId of ["channel:any", "group:any"]) {
    for (const path of ["/api/turn", `/api/runs/${run.id}/signal`]) {
      const response = await fetch(
        `${webBase}${path}`,
        asUser(user, {
          method: "POST",
          body: JSON.stringify({ kind: "steer", text: "Prioritize these", threadRef, scopeId }),
        }),
      );
      assert.equal(response.status, 403);
      assert.deepEqual(await takePending(built.signals, run.id), []);
    }
  }
});

test("web proxy: a steer claiming another user's thread is refused", async () => {
  const submit = (await (
    await fetch(`${webBase}/api/turn`, asUser("alice", { method: "POST", body: JSON.stringify({ text: "queue me" }) }))
  ).json()) as { runId?: string };
  assert.ok(submit.runId);
  const steer = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(submit.runId!)}/signal`,
    asUser("alice", {
      method: "POST",
      body: JSON.stringify({ kind: "steer", text: "louder", threadRef: "web:bob:stolen" }),
    }),
  );
  assert.equal(steer.status, 400);
  assert.equal(((await steer.json()) as { reason?: string }).reason, "conversation_mismatch");
  assert.deepEqual(await takePending(built.signals, submit.runId!), []);
});

test("web proxy: Project roster revisions revoke pending run status, signals, and events", async () => {
  await built.app.upsertDirectory([
    { principalId: "project-owner", displayName: "Project Owner", type: "internal" },
    { principalId: "project-member", displayName: "Project Member", type: "internal" },
    { principalId: "project-late-member", displayName: "Late Member", type: "internal" },
  ]);
  const project = await built.app.createProject("project-owner", "Run access");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "project-owner", "project-member")).status, "ok");

  const threadRef = `web:project-owner:${crypto.randomUUID()}`;
  const submitted = await fetch(
    `${webBase}/api/turn`,
    asUser("project-owner", {
      method: "POST",
      body: JSON.stringify({
        text: "queued project work",
        threadRef,
        scopeId: project.scopeId,
        channelName: project.name,
      }),
    }),
  );
  assert.equal(submitted.status, 202);
  const queued = (await submitted.json()) as { runId?: string; runToken?: string };
  assert.ok(queued.runId);
  assert.equal(queued.runToken, undefined);

  const discovered = (await (
    await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("project-member"))
  ).json()) as { runId?: string | null; runToken?: string };
  assert.equal(
    discovered.runId,
    queued.runId,
    "a member rediscovers the creator's run without an instance-local index",
  );
  assert.equal(discovered.runToken, undefined);

  assert.equal((await built.app.addProjectMember(project.id, "project-owner", "project-late-member")).status, "ok");
  const lateMember = (await (
    await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("project-late-member"))
  ).json()) as { runId?: string | null };
  assert.equal(lateMember.runId, null, "joining a Project does not reveal a turn from the prior roster");
  assert.equal(
    (
      (await (
        await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("project-member"))
      ).json()) as { runId?: string | null }
    ).runId,
    null,
    "a roster change invalidates the prior revision's run for every member",
  );

  const outsider = (await (
    await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("project-outsider"))
  ).json()) as { runId?: string | null };
  assert.equal(outsider.runId, null, "core's viewer gate hides the run from non-members");

  const currentThreadRef = `web:project-owner:${crypto.randomUUID()}`;
  const currentSubmit = await fetch(
    `${webBase}/api/turn`,
    asUser("project-owner", {
      method: "POST",
      body: JSON.stringify({
        text: "current project work",
        threadRef: currentThreadRef,
        scopeId: project.scopeId,
        channelName: project.name,
      }),
    }),
  );
  assert.equal(currentSubmit.status, 202);
  const current = (await currentSubmit.json()) as { runId?: string };
  assert.ok(current.runId);
  const currentDiscovery = (await (
    await fetch(
      `${webBase}/api/runs/active?threadRef=${encodeURIComponent(currentThreadRef)}`,
      asUser("project-member"),
    )
  ).json()) as { runId?: string | null; runToken?: string };
  assert.equal(currentDiscovery.runId, current.runId);
  assert.equal(currentDiscovery.runToken, undefined);

  const statusPath = `/api/runs/${encodeURIComponent(current.runId!)}`;
  assert.equal((await fetch(`${webBase}${statusPath}`, asUser("project-member"))).status, 200);

  assert.equal((await built.app.removeProjectMember(project.id, "project-owner", "project-member")).status, "ok");
  assert.equal((await built.app.addProjectMember(project.id, "project-owner", "project-member")).status, "ok");
  const active = (await (
    await fetch(
      `${webBase}/api/runs/active?threadRef=${encodeURIComponent(currentThreadRef)}`,
      asUser("project-member"),
    )
  ).json()) as { runId?: string | null };
  assert.equal(active.runId, null);
  assert.equal((await fetch(`${webBase}${statusPath}`, asUser("project-member"))).status, 404);

  const signal = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(current.runId!)}/signal`,
    asUser("project-member", {
      method: "POST",
      body: JSON.stringify({ kind: "abort" }),
    }),
  );
  assert.equal(signal.status, 404);

  const events = await fetch(
    `${webBase}/api/runs/${encodeURIComponent(current.runId!)}/events`,
    asUser("project-member"),
  );
  assert.equal(events.status, 404);
});

test("web proxy: a Project member can resolve their own approval in another member's thread", async () => {
  await built.app.upsertDirectory([
    { principalId: "approval-owner", displayName: "Approval Owner", type: "internal" },
    { principalId: "approval-member", displayName: "Approval Member", type: "internal" },
  ]);
  const project = await built.app.createProject("approval-owner", "Shared approvals");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "approval-owner", "approval-member")).status, "ok");
  const threadRef = `web:approval-owner:${crypto.randomUUID()}`;
  const channelRef = project.scopeId.slice("group:".length);
  const conversation = { kind: "group" as const, channelRef, channelName: project.name, threadRef, audience: [] };

  runTurns(true);
  assert.equal(
    (
      await built.app.turn({
        origin: { kind: "direct" },
        surface: "web",
        actor: { externalId: "approval-owner" },
        conversation,
        text: "start",
      })
    ).status,
    "ok",
  );
  const pending = await built.app.turn({
    origin: { kind: "direct" },
    surface: "web",
    actor: { externalId: "approval-member" },
    conversation,
    text: "!run git push --force origin main",
  });
  runTurns(false);
  assert.equal(pending.status, "pending_approval");
  const requestId = pending.pendingApprovals?.[0]?.requestId;
  assert.ok(requestId);

  const approved = await fetch(
    `${webBase}/api/approvals/${encodeURIComponent(requestId)}`,
    asUser("approval-member", { method: "POST", body: JSON.stringify({ approved: true }) }),
  );
  assert.equal(approved.status, 202);
  assert.ok(((await approved.json()) as { runId?: string }).runId);
});

test("web proxy: /api/runs/active tracks queued runs — the live one first, the queued one after it finishes", async () => {
  const threadRef = `web:carol:${crypto.randomUUID()}`;
  const submitTwice = async (text: string): Promise<string> => {
    const r = (await (
      await fetch(`${webBase}/api/turn`, asUser("carol", { method: "POST", body: JSON.stringify({ text, threadRef }) }))
    ).json()) as { runId?: string };
    assert.ok(r.runId);
    return r.runId!;
  };
  const first = await submitTwice("turn one");
  const second = await submitTwice("turn two");
  assert.notEqual(first, second);

  const active1 = (await (
    await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("carol"))
  ).json()) as { runId?: string | null };
  assert.equal(active1.runId, first, "the oldest live run is the active one");

  await completeTurn(built.turnLedger, first, { status: "ok", reply: "done" });

  const active2 = (await (
    await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent(threadRef)}`, asUser("carol"))
  ).json()) as { runId?: string | null };
  assert.equal(active2.runId, second, "once the live run finishes, the queued one becomes active");
});

test("web steering atomically transfers file-only queues and deduplicates retries", async () => {
  const threadRef = "web:U1:steer-files";
  const attachments = [{ name: "report.txt", mimetype: "text/plain", sizeBytes: 6, blobId: "steer-blob" }];
  const submit = async (text: string, files: import("../../../src/types.ts").IncomingAttachment[] = []) => {
    const res = await fetch(
      `${webBase}/api/turn`,
      asUser("U1", {
        method: "POST",
        body: JSON.stringify({ text, threadRef, attachments: files }),
      }),
    );
    return ((await res.json()) as { runId: string }).runId;
  };
  const runId = await submit("working");
  const queuedRunId = await submit("", attachments);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(
      `${webBase}/api/runs/${runId}/signal`,
      asUser("U1", {
        method: "POST",
        body: JSON.stringify({ kind: "steer", text: "", threadRef, queuedRunId }),
      }),
    );
    assert.equal(response.status, 200, await response.text());
  }
  assert.equal(await built.runs.get(queuedRunId), null);
  const signals = await takePending(built.signals, runId);
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0]?.request?.attachments, attachments);
});
