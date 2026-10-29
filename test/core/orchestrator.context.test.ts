import { createConnectorStatusCache } from "../../src/credentials/connector-status.ts";
import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId, type TurnRequest } from "../../src/types.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "../support/test-config.ts";
import type { ProvisionOptions } from "../../src/sandbox/sandbox.ts";
import { verifyCapabilityToken } from "../../src/auth/capability-token.ts";
import { TURN_FILES_DIR, turnFileId } from "../../src/core/attachments.ts";
import { hashId } from "../../src/util/crypto.ts";
import { buildTestApp, freshApp, spyProvisioning, internalActor, dm } from "../support/orchestrator-app.ts";
import { selectDefaultSandbox } from "../support/default-sandbox.ts";
import { settle } from "../support/settle.ts";

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
  const claimsFor = async (request: Omit<TurnRequest, "actor">) => {
    captured = undefined;
    assert.equal((await app.turn({ ...request, actor: admin } as TurnRequest)).status, "ok");
    return (await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET))!;
  };

  let claims = await claimsFor({
    origin: { kind: "direct" },
    surface: "cron",
    conversation: { kind: "dm", threadRef: "dm:admin-alice:auto" },
    text: "!run echo hi",
  });
  assert.equal(claims!.liveActor, undefined, "an autonomous turn must not attest liveness");
  const autoPrompt = await app.turn({
    origin: { kind: "direct" },
    surface: "cron",
    actor: admin,
    conversation: { kind: "dm", threadRef: "dm:admin-alice:auto2" },
    text: "!sysprompt",
  });
  assert.doesNotMatch(autoPrompt.reply ?? "", /## Acting for an org admin|System administration is not limited/);

  claims = await claimsFor({
    surface: "test",
    conversation: {
      kind: "group",
      threadRef: "grp:G1:det",
      channelRef: "G1",
      audience: [admin],
      publishMembers: [admin, { externalId: "bob" }],
    },
    text: "!run echo hi",
    origin: { kind: "ambient", live: true },
  });
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
    origin: { kind: "ambient", live: true },
  });
  assert.match(threadPrompt.reply ?? "", /## Acting for an org admin/);
  assert.match(threadPrompt.reply ?? "", /System administration is not limited to the admin dashboard/);

  assert.equal(
    claims!.liveActor,
    undefined,
    "a thread reply attests authorship without pretending to be an explicit mention",
  );

  claims = await claimsFor({
    surface: "test",
    conversation: { kind: "dm", threadRef: "dm:admin-alice:det" },
    text: "!run echo hi",
    origin: { kind: "ambient", live: true },
  });
  assert.equal(claims!.liveActor, undefined, "a DM detection turn must not attest liveness");
  assert.equal(claims!.liveAuthor, undefined, "a DM detection turn must not attest authorship");

  claims = await claimsFor({
    surface: "test",
    conversation: { kind: "group", threadRef: "grp:G2:det", channelRef: "G2", audience: [admin] },
    text: "!run echo hi",
    origin: { kind: "ambient", live: true },
  });
  assert.equal(claims!.liveAuthor, undefined, "an unattested room must not attest authorship");

  claims = await claimsFor({
    surface: "test",
    conversation: { kind: "dm", threadRef: "dm:admin-alice:det2" },
    text: "!run echo hi",
    origin: { kind: "ambient" },
  });
  assert.equal(claims!.liveActor, undefined, "a synthetic detection turn must not attest liveness");
  assert.equal(claims!.liveAuthor, undefined, "a synthetic detection turn must not attest authorship");

  claims = await claimsFor({
    surface: "cron",
    conversation: { kind: "dm", threadRef: "dm:admin-alice:trigger-live" },
    text: "!run echo hi",
    origin: { kind: "automation" },
  });
  assert.equal(
    claims!.liveActor,
    undefined,
    "an automated turn must not attest liveness even when a caller also sets liveActor",
  );

  claims = await claimsFor({
    surface: "test",
    conversation: {
      kind: "channel",
      threadRef: "ch:C9:t1",
      channelRef: "C9",
      audience: [admin],
      publishMembers: [admin, { externalId: "visitor", isExternalGuest: true }],
    },
    text: "!run echo hi",
    origin: { kind: "human" },
  });
  assert.equal(claims!.liveActor, undefined, "guest-audience turns must not attest liveness");
  assert.equal(claims!.liveAuthor, undefined);

  for (const publishMembers of [undefined, [] as { externalId: string; orgId: string }[]]) {
    claims = await claimsFor({
      surface: "test",
      conversation: {
        kind: "channel",
        threadRef: `ch:C10:${publishMembers ? "empty" : "absent"}`,
        channelRef: "C10",
        audience: [admin],
        ...(publishMembers ? { publishMembers } : {}),
      },
      text: "!run echo hi",
      origin: { kind: "human" },
    });
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

test("turn-private transfer files are removed after staging, and a failed removal is reported", async () => {
  for (const fail of [false, true]) {
    const { app, sandbox, blobTransfer, errors } = freshApp();
    const blob = await blobTransfer.put(Buffer.from("inbound"));
    let usedHandle: Parameters<typeof sandbox.listDir>[0] | undefined;
    let cleanupAttempts = 0;
    const removeDir = sandbox.removeDir.bind(sandbox);
    sandbox.removeDir = async (handle, path) => {
      if (/^\.agent-turn\/[a-f0-9]{24}\/[a-z0-9]+-[a-f0-9]{24}$/.test(path)) {
        cleanupAttempts++;
        if (fail) throw new Error("cleanup failure");
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
    await settle(() => cleanupAttempts === 1);
    await settle(
      async () => (await errors.list()).filter((e) => e.code === "turn_files_cleanup_failed").length === (fail ? 1 : 0),
    );
    if (!fail) assert.deepEqual(await sandbox.listDir(usedHandle, TURN_FILES_DIR), []);
  }
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

test("connected-app prompt reads current tokens rather than a fresh stale cache", async () => {
  const config = testConfig({ signingSecret: "test-secret" });
  const built = buildTestApp(config, {
    env: { GOOGLE_OAUTH_CLIENT_ID: "test-google-id", GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret" },
  });
  const cache = createConnectorStatusCache(config.databaseUrl!);
  await cache.put({ principalId: "U1", checkedAt: Date.now(), providers: { google: { connected: false } } });
  await built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "google-token" });
  const connected = await built.app.turn(dm("!sysprompt"));
  assert.equal(connected.status, "ok");
  assert.match(connected.reply ?? "", /Connected: Google/);
  await built.connectorTokens.deleteConnectorToken("gmail.googleapis.com", "U1");
  await cache.put({ principalId: "U1", checkedAt: Date.now(), providers: { google: { connected: true } } });
  const disconnected = await built.app.turn(dm("!sysprompt"));
  assert.equal(disconnected.status, "ok");
  assert.doesNotMatch(disconnected.reply ?? "", /Connected: Google/);
});
