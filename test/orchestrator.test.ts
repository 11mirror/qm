import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutboundPost } from "../src/surfaces/outbound.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";
import { retryClock } from "./support/retry-clock.ts";
import { runNowSettled } from "./support/settle.ts";
import type { SandboxHandle, ProvisionOptions } from "../src/sandbox/sandbox.ts";
import { verifyCapabilityToken, EGRESS_PROXY_AUD, SANDBOX_CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { egressClaimAllowingControlPlane } from "../src/core/orchestrator.ts";
import { isReply, isUserMessage } from "../src/sessions/items.ts";
import { egressDecision } from "../src/resolution/egress-policy.ts";
import { encodeRef, serviceCredRef } from "../src/acl/resource-ref.ts";
import { runTrigger } from "../src/triggers/run-trigger.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { testMap } from "./support/test-database.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { buildTestApp, freshApp, internalActor, dm, channel, grantCred } from "./support/orchestrator-app.ts";

test("internal DM turn runs end-to-end and records the session", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("hello there"));
  assert.equal(res.status, "ok");
  assert.ok(res.sessionId);
  assert.match(res.reply ?? "", /You said: hello there/);

  const found = await app.getSession(res.sessionId!);
  const types = found!.items.map((e) => e.kind);
  assert.deepEqual(types, ["UserMessage", "AgentMessage"]);
});

test("human transcript entries retain authenticated identity across duplicate names and renames", async () => {
  const { app } = freshApp();
  for (const actor of [
    { externalId: "U1", displayName: "Alex" },
    { externalId: "U2", displayName: "Alex" },
    { externalId: "U1", displayName: "New Name" },
  ]) {
    const result = await app.turn(channel("hello", { actor, liveActor: true }));
    assert.equal(result.status, "ok", result.reason);
    const found = await app.getSession(result.sessionId!);
    const payload = found!.items.filter((entry) => isUserMessage(entry)).at(-1)!.body as {
      speakerId?: string;
      name?: string;
    };
    assert.equal(payload.speakerId, actor.externalId);
    assert.equal(payload.name, actor.displayName);
  }
});

test("the persisted assistant entry carries authoritative turn timing for transcript rendering", async () => {
  const { app } = freshApp();
  const before = Date.now();
  const res = await app.turn(dm("hello timing"));
  assert.equal(res.status, "ok");
  const found = await app.getSession(res.sessionId!);
  const assistant = found!.items.find((e) => isReply(e));
  const p = assistant!.body as { workStartedAt?: number; workFinishedAt?: number };
  assert.equal(typeof p.workStartedAt, "number", "turn start is persisted");
  assert.equal(typeof p.workFinishedAt, "number", "turn finish is persisted");
  assert.ok(p.workStartedAt! >= before && p.workFinishedAt! >= p.workStartedAt!);
});

test("the deployment turn wall-clock reaches the harness and a per-turn cap replaces it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { app } = freshApp({ turnWallClockMs: 120_000 });
  assert.equal((await app.turn(dm("!wallclock"))).reply, "wallclock:120000");
  assert.equal((await app.turn(dm("!wallclock", { turnWallClockMs: 70_000 }))).reply, "wallclock:70000");
  assert.equal((await app.turn(dm("!wallclock", { turnWallClockMs: 500_000 }))).reply, "wallclock:500000");
  assert.equal((await app.turn(dm("!wallclock", { turnWallClockMs: 0 }))).reply, "wallclock:120000");
  assert.equal((await freshApp().app.turn(dm("!wallclock"))).reply, "wallclock:0");
});

test("inbound file problems reach the model in the environment footer, not a log entry", async () => {
  const { app, sessions } = freshApp();
  const note = 'skipped "screenshot.png" — too many files in one message (max 10)';
  const res = await app.turn(dm("what's your favorite color", { inboundNotes: [note] }));
  assert.equal(res.status, "ok", res.reason);

  const entries = await sessions.getItems(res.sessionId!);
  assert.equal(
    entries.some(
      (e) =>
        ["ContextCompaction", "Error", "Stop", "Retraction", "Wake"].includes(e.kind) &&
        /screenshot\.png/.test(JSON.stringify(e)),
    ),
    false,
  );
  const user = entries.find((e) => isUserMessage(e));
  assert.match(
    String((user!.body as { environment?: unknown }).environment),
    /<environment>[\s\S]*did not reach \.\/inbox\/[\s\S]*screenshot\.png[\s\S]*<\/environment>/,
  );

  const reqs = (await sessions.listLlmRequests(res.sessionId!)) as Array<{ model: string; promptEnvelope: unknown }>;
  assert.ok(
    reqs
      .filter((request) => request.model !== "mock-security")
      .some((r) => /screenshot\.png/.test(JSON.stringify(r.promptEnvelope))),
    "the model sees the dropped file",
  );

  assert.equal((res as { fileNotes?: unknown }).fileNotes, undefined);
});

test("a failed turn still records which inbound files did not arrive", async () => {
  const { app, sessions, errors } = freshApp();
  const note = 'skipped "screenshot.png" — too many files in one message (max 10)';
  await assert.rejects(app.turn(dm("!boom", { inboundNotes: [note] })), /boom/);
  const { sessionId } = (await errors.list()).find((e) => e.category === "turn")!;
  const user = (await sessions.getItems(sessionId!)).find((e) => isUserMessage(e));
  assert.match(String((user?.body as { environment?: unknown } | undefined)?.environment), /screenshot\.png/);
});

test("a proactive-opener turn greets with no user text and records the seeding entry hidden", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("", { proactiveOpener: true }));
  assert.equal(res.status, "ok", res.reason);
  assert.match(res.reply ?? "", /just opened the app for the first time/);

  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    ["UserMessage", "AgentMessage"],
  );
  const userEntry = found!.items.find((e) => isUserMessage(e))!;
  assert.equal(userEntry.hidden, true, "the opener seed is hidden so no surface renders it");
});

test("a proactiveOpener turn that carries real text keeps the user entry visible", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("actually, here's my real question", { proactiveOpener: true }));
  assert.equal(res.status, "ok", res.reason);
  const found = await app.getSession(res.sessionId!);
  const userEntry = found!.items.find((e) => isUserMessage(e))!;
  assert.notEqual(userEntry.hidden, true, "a real typed message stays visible even on an opener-flagged turn");
});

test("a triggered turn records its synthetic wake prompt hidden so the chat never shows it as a user message", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    dm('<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>new output</why></wake>', {
      triggered: true,
    }),
  );
  assert.equal(res.status, "ok", res.reason);
  const found = await app.getSession(res.sessionId!);
  const userEntry = found!.items.find((e) => isUserMessage(e))!;
  assert.equal(userEntry.hidden, true, "the wake prompt is hidden so no surface renders it as a user message");
});

test("a 1:1 names the authenticated human in the prompt so the agent never asks who they are", async () => {
  const { app, sessions } = freshApp();
  const res = await app.turn(dm("hi", { actor: { externalId: "ada@acme.com", displayName: "Ada Lovelace" } }));
  assert.equal(res.status, "ok", res.reason);
  const sys = (await sessions.listLlmRequests(res.sessionId!)).at(-1)! as any;
  assert.match(sys.promptEnvelope.system, /live private 1:1 with Ada Lovelace \(ada@acme\.com\)/);
});

test("a channel turn gets no 1:1 identity block", async () => {
  const { app, sessions } = freshApp();
  const res = await app.turn(channel("hi", { actor: { externalId: "U1", displayName: "Ada" } }));
  assert.equal(res.status, "ok", res.reason);
  const sys = (await sessions.listLlmRequests(res.sessionId!)).at(-1)! as any;
  assert.doesNotMatch(sys.promptEnvelope.system, /## Who you're talking to/);
});

test("a silent cron source run stays out of normal human chat history", async () => {
  const built = freshApp();
  const cron = await built.app.createCron({
    schedule: { firstFireAt: Date.now() },
    action: "!preamble-then-quiet Posted the digest DM",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "principal", target: "U2", audienceScopeId: scopeId("personal", "U2"), onBehalfOf: "U1" },
  });

  await runNowSettled(built.scheduler, cron.id);

  assert.equal((await built.posts.pending("principal")).length, 0, "finish_silently means no delivery");
  const source = (await built.sessions.listByScope(scopeId("personal", "U1"))).find((s) =>
    s.threadRef.startsWith(`cron:${cron.id}:fire:`),
  );
  assert.ok(source, "cron source run is still durably recorded (in its per-fire background thread)");
  const sourceEntries = await built.sessions.getItems(source!.id);
  assert.ok(
    sourceEntries.some((e) => isReply(e)),
    "source run keeps its assistant output for audit/origin",
  );
  assert.equal(
    (await built.app.listSessions("U1")).some((s) => s.id === source!.id),
    false,
    "background cron source run is not a normal participant chat",
  );
});

test("a cron-delivered digest is noted in the recipient's next DM turn, not written into their transcript", async () => {
  const built = freshApp();
  const posted: OutboundPost[] = [];
  built.outbound.register(["principal"], async (post) => {
    posted.push(post);
    return { recipientThreadRef: "dm:D-alice" };
  });
  await built.app.upsertDirectory([
    { principalId: "U-carol", displayName: "Carol", type: "internal" },
    { principalId: "U-alice", displayName: "Alice", type: "internal" },
  ]);
  const cron = await built.app.createCron({
    schedule: { firstFireAt: Date.now() },
    action: "deploy digest ready",
    owner: "U-carol",
    createdBy: "U-carol",
    ownerScopeId: scopeId("personal", "U-carol"),
    destination: {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U-carol",
    },
  });

  await runNowSettled(built.scheduler, cron.id);
  const pending = posted;
  assert.equal(pending.length, 1);
  assert.match(pending[0]!.text, /deploy digest ready/);
  assert.match(pending[0]!.provenance?.fireKey ?? "", new RegExp(`^cron:${cron.id}:manual:`));

  let recipient = await built.sessions.getByThread("dm:D-alice");
  for (let i = 0; i < 50 && !recipient; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    recipient = await built.sessions.getByThread("dm:D-alice");
  }
  assert.ok(recipient, "recipient DM session exists once the post lands");
  assert.equal(
    (await built.sessions.getItems(recipient!.id)).some((e) => isReply(e)),
    false,
    "recipient transcript is not polluted with a fake assistant row",
  );

  const visibleToSender = await built.app.listSessions("U-carol");
  assert.equal(
    visibleToSender.some((s) => s.threadRef === pending[0]!.provenance?.sourceThreadRef),
    false,
    "cron source session does not show as a human conversation for the sender",
  );

  await built.app.turn({
    surface: "test",
    actor: { externalId: "U-alice" },
    conversation: { kind: "dm", threadRef: "dm:D-alice" },
    text: "what was that digest?",
  });
  const reqs = await built.sessions.listLlmRequests(recipient!.id);
  const latest = reqs.at(-1) as any;
  const footer = latest.promptEnvelope.messages.at(-1).content;
  assert.match(footer, /Delivered here since the user's last message/);
  assert.match(footer, /\[cron\] from U-carol: /);
  assert.match(footer, /…$/m);
  assert.doesNotMatch(footer, /deploy digest ready/);
});

test(
  "an inline turn retries its failed predecessor before executing without a background worker",
  { timeout: 10_000 },
  async (t) => {
    const backoff = retryClock(t);
    const built = freshApp();
    const { app, keychain } = built;
    assert.ok(keychain);

    const realGrantsForScope = keychain.grantsForScope.bind(keychain);
    const attempted: string[] = [];
    const claimForSession = built.runs.claimForSession.bind(built.runs);
    built.runs.claimForSession = async (...args) => {
      const run = await claimForSession(...args);
      if (run) attempted.push(run.request.text);
      return run;
    };
    let injectFailure = true;
    keychain.grantsForScope = async (...args: Parameters<typeof realGrantsForScope>) => {
      if (injectFailure) {
        injectFailure = false;
        throw new Error("injected setup failure");
      }
      return realGrantsForScope(...args);
    };

    await assert.rejects(app.turn(dm("hi")), /injected setup failure/);
    backoff();

    const res = await app.turn(dm("hi again"));
    assert.equal(res.status, "ok", res.reason);
    assert.doesNotMatch(res.reason ?? "", /session busy/);
    assert.deepEqual(attempted, ["hi", "hi", "hi again"]);
  },
);

test("a retried run RESUMES the interrupted turn from the durable ledger instead of restarting it", async (t) => {
  const backoff = retryClock(t);
  const { app } = freshApp();
  const req = dm("!work-then-boom", { idempotencyKey: "resume-1" });

  await assert.rejects(app.turn(req), /boom/);
  backoff();

  const res = await app.turn(req);
  assert.equal(res.status, "ok");
  assert.equal(res.sourceUserSeq, 0, "provenance points at the original interrupted user entry");
  assert.equal(res.sourceAssistantEntrySeq, 3);

  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    ["UserMessage", "ToolCall", "ToolResult", "AgentMessage"],
    "the retry continues after the recorded work without a new user entry",
  );
});

test("a retry of an attempt that recorded NO work continues from the recorded request without re-sending it", async (t) => {
  const backoff = retryClock(t);
  const { app } = freshApp();
  const req = dm("!boom", { idempotencyKey: "rerun-1" });

  await assert.rejects(app.turn(req), /boom/);
  backoff();

  const res = await app.turn(req);
  assert.equal(res.status, "ok");
  assert.equal(res.sourceUserSeq, 0, "provenance points at the original user entry");

  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    ["UserMessage", "AgentMessage"],
    "the human's request is recorded once and nothing else is added",
  );
  assert.notEqual(found!.items[0]!.hidden, true, "the original stays visible");
});

test("a guest actor is refused (internal-only, input side)", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "test",
    actor: { externalId: "G1", isExternalGuest: true },
    conversation: { kind: "dm", threadRef: "dm:G1:t1" },
    text: "hi",
  });
  assert.equal(res.status, "refused");
  assert.equal(res.refusalKind, "internal_only");
  assert.match(res.reason ?? "", /internal-only/);
});

test("a channel with a non-internal audience member is refused (internal-only, output side)", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "test",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "C1:t1",
      channelRef: "C1",
      audience: [internalActor, { externalId: "G9", isExternalGuest: true }],
    },
    text: "hello channel",
  });
  assert.equal(res.status, "refused");
  assert.equal(res.refusalKind, "internal_only");
  assert.match(res.reason ?? "", /internal-only/);
});

test("execute runs in the sandbox via the primitive", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!run echo sandbox-works"));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /sandbox-works/);
});

test("a per-turn egress-proxy token is minted and passed to provision, carrying the egress policy", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox } = buildTestApp(config);
  let captured: ProvisionOptions | undefined;
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return realProvision(layers, opts);
  };

  const res = await app.turn(dm("!run echo go"));
  assert.equal(res.status, "ok");
  assert.ok(captured?.egressToken, "provision must receive a per-turn egressToken");

  const claims = await verifyCapabilityToken(captured!.egressToken!, TEST_CAPABILITY_SECRET);
  assert.ok(claims, "the egress token must verify with the capability secret");
  assert.equal(claims!.aud, EGRESS_PROXY_AUD);
  assert.deepEqual(captured!.egress, { allowedHosts: [], deniedHosts: [] });
});

test("large channel turns apply the compression rollout setting to every sandbox token", async () => {
  for (const capabilityTokenCompression of [false, true]) {
    const { app, sandbox } = buildTestApp(
      testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com", capabilityTokenCompression }),
    );
    let captured: ProvisionOptions | undefined;
    const provision = sandbox.provision.bind(sandbox);
    sandbox.provision = (layers, opts) => {
      captured = opts;
      return provision(layers, opts);
    };
    const members = Array.from({ length: 120 }, (_, i) => ({
      externalId: i === 0 ? "U1" : `U${i + 1}-compression-fixture`,
    }));
    const result = await app.turn(
      channel("!run echo compact", {
        conversation: {
          kind: "channel",
          threadRef: "ch:C1:compact",
          channelRef: "C1",
          audience: members,
          publishMembers: members,
        },
      }),
    );
    assert.equal(result.status, "ok");
    for (const token of [
      captured?.env?.AGENT_API_TOKEN,
      captured?.env?.AGENT_OAUTH_CONSENT_TOKEN,
      captured?.egressToken,
    ]) {
      assert.ok(token);
      const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
      assert.equal(payload.encoding, capabilityTokenCompression ? "deflate-raw" : undefined);
      if (capabilityTokenCompression) assert.ok(token.length < 8 * 1024);
      const verified = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
      assert.equal(verified?.members?.length, 120);
    }
  }
});

test("live bot attestation reaches control, OAuth, and egress capabilities", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox } = buildTestApp(config);
  let captured: ProvisionOptions | undefined;
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return realProvision(layers, opts);
  };
  const actor = { externalId: "B-LEGACY", isBot: true };
  const res = await app.turn(
    channel("!run echo bot", {
      actor,
      botActor: true,
      liveActor: true,
      conversation: {
        kind: "channel",
        threadRef: "ch:C1:bot",
        channelRef: "C1",
        isPrivate: true,
        audience: [actor],
        publishMembers: [actor],
      },
    }),
  );
  assert.equal(res.status, "ok");
  for (const token of [
    captured!.env!.AGENT_API_TOKEN,
    captured!.env!.AGENT_OAUTH_CONSENT_TOKEN,
    captured!.egressToken,
  ]) {
    const claims = await verifyCapabilityToken(token!, TEST_CAPABILITY_SECRET);
    assert.equal(claims?.botActor, true);
    assert.equal(claims?.liveActor, true);
    assert.deepEqual(claims?.members, [{ id: "B-LEGACY", type: "internal" }]);
  }
});

test("Composio backend access is announced without delivering the project key", async () => {
  const { app, serviceCreds, acl, sandbox } = freshApp({
    apiBaseUrl: "https://core.example.com",
    signingSecret: "test-secret",
  });
  let captured: ProvisionOptions | undefined;
  const provision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return provision(layers, opts);
  };
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "composio",
    name: "Composio",
    delivery: "env",
    envKey: "COMPOSIO_API_KEY",
    secret: "synthetic-composio-secret",
    host: "backend.composio.dev",
  });
  const prompt = async (suffix: string) => {
    const result = await app.turn(
      dm("!sysprompt", { conversation: { kind: "dm", threadRef: `dm:U1:discovery-${suffix}` } }),
    );
    assert.equal(result.status, "ok");
    assert.doesNotMatch(result.reply ?? "", /synthetic-composio-secret/);
    return result.reply ?? "";
  };
  assert.doesNotMatch(await prompt("ungranted"), /COMPOSIO_API_KEY/);
  await grantCred(acl, org, "composio");
  const granted = await prompt("granted");
  assert.match(granted, /## Connected app access/);
  assert.match(granted, /Composio is configured in the backend/);
  assert.doesNotMatch(granted, /`composio`/);
  await assert.rejects(
    app.turn(
      dm(`!execute ${JSON.stringify({ command: "true", credentials: ["composio"] })}`, {
        conversation: { kind: "dm", threadRef: "dm:U1:composio-explicit" },
      }),
    ),
    /not available/,
  );
  assert.doesNotMatch(granted, /COMPOSIO_API_KEY/);
  assert.doesNotMatch(granted, /Do not suggest or offer any app connection/);
  const result = await app.turn(
    dm("!run echo backend-only", { conversation: { kind: "dm", threadRef: "dm:U1:composio-backend" } }),
  );
  assert.equal(result.status, "ok");
  assert.equal(captured?.env?.COMPOSIO_API_KEY, undefined);
  const claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.ownerConnections, true);
  const listServiceCredentials = serviceCreds.listServiceCredentials.bind(serviceCreds);
  serviceCreds.listServiceCredentials = async (...args) =>
    (await listServiceCredentials(...args)).map((record) =>
      record.slug === "composio" ? { ...record, delivery: "broker" } : record,
    );
  const brokerDelivery = await prompt("backend-broker-delivery");
  assert.match(brokerDelivery, /Composio is configured in the backend/);
  assert.doesNotMatch(brokerDelivery, /`composio`|Shared org credentials available to you/);
  serviceCreds.listServiceCredentials = listServiceCredentials;
  await acl.revoke(org, encodeRef(serviceCredRef("composio")), org, "admin@default-org");
  assert.doesNotMatch(await prompt("revoked"), /COMPOSIO_API_KEY/);
  await grantCred(acl, org, "composio");
  await serviceCreds.setServiceCredential(org, {
    slug: "composio",
    name: "Composio",
    delivery: "env",
    envKey: "COMPOSIO_API_KEY",
    secret: "synthetic-composio-secret",
    host: "backend.composio.dev",
    enabled: false,
  });
  assert.doesNotMatch(await prompt("disabled"), /COMPOSIO_API_KEY/);
});

test("org credentials are delivered only when requested and read live after rotation", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox, serviceCreds, acl } = buildTestApp(config);
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
  });
  await grantCred(acl, org, "browse-steel");
  await grantCred(acl, org, "browse-model-key");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-model-key",
    name: "Browse model key",
    delivery: "env",
    envKey: "BROWSE_LAB_ANTHROPIC_KEY",
    secret: "model-org-key",
    host: "",
  });
  const captures: ProvisionOptions[] = [];
  const executions: SandboxHandle[] = [];
  const realRun = sandbox.run.bind(sandbox);
  sandbox.run = (handle, command, opts) => {
    executions.push(handle);
    return realRun(handle, command, opts);
  };
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    if (opts) captures.push(opts);
    return realProvision(layers, opts);
  };

  const request = `!execute ${JSON.stringify({ command: "echo keys", credentials: ["browse-steel", "browse-model-key"] })}`;
  let res = await app.turn(dm(request, { conversation: { kind: "dm", threadRef: "dm:U1:env1" } }));
  assert.equal(res.status, "ok");
  assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined);
  assert.equal(executions.findLast((handle) => handle.env?.STEEL_API_KEY)?.env?.STEEL_API_KEY, "steel-org-key");
  assert.equal(
    executions.findLast((handle) => handle.env?.BROWSE_LAB_ANTHROPIC_KEY)?.env?.BROWSE_LAB_ANTHROPIC_KEY,
    "model-org-key",
  );

  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-rotated",
    host: "",
  });
  res = await app.turn(dm(request, { conversation: { kind: "dm", threadRef: "dm:U1:env2" } }));
  assert.equal(res.status, "ok");
  assert.equal(
    executions.findLast((handle) => handle.env?.STEEL_API_KEY)?.env?.STEEL_API_KEY,
    "steel-rotated",
    "secret is read for each execution",
  );
});

test("a disabled or broker-delivery credential never rides provision env", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox, serviceCreds, acl } = buildTestApp(config);
  const org = scopeId("org", "default-org");
  await grantCred(acl, org, "x-firehose");
  await grantCred(acl, org, "browse-steel");
  await serviceCreds.setServiceCredential(org, {
    slug: "x-firehose",
    name: "X",
    secret: "broker-bearer",
    host: "api.x.com",
  });
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
    enabled: false,
  });
  const captures: ProvisionOptions[] = [];
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    if (opts) captures.push(opts);
    return realProvision(layers, opts);
  };

  const res = await app.turn(dm("!sysprompt", { conversation: { kind: "dm", threadRef: "dm:U1:env3" } }));
  assert.equal(res.status, "ok");
  assert.doesNotMatch(res.reply ?? "", /browse-steel/g);
  const env = captures.at(-1)?.env ?? {};
  assert.equal(env.STEEL_API_KEY, undefined, "disabled env credential stays home");
  assert.ok(
    !Object.values(env).includes("broker-bearer"),
    "a broker credential's secret never appears in the sandbox env",
  );
});

test("a credential flipped away from env between the metadata read and the secret read stays home", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox, serviceCreds, acl } = buildTestApp(config);
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
  });
  await grantCred(acl, org, "browse-steel");
  const realGet = serviceCreds.getServiceCredentialSecret.bind(serviceCreds);
  serviceCreds.getServiceCredentialSecret = async (scope, slug) => {
    const rec = await realGet(scope, slug);
    return rec && slug === "browse-steel" ? { ...rec, delivery: "broker", envKey: undefined, host: "steel.dev" } : rec;
  };
  const captures: ProvisionOptions[] = [];
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    if (opts) captures.push(opts);
    return realProvision(layers, opts);
  };

  await assert.rejects(
    app.turn(
      dm(`!execute ${JSON.stringify({ command: "echo keys", credentials: ["browse-steel"] })}`, {
        conversation: { kind: "dm", threadRef: "dm:U1:env4" },
      }),
    ),
    /Service credential is no longer available/,
  );
  assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined);
});

test("env-delivery credentials are not offered to an external audience", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox, serviceCreds, acl } = buildTestApp(config);
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
  });
  await grantCred(acl, org, "browse-steel");
  const captures: ProvisionOptions[] = [];
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    if (opts) captures.push(opts);
    return realProvision(layers, opts);
  };

  const externalRoom = await app.turn(
    dm("!sysprompt", {
      conversation: {
        kind: "channel",
        threadRef: "ch:C9:t9",
        channelRef: "C9",
        audience: [internalActor],
        publishMembers: [internalActor, { externalId: "visitor", isExternalGuest: true }],
      },
    }),
  );
  assert.equal(externalRoom.status, "ok");
  assert.doesNotMatch(externalRoom.reply ?? "", /browse-steel/g);
  assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined, "a room with externals gets no org env credentials");
});

test("a channel cron receives env credentials only when the directory proves an all-internal roster", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox, serviceCreds, acl, outbound, identity } = buildTestApp(config);
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
  });
  await grantCred(acl, org, "browse-steel");
  const captures: ProvisionOptions[] = [];
  const executions: SandboxHandle[] = [];
  const realRun = sandbox.run.bind(sandbox);
  sandbox.run = (handle, command, opts) => {
    executions.push(handle);
    return realRun(handle, command, opts);
  };
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    if (opts) captures.push(opts);
    return realProvision(layers, opts);
  };
  const directory = createPostgresDirectoryStore(testDatabaseUrl());
  await directory.replace([
    { principalId: "U1", displayName: "One", type: "internal" },
    { principalId: "U2", displayName: "Two", type: "internal" },
  ]);
  await directory.replaceChannels(
    [
      { channelId: "C-internal", name: "internal" },
      { channelId: "C-unsynced", name: "unsynced" },
      { channelId: "C-shared", name: "shared", isExternal: true },
      { channelId: "C-guest", name: "guest" },
    ],
    [
      { channelId: "C-internal", principalId: "U1" },
      { channelId: "C-internal", principalId: "U2" },
      { channelId: "C-shared", principalId: "U1" },
      { channelId: "C-shared", principalId: "U2" },
      { channelId: "C-guest", principalId: "U1" },
      { channelId: "C-guest", principalId: "visitor" },
    ],
    undefined,
    ["C-internal", "C-shared", "C-guest"],
  );
  const fire = async (channelId: string) => {
    const out = await runTrigger(
      {
        outbound,
        idempotency: createIdempotencyStore(testMap()),
        identity,
        run: (req) => app.turn(req),
        directory,
      },
      {
        owner: "U1",
        ownerScopeId: scopeId("channel", channelId),
        input:
          channelId === "C-internal"
            ? `!execute ${JSON.stringify({ command: "echo keys", credentials: ["browse-steel"] })}`
            : "!sysprompt",
        fireKey: `cron:${channelId}:1`,
        surface: "cron",
      },
    );
    assert.equal(out.status, "ok", `the ${channelId} cron turn runs`);
    assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined);
    if (channelId !== "C-internal") {
      assert.doesNotMatch(out.reply ?? "", /browse-steel/);
      return undefined;
    }
    return executions.findLast((handle) => handle.env?.STEEL_API_KEY)?.env?.STEEL_API_KEY;
  };
  assert.equal(await fire("C-internal"), "steel-org-key", "an all-internal synced roster admits the env credential");
  assert.equal(await fire("C-unsynced"), undefined, "a channel with no synced roster stays fail-closed");
  assert.equal(await fire("C-shared"), undefined, "an externally shared channel stays fail-closed");
  assert.equal(await fire("C-guest"), undefined, "a roster with a non-internal principal stays fail-closed");
});

test("env-delivery credentials are gated by service-cred grants — no grant, no env var; a person grant admits only that person", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox, serviceCreds, acl } = buildTestApp(config);
  const org = scopeId("org", "default-org");
  await serviceCreds.setServiceCredential(org, {
    slug: "browse-steel",
    name: "Steel",
    delivery: "env",
    envKey: "STEEL_API_KEY",
    secret: "steel-org-key",
    host: "",
  });
  const captures: ProvisionOptions[] = [];
  const executions: SandboxHandle[] = [];
  const realRun = sandbox.run.bind(sandbox);
  sandbox.run = (handle, command, opts) => {
    executions.push(handle);
    return realRun(handle, command, opts);
  };
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    if (opts) captures.push(opts);
    return realProvision(layers, opts);
  };

  let res = await app.turn(dm("!sysprompt", { conversation: { kind: "dm", threadRef: "dm:U1:gate1" } }));
  assert.equal(res.status, "ok");
  assert.doesNotMatch(res.reply ?? "", /browse-steel/g);
  assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined, "ungranted env credential stays home");

  await grantCred(acl, org, "browse-steel", scopeId("personal", "somebody-else"));
  res = await app.turn(dm("!sysprompt", { conversation: { kind: "dm", threadRef: "dm:U1:gate2" } }));
  assert.equal(res.status, "ok");
  assert.doesNotMatch(res.reply ?? "", /browse-steel/g);
  assert.equal(captures.at(-1)?.env?.STEEL_API_KEY, undefined, "a grant to someone else does not admit this actor");

  await grantCred(acl, org, "browse-steel", scopeId("personal", "U1"));
  res = await app.turn(
    dm(`!execute ${JSON.stringify({ command: "echo keys", credentials: ["browse-steel"] })}`, {
      conversation: { kind: "dm", threadRef: "dm:U1:gate3" },
    }),
  );
  assert.equal(res.status, "ok");
  assert.equal(
    executions.findLast((handle) => handle.env?.STEEL_API_KEY)?.env?.STEEL_API_KEY,
    "steel-org-key",
    "a personal grant to the actor admits the env var",
  );
});

test("admin-configured browse step limit rides provision env (BROWSE_LAB_MAX_STEPS)", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const built = buildTestApp(config);
  const { app, sandbox } = built;
  let captured: ProvisionOptions | undefined;
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return realProvision(layers, opts);
  };

  const res = await app.turn(dm("!run echo steps"));
  assert.equal(res.status, "ok");
  assert.equal(
    captured?.env?.BROWSE_LAB_MAX_STEPS,
    undefined,
    "no injection when unset — the skill's own default applies",
  );
  assert.equal(
    captured?.env?.BROWSE_LAB_MODEL,
    "claude-opus-5",
    "with no override the browse model follows the deployment base model",
  );
  assert.equal(captured?.env?.BROWSE_LAB_MODEL_PROVIDER, "managed", "the runner uses core model routing");

  await built.config.setSetting("browseMaxSteps", 120, "org:default-org");
  await built.config.setSetting("browseModel", "claude-sonnet-4-6", "org:default-org");
  const res2 = await app.turn(dm("!run echo steps again"));
  assert.equal(res2.status, "ok");
  assert.equal(captured?.env?.BROWSE_LAB_MAX_STEPS, "120", "the configured limit rides the provision env");
  assert.equal(
    captured?.env?.BROWSE_LAB_MODEL,
    "claude-opus-5",
    "legacy browse-only overrides cannot replace the default model",
  );
});

test("a legacy browse-only model cannot strand managed default-model browsing", async () => {
  const config = testConfig({ orgId: "acme", signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const built = buildTestApp(config);
  const { app, sandbox } = built;
  let captured: ProvisionOptions | undefined;
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return realProvision(layers, opts);
  };

  await built.config.setSetting("browseModel", "claude-retired-by-pi-ai", "org:acme");
  const res = await app.turn(dm("!run echo keys", { conversation: { kind: "dm", threadRef: "dm:U1:stale1" } }));
  assert.equal(res.status, "ok");
  assert.equal(
    captured?.env?.BROWSE_LAB_MODEL,
    "claude-opus-5",
    "the unresolvable override is ignored in favour of the base model, not propagated",
  );
  assert.equal(captured?.env?.BROWSE_LAB_MODEL_PROVIDER, "managed");
});

test("browse follows a live org base model change, not the process-start default", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const built = buildTestApp(config);
  const { app, sandbox } = built;
  let captured: ProvisionOptions | undefined;
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return realProvision(layers, opts);
  };

  let res = await app.turn(dm("!run echo keys", { conversation: { kind: "dm", threadRef: "dm:U1:live1" } }));
  assert.equal(res.status, "ok");
  assert.equal(captured?.env?.BROWSE_LAB_MODEL, "claude-opus-5", "starts on the deployment default");

  await built.config.setRuntimeSelection("org:default-org", { modelId: "gpt-5.6-sol" });
  res = await app.turn(dm("!run echo keys", { conversation: { kind: "dm", threadRef: "dm:U1:live2" } }));
  assert.equal(res.status, "ok");
  assert.equal(
    captured?.env?.BROWSE_LAB_MODEL,
    "gpt-5.6-sol",
    "an admin changing the org base model moves browse too, without a restart",
  );
  assert.equal(captured?.env?.BROWSE_LAB_MODEL_PROVIDER, "managed");
});

test("an OpenAI deployment provisions managed browser access without its provider key", async () => {
  const config = testConfig({
    orgId: "acme",
    signingSecret: "test-secret",
    apiBaseUrl: "https://core.example.com",
    modelId: "gpt-5.6-sol",
    openaiApiKey: "openai-org-key",
  });
  const { app, sandbox } = buildTestApp(config);
  let captured: ProvisionOptions | undefined;
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return realProvision(layers, opts);
  };

  const res = await app.turn(dm("!run echo keys", { conversation: { kind: "dm", threadRef: "dm:U1:oa1" } }));
  assert.equal(res.status, "ok");
  assert.equal(captured?.env?.BROWSE_LAB_MODEL, "gpt-5.6-sol");
  assert.equal(captured?.env?.BROWSE_LAB_MODEL_PROVIDER, "managed", "core selects the provider");
  assert.ok(!Object.values(captured?.env ?? {}).includes("openai-org-key"));
  const claims = await verifyCapabilityToken(captured!.env!.BROWSE_LAB_MODEL_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.browserModel, "gpt-5.6-sol");
  assert.equal(claims?.browserAccount, "company");
});

test("turn timezone rides the prompt and control-plane capability token", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox } = buildTestApp(config);
  let captured: ProvisionOptions | undefined;
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return realProvision(layers, opts);
  };

  const res = await app.turn(dm("!run echo tz", { timezone: "America/New_York" }));
  assert.equal(res.status, "ok");
  const claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims!.timezone, "America/New_York");
  assert.equal(claims!.surface, "test");

  const slackThread = { kind: "dm" as const, threadRef: "dm:U1:slack-wake" };
  await app.turn(dm("!run echo slack", { surface: "slack", conversation: slackThread }));
  captured = undefined;
  await app.turn(dm("!run echo wake", { surface: "monitor", conversation: slackThread }));
  const wake = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(wake!.surface, "slack", "a wake in a Slack thread keeps the conversation's surface");
  captured = undefined;
  await app.turn(dm("!run echo web", { surface: "web", conversation: slackThread }));
  const web = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(web!.surface, "web", "a live web UI turn is a web turn even in a Slack-labelled conversation");

  const prompt = await app.turn(
    dm("!sysprompt", { conversation: { kind: "dm", threadRef: "dm:U1:tz-prompt" }, timezone: "America/New_York" }),
  );
  assert.match(prompt.reply ?? "", /\(America\/New_York\)/);

  captured = undefined;
  const invalid = await app.turn(
    dm("!run echo bad-tz", { conversation: { kind: "dm", threadRef: "dm:U1:bad-tz" }, timezone: "not-a-zone" }),
  );
  assert.equal(invalid.status, "ok");
  const invalidClaims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(invalidClaims!.timezone, undefined, "invalid surface timezones are omitted from the token");
});

test("sandbox-facing turn tokens expire after the 48-hour sandbox capability lifetime", async () => {
  const ttl = SANDBOX_CAPABILITY_TTL_MS;
  const { app, sandbox, serviceCreds, acl } = freshApp({
    signingSecret: "test-secret",
    apiBaseUrl: "https://core.example.com",
  });
  await serviceCreds.setServiceCredential("org:default-org", {
    slug: "test-service",
    name: "Test service",
    secret: "synthetic",
    host: "api.example.com",
  });
  await grantCred(acl, "org:default-org", "test-service");
  let captured: ProvisionOptions | undefined;
  let executed: Record<string, string> | undefined;
  const provision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return provision(layers, opts);
  };
  const run = sandbox.run.bind(sandbox);
  sandbox.run = (handle, command, opts) => {
    if (command === "echo ttl") executed = handle.env;
    return run(handle, command, opts);
  };
  const before = Date.now();
  const res = await app.turn(dm(`!execute ${JSON.stringify({ command: "echo ttl", credentials: ["test-service"] })}`));
  assert.equal(res.status, "ok", res.reason);
  const tokens = {
    AGENT_API_TOKEN: captured!.env!.AGENT_API_TOKEN!,
    AGENT_OAUTH_CONSENT_TOKEN: captured!.env!.AGENT_OAUTH_CONSENT_TOKEN!,
    AGENT_CREDENTIAL_TOKEN: executed!.AGENT_CREDENTIAL_TOKEN!,
    egressToken: captured!.egressToken!,
  };
  for (const [name, token] of Object.entries(tokens)) {
    const claims = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
    assert.ok(claims, `${name} verifies`);
    assert.ok(claims.exp >= before + ttl && claims.exp <= Date.now() + ttl, name);
    assert.ok(await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET, claims.exp - 1));
    assert.equal(await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET, claims.exp), null);
  }
});

test("unattended grants enter capability claims only on non-live turns", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox } = buildTestApp(config);
  let captured: ProvisionOptions | undefined;
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return realProvision(layers, opts);
  };

  await app.turn(dm("!run echo cron", { triggered: true, unattendedGrants: ["admin.sessions.read"] }));
  let claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.deepEqual(claims?.grants, ["admin.sessions.read"]);

  await app.turn(
    dm("!run echo live", {
      liveActor: true,
      conversation: { kind: "dm", threadRef: "dm:U1:live-grant" },
      unattendedGrants: ["admin.sessions.read"],
    }),
  );
  claims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.grants, undefined);
});

test("the egress claim keeps the control-plane host reachable under an allowlist or a matching denylist", () => {
  const core = "https://core.example.com";

  const a = egressClaimAllowingControlPlane({ allowedHosts: ["api.github.com"] }, core)!;
  assert.deepEqual(a.allowedHosts, ["api.github.com", "core.example.com"]);
  assert.equal(egressDecision("core.example.com", a).allow, true);
  assert.equal(egressDecision("evil.com", a).allow, false, "the allowlist still bites everything else");

  const d = egressClaimAllowingControlPlane({ allowedHosts: [], deniedHosts: ["example.com", "tracker.io"] }, core)!;
  assert.equal(egressDecision("core.example.com", d).allow, true, "core must not be denied");
  assert.equal(egressDecision("tracker.io", d).allow, false, "unrelated denies survive");

  assert.equal(egressClaimAllowingControlPlane({ allowedHosts: [] }, core), undefined);

  const auto = egressClaimAllowingControlPlane({ allowedHosts: [] }, core, true)!;
  assert.deepEqual(auto, {
    allowedHosts: [],
    denyPrivateNetworks: true,
    privateNetworkAllowedHosts: ["core.example.com"],
  });
  assert.equal(egressDecision("api.github.com", auto).allow, true, "Auto keeps public internet capability");

  const withoutControlPlane = egressClaimAllowingControlPlane({ allowedHosts: [] }, "", true)!;
  assert.deepEqual(withoutControlPlane, { allowedHosts: [], denyPrivateNetworks: true });
});

test("identity grounding: the roster lists this conversation's participants by their canonical directory name", async () => {
  const { app, directory } = freshApp();
  await directory.replace([
    { principalId: "U1", displayName: "Alice Example", type: "internal" },
    { principalId: "U2", displayName: "Renee Mars", type: "internal" },
    { principalId: "U3", displayName: "taylor", type: "internal" },
    { principalId: "U9", displayName: "Outsider Olive", type: "internal" },
  ]);
  const prompt = await app.turn({
    surface: "slack",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "ch:roster:t1",
      channelRef: "C-roster",
      audience: [internalActor, { externalId: "U2" }, { externalId: "U3" }],
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  assert.match(sp, /## Who's in this conversation/);
  assert.match(sp, /Alice Example \(U1\)/);
  assert.match(sp, /Renee Mars \(U2\)/);
  assert.match(sp, /taylor \(U3\)/);
  assert.doesNotMatch(sp, /Outsider Olive/);
});

test("identity grounding: the roster is bounded (caps at ROSTER_CAP and reports the overflow)", async () => {
  const { app, directory } = freshApp();
  const many = Array.from({ length: 30 }, (_, i) => ({
    principalId: `U${i}`,
    displayName: `Person ${i}`,
    type: "internal" as const,
  }));
  await directory.replace(many);
  const prompt = await app.turn({
    surface: "slack",
    actor: { externalId: "U0" },
    conversation: {
      kind: "channel",
      threadRef: "ch:roster-big:t1",
      channelRef: "C-roster-big",
      audience: many.map((m) => ({ externalId: m.principalId })),
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  const listed = (sp.match(/- Person \d+ \(U\d+\)/g) ?? []).length;
  assert.equal(listed, 20, "the roster caps the number of people listed");
  assert.match(sp, /…and 10 more in this conversation\./);
});

test("identity grounding: a participant who hasn't synced into the directory still grounds from the surface name", async () => {
  const { app, directory } = freshApp();
  await directory.replace([{ principalId: "U1", displayName: "Alice Example", type: "internal" }]);
  const prompt = await app.turn({
    surface: "slack",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "ch:roster-partial:t1",
      channelRef: "C-roster-partial",
      audience: [internalActor, { externalId: "U7", displayName: "Newcomer Nat" }],
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  assert.match(sp, /Alice Example \(U1\)/);
  assert.match(sp, /Newcomer Nat \(U7\)/);
});

test("identity grounding: a cased-vs-lowercase duplicate participant resolves to the single real directory member", async () => {
  const { app, directory } = freshApp();
  await directory.replace([
    { principalId: "U1", displayName: "Jordan Lee", type: "internal" },
    { principalId: "alice@acme.com", displayName: "Alice Wonderland", type: "internal" },
  ]);
  const prompt = await app.turn({
    surface: "slack",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "ch:roster-case:t1",
      channelRef: "C-roster-case",
      audience: [
        internalActor,
        { externalId: "Alice@acme.com", displayName: "Cased Alias" },
        { externalId: "alice@acme.com" },
      ],
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  assert.match(
    sp,
    /Alice Wonderland \(alice@acme\.com\)/,
    "the cased participant grounds as the canonical directory member",
  );
  assert.doesNotMatch(sp, /Cased Alias/, "no synthetic fallback entry when the person is in the directory");
  assert.equal((sp.match(/Alice/g) ?? []).length, 1, "the duplicate is listed exactly once");
});

test("an org admin's live turn carries the admin prompt hint and a liveness claim; a regular user's does not", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox } = buildTestApp(config);
  let captured: ProvisionOptions | undefined;
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return realProvision(layers, opts);
  };

  const adminTurn = (extra: Partial<TurnRequest> = {}): TurnRequest => ({
    surface: "test",
    actor: { externalId: "admin-alice" },
    conversation: { kind: "dm", threadRef: "dm:admin-alice:t1" },
    text: "!run echo hi",
    liveActor: true,
    ...extra,
  });

  assert.equal((await app.turn(adminTurn())).status, "ok");
  const adminClaims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(adminClaims!.liveActor, true, "a human-initiated turn attests liveness in the token");

  const adminPrompt = await app.turn(
    adminTurn({ text: "!sysprompt", conversation: { kind: "dm", threadRef: "dm:admin-alice:t2" } }),
  );
  assert.match(adminPrompt.reply ?? "", /## Acting for an org admin/);
  assert.match(adminPrompt.reply ?? "", /use the hand-off skill even if admin access could reach it/);
  assert.match(adminPrompt.reply ?? "", /System administration is not limited to the admin dashboard/);
  assert.match(adminPrompt.reply ?? "", /including resources owned by other users/);
  assert.match(adminPrompt.reply ?? "", /Ordinary resource-owner restrictions do not by themselves prohibit/);
  assert.match(adminPrompt.reply ?? "", /admin grant changes and impersonation are portal-only/);
  assert.match(
    adminPrompt.reply ?? "",
    /private-content reads require a DM or an Open conversation on a live admin turn/,
  );
  assert.doesNotMatch(
    adminPrompt.reply ?? "",
    /private-content reads work only from a DM|bulk configuration imports require/,
  );

  const userPrompt = await app.turn(dm("!sysprompt"));
  assert.doesNotMatch(userPrompt.reply ?? "", /## Acting for an org admin|System administration is not limited/);
});
