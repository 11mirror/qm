import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../src/types.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";
import type { ProvisionOptions } from "../src/sandbox/sandbox.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { TURN_FILES_DIR, turnFileId } from "../src/core/attachments.ts";
import { isOverheard, isUserMessage, messageTs, type Item } from "../src/sessions/items.ts";
import { hashId } from "../src/util/crypto.ts";
import {
  buildTestApp,
  failedTurn,
  freshApp,
  spyProvisioning,
  internalActor,
  dm,
  channel,
} from "./support/orchestrator-app.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { settle } from "./support/settle.ts";

test("admin reach rides only live, all-internal turns — autonomous and guest-audience turns mint a powerless token", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox } = buildTestApp(config);
  let captured: ProvisionOptions | undefined;
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return realProvision(layers, opts);
  };
  const admin = { externalId: "admin-alice" };

  assert.equal(
    (
      await app.turn({
        surface: "cron",
        actor: admin,
        conversation: { kind: "dm", threadRef: "dm:admin-alice:auto" },
        text: "!run echo hi",
      })
    ).status,
    "ok",
  );
  let claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.liveActor, undefined, "an autonomous turn must not attest liveness");
  const autoPrompt = await app.turn({
    surface: "cron",
    actor: admin,
    conversation: { kind: "dm", threadRef: "dm:admin-alice:auto2" },
    text: "!sysprompt",
  });
  assert.doesNotMatch(autoPrompt.reply ?? "", /## Acting for an org admin|System administration is not limited/);

  captured = undefined;
  assert.equal(
    (
      await app.turn({
        surface: "test",
        actor: admin,
        conversation: {
          kind: "group",
          threadRef: "grp:G1:det",
          channelRef: "G1",
          audience: [admin],
          publishMembers: [admin, { externalId: "bob" }],
        },
        text: "!run echo hi",
        liveActor: true,
        unprompted: true,
      })
    ).status,
    "ok",
  );
  claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.liveAuthor, true, "an author-live detection turn attests authorship");
  const threadPrompt = await app.turn({
    surface: "test",
    actor: admin,
    conversation: {
      kind: "group",
      threadRef: "grp:G1:det",
      channelRef: "G1",
      audience: [admin],
      publishMembers: [admin, { externalId: "bob" }],
    },
    text: "!sysprompt",
    liveActor: true,
    unprompted: true,
  });
  assert.match(threadPrompt.reply ?? "", /## Acting for an org admin/);
  assert.match(threadPrompt.reply ?? "", /System administration is not limited to the admin dashboard/);

  assert.equal(
    claims!.liveActor,
    undefined,
    "a thread reply attests authorship without pretending to be an explicit mention",
  );

  captured = undefined;
  assert.equal(
    (
      await app.turn({
        surface: "test",
        actor: admin,
        conversation: { kind: "dm", threadRef: "dm:admin-alice:det" },
        text: "!run echo hi",
        liveActor: true,
        unprompted: true,
      })
    ).status,
    "ok",
  );
  claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.liveActor, undefined, "a DM detection turn must not attest liveness");
  assert.equal(claims!.liveAuthor, undefined, "a DM detection turn must not attest authorship");

  captured = undefined;
  assert.equal(
    (
      await app.turn({
        surface: "test",
        actor: admin,
        conversation: { kind: "group", threadRef: "grp:G2:det", channelRef: "G2", audience: [admin] },
        text: "!run echo hi",
        liveActor: true,
        unprompted: true,
      })
    ).status,
    "ok",
  );
  claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.liveAuthor, undefined, "an unattested room must not attest authorship");

  captured = undefined;
  assert.equal(
    (
      await app.turn({
        surface: "test",
        actor: admin,
        conversation: { kind: "dm", threadRef: "dm:admin-alice:det2" },
        text: "!run echo hi",
        unprompted: true,
      })
    ).status,
    "ok",
  );
  claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.liveActor, undefined, "a synthetic detection turn must not attest liveness");
  assert.equal(claims!.liveAuthor, undefined, "a synthetic detection turn must not attest authorship");

  captured = undefined;
  assert.equal(
    (
      await app.turn({
        surface: "cron",
        actor: admin,
        conversation: { kind: "dm", threadRef: "dm:admin-alice:trigger-live" },
        text: "!run echo hi",
        triggered: true,
        liveActor: true,
      })
    ).status,
    "ok",
  );
  claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(
    claims!.liveActor,
    undefined,
    "an automated turn must not attest liveness even when a caller also sets liveActor",
  );

  captured = undefined;
  assert.equal(
    (
      await app.turn({
        surface: "test",
        actor: admin,
        conversation: {
          kind: "channel",
          threadRef: "ch:C9:t1",
          channelRef: "C9",
          audience: [admin],
          publishMembers: [admin, { externalId: "visitor", isExternalGuest: true }],
        },
        text: "!run echo hi",
        liveActor: true,
      })
    ).status,
    "ok",
  );
  claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.liveActor, undefined, "guest-audience turns must not attest liveness");
  assert.equal(claims!.liveAuthor, undefined);

  for (const publishMembers of [undefined, [] as { externalId: string; orgId: string }[]]) {
    captured = undefined;
    assert.equal(
      (
        await app.turn({
          surface: "test",
          actor: admin,
          conversation: {
            kind: "channel",
            threadRef: `ch:C10:${publishMembers ? "empty" : "absent"}`,
            channelRef: "C10",
            audience: [admin],
            ...(publishMembers ? { publishMembers } : {}),
          },
          text: "!run echo hi",
          liveActor: true,
        })
      ).status,
      "ok",
    );
    claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
    assert.equal(claims!.liveActor, undefined, "unknown room membership must not attest liveness");
    if (publishMembers === undefined) {
      assert.equal(
        claims!.members,
        undefined,
        "withheld publishMembers must not mint a scope-run cron member snapshot",
      );
    } else {
      assert.deepEqual(claims!.members, [], "empty publishMembers stays an empty scope-run snapshot");
    }
    assert.deepEqual(
      claims!.keychainMembers?.map((p) => p.id),
      ["admin-alice"],
    );
  }
});

test("an attached file rides out once, and is not re-attached to every later turn", async () => {
  const { app } = freshApp();
  const t1 = await app.turn(dm("!writeattach one.txt one"));
  assert.equal(t1.status, "ok");
  assert.deepEqual(
    (t1.attachments ?? []).map((a) => a.name),
    ["one.txt"],
  );

  const t2 = await app.turn(dm("!writeattach two.txt two"));
  assert.equal(t2.status, "ok");
  assert.deepEqual(
    (t2.attachments ?? []).map((a) => a.name),
    ["two.txt"],
  );

  const t3 = await app.turn(dm("!attach one.txt"));
  assert.deepEqual(
    (t3.attachments ?? []).map((a) => a.name),
    ["one.txt"],
    "a still-present workspace file only rides out when it is attached again",
  );
});

test("attaching a path that is not there is an in-turn error, not a silent non-delivery", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!attach nope.txt"));
  assert.equal(res.status, "ok");
  assert.equal(res.attachments, undefined, "nothing rides out");
  assert.match(res.reply ?? "", /not attached.*nope\.txt \(not found\)/);
});

test("an attached file is recorded in the attach tool result", async () => {
  const { app } = freshApp();
  const t1 = await app.turn(dm("!writeattach flag.png FLAG"));
  assert.deepEqual(
    (t1.attachments ?? []).map((a) => a.name),
    ["flag.png"],
  );

  const s1 = await app.getSession(t1.sessionId!);
  const result = s1!.items.findLast((e) => e.kind === "ToolResult" && e.tool === "attach");
  assert.ok(result, "expected an attach tool_result entry");
  const files = (result!.body as { files: Array<{ name: string; artifactId?: string }> }).files;
  assert.equal(files[0]!.name, "flag.png");
  assert.equal(files[0]!.artifactId, t1.attachments![0]!.artifactId);
});

test("turn-private transfer files are removed after staging", async () => {
  const { app, sandbox, blobTransfer } = freshApp();
  const blob = await blobTransfer.put(Buffer.from("inbound"));
  let usedHandle: Parameters<typeof sandbox.listDir>[0] | undefined;
  let cleanupAttempts = 0;
  const removeDir = sandbox.removeDir.bind(sandbox);
  sandbox.removeDir = async (handle, path) => {
    if (/^\.agent-turn\/[a-f0-9]{24}\/[a-z0-9]+-[a-f0-9]{24}$/.test(path) && ++cleanupAttempts < 3) {
      throw new Error("transient cleanup failure");
    }
    return removeDir(handle, path);
  };
  const run = sandbox.run.bind(sandbox);
  sandbox.run = async (handle, command, opts) => {
    usedHandle = handle;
    return run(handle, command, opts);
  };

  const result = await app.turn(
    dm("!writeattach result.txt outbound", {
      attachments: [{ name: "input.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
    }),
  );

  assert.deepEqual(
    result.attachments?.map((a) => a.name),
    ["result.txt"],
  );
  assert.ok(usedHandle);
  await settle(() => cleanupAttempts === 3);
  assert.deepEqual(await sandbox.listDir(usedHandle, TURN_FILES_DIR), []);
});

test("a later turn removes same-conversation and expired transfer files", async () => {
  const built = freshApp();
  const { app, sandbox } = built;
  await selectDefaultSandbox(built, "U1", scopeId("personal", "U1"));
  const handle = await sandbox.provision([{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }]);
  const sessionDir = `${TURN_FILES_DIR}/${hashId(["dm:U1:t1"], 24)}`;
  await sandbox.writeFile(handle, `${sessionDir}/abandoned/inbox/stale.bin`, "stale");
  const expiredSessionDir = `${TURN_FILES_DIR}/${hashId(["dm:U1:other"], 24)}`;
  const expiredTurnDir = `${expiredSessionDir}/${turnFileId("abandoned-run", 1, Date.now() - 25 * 60 * 60_000)}`;
  await sandbox.writeFile(handle, `${expiredTurnDir}/inbox/stale.bin`, "stale");
  await sandbox.teardown(handle);

  const result = await app.turn(dm("!run true"));

  assert.equal(result.status, "ok");
  assert.deepEqual(await sandbox.listDir(handle, TURN_FILES_DIR), []);
});

test("concurrent conversations sharing one computer attach only their own file", async () => {
  const { app, sandbox } = freshApp();
  let firstWrote!: () => void;
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    firstWrote = resolve;
  });
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const run = sandbox.run.bind(sandbox);
  sandbox.run = async (handle, command, opts) => {
    const result = await run(handle, command, opts);
    if (command.includes("first-ready")) {
      firstWrote();
      await firstMayFinish;
    }
    return result;
  };

  const first = app.turn(
    dm("!writeattach first-ready-one.txt one", {
      conversation: { kind: "dm", threadRef: "dm:U1:first" },
    }),
  );
  await firstReady;
  const second = app.turn(
    dm("!writeattach two.txt two", {
      conversation: { kind: "dm", threadRef: "dm:U1:second" },
    }),
  );
  const r2 = await second.finally(releaseFirst);

  const r1 = await first;
  assert.deepEqual(
    r1.attachments?.map((a) => a.name),
    ["first-ready-one.txt"],
  );
  assert.deepEqual(
    r2.attachments?.map((a) => a.name),
    ["two.txt"],
  );
});

test("concurrent conversations sharing one computer read only their own inbound file", async () => {
  const { app, sandbox, blobTransfer } = freshApp();
  const alpha = await blobTransfer.put(Buffer.from("alpha"));
  const beta = await blobTransfer.put(Buffer.from("beta"));
  let firstMaterialized!: () => void;
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    firstMaterialized = resolve;
  });
  const firstMayRead = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const run = sandbox.run.bind(sandbox);
  sandbox.run = async (handle, command, opts) => {
    if (command.includes("first-read")) {
      firstMaterialized();
      await firstMayRead;
    }
    return run(handle, command, opts);
  };
  const readOwnInbox = "cat {INBOX}/report.txt";

  const first = app.turn(
    dm(`!run ${readOwnInbox}; echo first-read`, {
      conversation: { kind: "dm", threadRef: "dm:U1:first-inbound" },
      attachments: [{ name: "report.txt", mimetype: "text/plain", sizeBytes: alpha.sizeBytes, blobId: alpha.blobId }],
    }),
  );
  await firstReady;
  const second = app.turn(
    dm(`!run ${readOwnInbox}`, {
      conversation: { kind: "dm", threadRef: "dm:U1:second-inbound" },
      attachments: [{ name: "report.txt", mimetype: "text/plain", sizeBytes: beta.sizeBytes, blobId: beta.blobId }],
    }),
  );
  const r2 = await second.finally(releaseFirst);
  const r1 = await first;

  assert.match(r1.reply ?? "", /alpha/);
  assert.doesNotMatch(r1.reply ?? "", /beta/);
  assert.match(r2.reply ?? "", /beta/);
  assert.doesNotMatch(r2.reply ?? "", /alpha/);
});

test("a file posted in a GROUP conversation is granted read to the conversation scope", async () => {
  const { app, acl } = freshApp();
  const grp = {
    kind: "group" as const,
    threadRef: "grp:G9:files",
    channelRef: "G9",
    audience: [internalActor, { externalId: "U2" }],
  };
  await app.turn(
    dm("!run printf FLAG > flag.png", {
      surface: "slack",
      conversation: grp,
      deliveryTarget: "slack:G9:files",
      surfaceTools: true,
    }),
  );
  const t = await app.turn(
    dm("!postfiles flag.png here you go", {
      surface: "slack",
      conversation: grp,
      deliveryTarget: "slack:G9:files",
      surfaceTools: true,
    }),
  );
  assert.notEqual(t.status, "error");
  const handles = await acl.handlesFor([scopeId("group", "G9")]);
  const fileHandle = handles.find((h) => h.handlePath === "shared/flag.png");
  assert.ok(fileHandle, "the posted file is granted to the conversation scope");
  assert.equal(fileHandle!.ownerScopeId, scopeId("personal", "U1"));
});

test("a file posted in a GROUP conversation is granted read to the conversation scope", async () => {
  const { app, acl } = freshApp();
  const grp = {
    kind: "group" as const,
    threadRef: "grp:G9:files",
    channelRef: "G9",
    audience: [internalActor, { externalId: "U2" }],
  };
  await app.turn(
    dm("!run printf FLAG > flag.png", {
      surface: "slack",
      conversation: grp,
      deliveryTarget: "slack:G9:files",
      surfaceTools: true,
    }),
  );
  const t = await app.turn(
    dm("!postfiles flag.png here you go", {
      surface: "slack",
      conversation: grp,
      deliveryTarget: "slack:G9:files",
      surfaceTools: true,
    }),
  );
  assert.notEqual(t.status, "error");
  const handles = await acl.handlesFor([scopeId("group", "G9")]);
  const fileHandle = handles.find((h) => h.handlePath === "shared/flag.png");
  assert.ok(fileHandle, "the posted file is granted to the conversation scope");
  assert.equal(fileHandle!.ownerScopeId, scopeId("personal", "U1"));
});

test("a file shared with the session is LISTED in the cached system prompt — without provisioning a sandbox", async () => {
  const built = freshApp();
  const { app, acl } = built;
  const boxes = spyProvisioning(built.sandbox);
  await built.files.put({
    id: "budget-file",
    ownerScopeId: scopeId("personal", "U2"),
    createdBy: "U2",
    name: "budget.csv",
    path: "budget.csv",
    mimetype: "text/csv",
    data: Buffer.from("amount\n10"),
    direction: "out",
  });
  await acl.grant({
    ownerScopeId: scopeId("personal", "U2"),
    ref: "budget-file",
    granteeScopeId: scopeId("personal", "U1"),
    permission: "read",
    grantedBy: "U2",
  });
  const res = await app.turn(dm("!sysprompt"));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /## Files shared with you/);
  assert.match(res.reply ?? "", /shared\/budget\.csv/);
  assert.match(res.reply ?? "", /read a path below to fetch that file on demand/);
  assert.equal(boxes.provisioned, 0, "listing shared files must not provision a box");
});

test("an unexpected turn fault is recorded to the error log and fails the turn", async () => {
  const built = freshApp({ maxAttempts: 1 });
  const { errors } = built;
  await failedTurn(built, dm("!boom"), /boom: simulated turn fault/);
  const turnError = (await errors.list()).find((e) => e.category === "turn" && e.code === "error");
  assert.ok(turnError, "the turn fault should be recorded in the error log");
  assert.match(turnError!.message, /boom/);
  assert.ok(turnError!.sessionId, "the recorded error carries the session id for triage");
});

test("an unprompted thread message the colleague wouldn't answer is silent (no run, no writes)", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("ok sounds good to me", { unprompted: true }));
  assert.equal(res.status, "silent");
  assert.ok(res.sessionId);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    [],
  );
});

test("a poll fire that ends with no message resolves to silent, not a delivered empty reply", async () => {
  const { app } = freshApp();
  const cron = {
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm" as const, threadRef: "dm:U1:cron" },
    text: "!silent",
    triggered: true,
  };
  const res = await app.turn(cron);
  assert.equal(res.status, "silent", "the agent had nothing to add, so the turn is silent");
  assert.ok(res.sessionId, "the turn still ran — it's silent, not skipped");
});

test("a poll fire whose reply is a bracketed token is an ordinary reply; only finish_silently silences it", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron2" },
    text: "!run printf %s 'Nothing changed.\n\n[no-update]'",
    triggered: true,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.reply, "Nothing changed.\n\n[no-update]");
  const silenced = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron2b" },
    text: "!finish-silent",
    triggered: true,
  });
  assert.equal(silenced.status, "silent");
});

test("a poll fire with a real reply still delivers (status ok), and a non-triggered empty reply is not silenced", async () => {
  const { app } = freshApp();
  const real = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron3" },
    text: "!run printf %s 'PTO is due today'",
    triggered: true,
  });
  assert.equal(real.status, "ok");
  assert.match(real.reply ?? "", /PTO is due today/);
  const interactive = await app.turn(dm("!silent"));
  assert.notEqual(interactive.status, "silent");
});

test("a poll fire whose only output is an attached file delivers it — files, not silence", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron6" },
    text: "!writeattach digest.png PNG",
    triggered: true,
  });
  assert.equal(res.status, "ok", "files are a real update — the empty reply must not silence the fire");
  assert.equal(res.reply, "");
  assert.deepEqual(
    (res.attachments ?? []).map((a) => a.name),
    ["digest.png"],
  );
});

test("a poll fire that attaches a file and then finishes silently still delivers the file", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron7" },
    text: "!attachsilent digest.png PNG",
    triggered: true,
  });
  assert.equal(res.status, "ok", "the file was confirmed to the model, so silence must not discard it");
  assert.deepEqual(
    (res.attachments ?? []).map((a) => a.name),
    ["digest.png"],
  );
});

test("a poll fire that calls finish_silently ends the turn with an empty reply and resolves to silent", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron4" },
    text: "!finish-silent",
    triggered: true,
  });
  assert.equal(res.status, "silent", "the tool terminates the turn — the empty closing reply is the silence");
  assert.equal(res.reply, undefined, "nothing is delivered — the model never gets a step to narrate its silence");
});

test("finish_silently is a no-op off a poll fire — the agent's reply still delivers", async () => {
  const { app } = freshApp();
  const interactive = await app.turn(dm("!finish-silent"));
  assert.notEqual(interactive.status, "silent", "a person is waiting, so the turn is never silenced");
  assert.match(interactive.reply ?? "", /ending silently/);
});

test("finish_silently on a poll fire wins over a coexisting collected approval", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron5" },
    text: "!finish-silent-approval",
    triggered: true,
  });
  assert.equal(res.status, "silent", "explicit silence must win over the pending-approval branch");
  assert.equal(res.reply, undefined, "no narration leaks");
  assert.equal(res.pendingApprovals, undefined, "no approval prompt is surfaced on a silenced poll fire");
});

test("a poll fire that PAUSED on a gated command is never silenced — the approval persists", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron7" },
    text: "!finish-silent-paused",
    triggered: true,
  });
  assert.equal(
    res.status,
    "pending_approval",
    "a paused turn outranks explicit silence — silencing it would starve the cron with no trace",
  );
  assert.ok(res.pendingApprovals?.length, "the approval stays durable so it can be approved and the run resumed");
});

test("an unprompted acknowledgement gets an emoji reaction, not a reply (no run, no writes)", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("thanks, that's perfect", { unprompted: true }));
  assert.equal(res.status, "react");
  assert.ok((res.reactions ?? []).length > 0);
  assert.ok(res.sessionId);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    [],
  );
});

test("on a surface without reactions, the same acknowledgement just stays silent (no REACT leaks)", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("thanks, that's perfect", { unprompted: true, gatewayContext: undefined }));
  assert.equal(res.status, "silent");
  assert.equal((res.reactions ?? []).length, 0);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    [],
  );
});

test("an unprompted thread question gets a reply (turn detection chimes in)", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("what does everyone think about the rollout?", { unprompted: true }));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /You said: what does everyone think/);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    ["UserMessage", "AgentMessage"],
  );
});

test("priorTurns are routed to the harness as structured roled turns (PR3)", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    channel("!priorturns", {
      unprompted: true,
      priorTurns: [
        { role: "user", name: "U2", text: "I think we ship Friday" },
        { role: "user", name: "U3", text: "I'd wait for QA" },
        { role: "assistant", text: "let me check the dashboard" },
      ],
    }),
  );
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /user\/U2: I think we ship Friday/);
  assert.match(res.reply ?? "", /user\/U3: I'd wait for QA/);
  assert.match(res.reply ?? "", /assistant: let me check the dashboard/);
});

test("overheard messages are imported ONCE into the durable log, author-labeled, and handed to the harness", async () => {
  const { app, sessions } = freshApp();
  const entryBatches: number[] = [];
  const appendMany = sessions.appendMany.bind(sessions);
  sessions.appendMany = async (lease, entries) => {
    if (entries.some((entry) => entry.body?.overheard === true)) entryBatches.push(entries.length);
    return appendMany(lease, entries);
  };
  const overheardEntries = (entries: Item[]) => entries.filter((e) => isOverheard(e));

  const r1 = await app.turn(
    channel("!overheard", {
      overheard: [
        { ts: "100.001", role: "user", name: "Alice", text: "I posted a cat photo", files: ["cat.jpg"] },
        { ts: "100.002", role: "self", text: "nice cat" },
        { ts: "100.003", role: "user", name: "Bob", text: "love it" },
      ],
    }),
  );
  assert.equal(r1.status, "ok");
  assert.match(r1.reply ?? "", /Alice@100\.001: I posted a cat photo \[cat\.jpg\]/);
  assert.match(r1.reply ?? "", /Bob@100\.003: love it/);
  assert.match(r1.reply ?? "", /nice cat/);

  const s1 = await app.getSession(r1.sessionId!);
  const ov1 = overheardEntries(s1!.items);
  assert.deepEqual(
    ov1.map((e) => messageTs(e)),
    ["100.001", "100.002", "100.003"],
  );
  assert.equal((ov1[1]!.body as { sourceRole: string }).sourceRole, "agent");
  assert.equal((ov1[0]!.body as { name: string }).name, "Alice");
  assert.ok(ov1.every((entry) => entry.body.speakerId === undefined));
  assert.deepEqual((ov1[0]!.body as { files: string[] }).files, ["cat.jpg"]);

  const r2 = await app.turn(
    channel("!overheard", {
      overheard: [
        { ts: "100.001", role: "user", name: "Alice", text: "I posted a cat photo", files: ["cat.jpg"] },
        { ts: "100.002", role: "self", text: "nice cat" },
        { ts: "100.003", role: "user", name: "Bob", text: "love it" },
        { ts: "100.004", role: "user", name: "Carol", text: "me too" },
      ],
    }),
  );
  assert.equal(r2.status, "ok");
  assert.match(r2.reply ?? "", /Carol@100\.004: me too/);
  assert.doesNotMatch(r2.reply ?? "", /Alice@100\.001/);

  const s2 = await app.getSession(r2.sessionId!);
  const ov2 = overheardEntries(s2!.items);
  assert.deepEqual(
    ov2.map((e) => messageTs(e)),
    ["100.001", "100.002", "100.003", "100.004"],
    "append-only: each message recorded exactly once",
  );
  assert.deepEqual(entryBatches, [3, 1]);
});

test("a message answered on one turn is not re-imported as overheard on the next (full-stack dedupe)", async () => {
  const { app } = freshApp();
  const overheardEntries = (entries: Item[]) => entries.filter((e) => isOverheard(e));

  const r1 = await app.turn(channel("run it now on the first 20 emails", { liveActor: true, triggerTs: "200.001" }));
  assert.equal(r1.status, "ok");
  const s1 = await app.getSession(r1.sessionId!);
  const trigger = s1!.items.find((e) => isUserMessage(e) && messageTs(e) === "200.001");
  assert.ok(trigger, "the trigger entry carries its surface ts");
  assert.match(
    String(trigger!.text ?? ""),
    /run it now on the first 20 emails/,
    "the addressed message rides the recorded entry",
  );

  const r2 = await app.turn(
    channel("did that work?", {
      liveActor: true,
      triggerTs: "200.002",
      overheard: [{ ts: "200.001", role: "user", name: "Avery", text: "run it now on the first 20 emails" }],
    }),
  );
  assert.equal(r2.status, "ok");
  const s2 = await app.getSession(r2.sessionId!);
  assert.deepEqual(
    overheardEntries(s2!.items).map((e) => messageTs(e)),
    [],
    "the just-answered message is not doubled as overheard",
  );
  const withText = s2!.items.filter(
    (e) => isUserMessage(e) && String(e.text ?? "").includes("run it now on the first 20 emails"),
  );
  assert.equal(withText.length, 1, "recorded exactly once");
});

test("an unprompted thread-follow (no triggerTs) is stamped via entryTs and not re-imported as overheard", async () => {
  const { app } = freshApp();
  const overheardEntries = (entries: Item[]) => entries.filter((e) => isOverheard(e));

  const followText = "should I actually skip the last one?";
  const r1 = await app.turn(channel(followText, { unprompted: true, entryTs: "300.001" }));
  assert.equal(r1.status, "ok");
  const s1 = await app.getSession(r1.sessionId!);
  const trigger = s1!.items.find((e) => isUserMessage(e) && messageTs(e) === "300.001");
  assert.ok(trigger, "the unprompted-follow entry carries its surface ts via entryTs");

  const r2 = await app.turn(
    channel("ok done?", {
      liveActor: true,
      triggerTs: "300.002",
      overheard: [{ ts: "300.001", role: "user", name: "Avery", text: followText }],
    }),
  );
  assert.equal(r2.status, "ok");
  const s2 = await app.getSession(r2.sessionId!);
  assert.deepEqual(
    overheardEntries(s2!.items).map((e) => messageTs(e)),
    [],
    "the unprompted follow is not doubled as overheard",
  );
  const withText = s2!.items.filter((e) => isUserMessage(e) && String(e.text ?? "").includes(followText));
  assert.equal(withText.length, 1, "recorded exactly once");
});

test("turn file context leads the environment block before the conversation header", async () => {
  const { app, blobTransfer } = freshApp();
  const blob = await blobTransfer.put(Buffer.from("notes"));

  const res = await app.turn(
    channel("what should I do with this?", {
      conversationHeader: "You are in #eng. People here: @Alice, @Bob. You are replying to a top-level message.",
      attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
    }),
  );

  assert.equal(res.status, "ok");
  const reply = res.reply ?? "";
  const requestAt = reply.indexOf("what should I do with this?");
  const envAt = reply.indexOf("<environment>");
  const inboxAt = reply.indexOf("The user shared 1 file");
  const headerAt = reply.indexOf("You are in #eng");
  const envEndAt = reply.indexOf("</environment>");
  assert.notEqual(requestAt, -1, "expected live user request");
  assert.notEqual(envAt, -1, "expected environment block");
  assert.notEqual(inboxAt, -1, "expected inbound attachment manifest");
  assert.notEqual(headerAt, -1, "expected conversation header");
  assert.notEqual(envEndAt, -1, "expected environment block close");
  assert.ok(requestAt < envAt, "live user request remains the leading turn content");
  assert.ok(envAt < inboxAt, "file manifest should be inside the environment block");
  assert.ok(inboxAt < headerAt, "file manifest should precede the conversation header");
  assert.ok(headerAt < envEndAt, "conversation header should remain inside the environment block");
});

test("the situational conversationHeader rides in the <environment> block, not as a message list", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    channel("@agent is this possible?", {
      conversationHeader: "You are in #design. People here: @U2, @U3. You are replying in a thread @U2 started.",
      priorTurns: [{ role: "user", name: "U2", text: "here's the original idea that started this thread" }],
    }),
  );
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /<environment>/);
  assert.match(res.reply ?? "", /People here: @U2, @U3/);
  const found = await app.getSession(res.sessionId!);
  const userEntry = found!.items.find((e) => isUserMessage(e));
  const userText = userEntry!.text ?? "";
  assert.doesNotMatch(userText, /original idea that started this thread/);
  assert.equal(userText, "@agent is this possible?");
  assert.doesNotMatch(userText, /<environment>/);
});

test("a reply in a thread the agent STARTED chimes in, even as a bare statement (deploy-notification-reply bug)", async () => {
  const { app } = freshApp();
  const bare = await app.turn(channel("looks good to me", { unprompted: true }));
  assert.equal(bare.status, "silent");
  const withOpener = await app.turn(
    channel("looks good to me", { unprompted: true, detectOpener: "deploy abc123 — auth refactor (#125)" }),
  );
  assert.equal(withOpener.status, "ok");
});

test("detectOpener drives turn detection but is NOT rendered into the prompt", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    channel("looks good to me", { unprompted: true, detectOpener: "deploy abc123 — auth refactor (#125)" }),
  );
  assert.equal(res.status, "ok");
  assert.doesNotMatch(res.reply ?? "", /auth refactor/);
});

test("an explicit (prompted) thread message always runs, even as a plain statement", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("ok sounds good to me"));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /You said: ok sounds good/);
});

test("read/write round-trip through the workspace", async () => {
  const { app } = freshApp();
  const w = await app.turn(dm("!write notes.md hello-workspace"));
  assert.equal(w.status, "ok");
  const r = await app.turn(dm("!read notes.md"));
  assert.equal(r.status, "ok");
  assert.match(r.reply ?? "", /hello-workspace/);
});
