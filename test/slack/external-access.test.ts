import "../support/auto-fake-sprites.ts";
import {
  createSlackCoreClient,
  type SlackCoreClientDeps,
  type SlackCoreClient,
} from "../../src/api/slack-core-client.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companySlackActor,
  externalSlackNamespace,
  extractPrivateContinuation,
  parseExternalSlackAccess,
} from "../../src/slack/external-access.ts";
import { slackAccountConfigsFromEnv, slackPluginConfigFromEnv } from "../../src/slack/config.ts";
import { continueInPrivate, PRIVATE_CONTINUATION_ACK } from "../../src/slack/private-continuation.ts";
import { createSlackSender } from "../../src/slack/sender.ts";
import { type TurnRequest, scopeId } from "../../src/types.ts";
import { createDirectory } from "../../src/slack/directory.ts";
import { createTurnHandler } from "../../src/slack/turn-handler.ts";
import { automationOrigin } from "../support/turn-origin.ts";
import { Readable } from "node:stream";
import { buildApp } from "../support/build-app.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "../support/test-config.ts";
import { encodeRef, serviceCredRef } from "../../src/acl/resource-ref.ts";
import { verifyCapabilityToken, type CapabilityClaims } from "../../src/auth/capability-token.ts";
import { externalTools } from "../../src/core/orchestrator/external-tools.ts";
import type { ToolContext } from "../../src/tools/primitives.ts";
import { selectDefaultSandbox } from "../support/default-sandbox.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { claimTurn, testRunStore } from "../support/turns.ts";

const policy = {
  companyDomains: ["company.example"],
  companyTeamIds: ["TCOMPANY"],
  serviceCredentials: ["public-search"],
};
const employee = { id: "UEMPLOYEE", team_id: "TCOMPANY", profile: { email: " Employee@Company.Example " } };

test("external workspace identity requires company workspace membership and an exact email domain", () => {
  assert.equal(companySlackActor(employee, policy).externalId, "employee@company.example");
  assert.equal(companySlackActor({ ...employee, is_stranger: true }, policy).isExternalGuest, false);
  for (const user of [
    undefined,
    { id: "UNOEMAIL", team_id: "TPARTNER" },
    { ...employee, team_id: "TPARTNER" },
    { ...employee, team_id: undefined },
    { ...employee, is_restricted: true },
    { ...employee, is_ultra_restricted: true },
    { ...employee, deleted: true },
    { ...employee, is_bot: true },
    ...["founder@outside.example", "e@company.example.evil", "e@sub.company.example", "e@@company.example"].map(
      (email) => ({ ...employee, profile: { email } }),
    ),
  ])
    assert.equal(companySlackActor(user, policy).isExternalGuest, true);
  assert.equal(companySlackActor(employee, { ...policy, companyTeamIds: [] }).isExternalGuest, true);
});

test("external access is opt-in per workspace and rejects malformed allowlists", () => {
  const base = { SLACK_BOT_TOKEN: "synthetic-bot", SLACK_APP_TOKEN: "synthetic-app" };
  assert.equal(slackPluginConfigFromEnv(base)?.externalAccess, undefined);
  const configs = slackAccountConfigsFromEnv({
    SLACK_ACCOUNTS: JSON.stringify([
      { id: "internal", botToken: base.SLACK_BOT_TOKEN, appToken: base.SLACK_APP_TOKEN },
      { id: "external", botToken: base.SLACK_BOT_TOKEN, appToken: base.SLACK_APP_TOKEN, externalAccess: policy },
      {
        id: "http",
        botToken: base.SLACK_BOT_TOKEN,
        signingSecret: "synthetic",
        externalAccess: policy,
      },
    ]),
  });
  assert.equal(configs[0]?.externalAccess, undefined);
  assert.deepEqual(configs[1]?.externalAccess, policy);
  assert.deepEqual(configs[2]?.externalAccess, policy);
  assert.deepEqual(
    slackPluginConfigFromEnv({ ...base, SLACK_EXTERNAL_ACCESS: JSON.stringify(policy) })?.externalAccess,
    policy,
  );
  for (const value of [
    true,
    {},
    { companyDomains: [] },
    { companyDomains: ["*.company.example"] },
    { companyDomains: policy.companyDomains },
    { ...policy, companyTeamIds: [] },
    { ...policy, companyTeamIds: "TCOMPANY" },
    { ...policy, companyTeamIds: [""] },
    { ...policy, companyTeamIds: [" company "] },
    { ...policy, companyTeamIds: [42] },
    { ...policy, serviceCredentials: "all" },
  ])
    assert.throws(() => parseExternalSlackAccess(value));
  assert.deepEqual(
    parseExternalSlackAccess({
      companyDomains: ["COMPANY.EXAMPLE", "company.example"],
      companyTeamIds: ["TCOMPANY", "TANOTHER", "TCOMPANY"],
    }),
    {
      companyDomains: ["company.example"],
      companyTeamIds: ["TANOTHER", "TCOMPANY"],
      serviceCredentials: [],
    },
  );
});

test("external account directory lookups admit only company workspace DMs", async () => {
  for (const [snapshot, teamId] of [
    [false, "TPARTNER"],
    [true, "TPARTNER"],
    [false, "TCOMPANY"],
    [true, "TCOMPANY"],
  ] as const) {
    const user = { ...employee, team_id: teamId };
    const trusted = teamId === "TCOMPANY";
    const turns: Omit<TurnRequest, "surface">[] = [];
    const personalScopes: string[] = [];
    const ids = {
      ownTeamId: "TPARTNER",
      botUserId: "BOT",
      ownBotId: "B1",
      botHandle: "bot",
      ownWorkspaceUrl: "",
      identityMode: "email" as const,
    };
    const client = {
      async *paginate() {
        yield { members: snapshot ? [user] : [] };
      },
      users: { info: async () => ({ user }) },
    };
    const directory = createDirectory({
      core: {} as SlackCoreClient,
      ids,
      externalAccess: policy,
      coreSingleton: false,
    });
    const actor = (await directory.classifyUserCached(client, user.id)).actor;
    assert.equal(actor.isExternalGuest, !trusted);
    assert.equal(actor.externalId, trusted ? "employee@company.example" : employee.id);
    const handler = createTurnHandler({
      externalAccess: policy,
      directory,
      ids,
      core: {},
      mirror: { mirrorMessageEvent: async () => {} },
      flow: {
        callCore: async (turn: Omit<TurnRequest, "surface">) => {
          turns.push(turn);
          return { status: "silent" };
        },
      },
      ackEmoji: { requestAckEmoji: async () => undefined, ackPickCandidates: () => [] },
      ensureHeader: (_client: unknown, _channel: string, scope: string) => personalScopes.push(scope),
    } as unknown as Parameters<typeof createTurnHandler>[0]);
    await handler.handleIncoming(
      {
        kind: "dm",
        channel: "DPRIVATE",
        userId: user.id,
        rawText: "hello",
        files: [],
        ts: "1.0",
      },
      client,
    );
    assert.equal(turns.length, trusted ? 1 : 0);
    assert.deepEqual(personalScopes, trusted ? ["personal:employee@company.example"] : []);
    if (trusted) {
      assert.equal(turns[0]?.source?.policyNamespace, externalSlackNamespace("TPARTNER", policy));
      assert.equal(turns[0]?.externalSlack, undefined);
    }
  }
});

test("scope namespace changes when workspace or authorization policy changes", () => {
  const original = externalSlackNamespace("TPARTNER", policy);
  assert.match(original, /^external-slack:TPARTNER:/);
  assert.notEqual(original, externalSlackNamespace("TOTHER", policy));
  assert.notEqual(original, externalSlackNamespace("TPARTNER", { ...policy, serviceCredentials: [] }));
  assert.notEqual(original, externalSlackNamespace("TPARTNER", { ...policy, companyTeamIds: ["TOTHER"] }));
});

test("private continuation directive is self-only and strips incomplete directives", () => {
  assert.deepEqual(extractPrivateContinuation("OK [[continue-private: schedule with the people above]]"), {
    text: "OK",
    task: "schedule with the people above",
  });
  assert.deepEqual(extractPrivateContinuation("OK [[continue-private: partial"), { text: "OK" });
});

function handoffFixture() {
  const source: TurnRequest = {
    surface: "slack",
    actor: { externalId: "employee@company.example" },
    externalSlack: { accountId: "partner", teamId: "TPARTNER", userId: "UEMPLOYEE", ...policy },
    conversation: {
      kind: "group",
      threadRef: "external-slack:TPARTNER:policy:group:CEXTERNAL:1",
      channelRef: "external-slack:TPARTNER:policy:CEXTERNAL",
    },
    deliveryTarget: "CEXTERNAL:1.0",
    text: "Invite Alex and Morgan next Tuesday.",
    priorTurns: [{ role: "user", text: "Alex: alex@outside.example; Morgan: morgan@outside.example" }],
    attachments: [{ name: "agenda.txt", mimetype: "text/plain", blobId: "public-agenda", sizeBytes: 8 }],
    origin: { kind: "direct" },
  };
  const submissions: Omit<TurnRequest, "surface">[] = [];
  const work = new Set<string>();
  const posts: Record<string, any>[] = [];
  const opened: string[] = [];
  const client = {
    users: { info: async () => ({ user: employee }) },
    conversations: {
      open: async ({ users }: { users: string }) => {
        opened.push(users);
        return { channel: { id: "DPRIVATE" } };
      },
      replies: async () => ({ messages: posts }),
      history: async () => ({ messages: posts }),
    },
    chat: {
      postMessage: async (args: Record<string, any>) => {
        posts.push({ ...args, ts: "2.0" });
        return { ts: "2.0" };
      },
    },
  };
  const core = {
    privateContinuationSource: async () => source,
    waitRun: async () => ({ status: "ok", reply: "Synthetic private answer" }),
    ackRunDelivery: async () => {},
    submitTurn: async (request: Omit<TurnRequest, "surface">) => {
      submissions.push(request);
      work.add(request.idempotencyKey!);
      return { status: "queued", runId: "dm-run" };
    },
  } as unknown as SlackCoreClient;
  return { source, submissions, work, posts, opened, client, core };
}

test("handoff preserves request and participant list, runs in requester DM, and retries one work item", async () => {
  const f = handoffFixture();
  const lookup = (id: string) => {
    assert.equal(id, "partner");
    return { client: f.client, teamId: "TPARTNER", policy };
  };
  await continueInPrivate(f.core, "source-run", "Create the invite using my calendar", lookup);
  await continueInPrivate(f.core, "source-run", "Create the invite using my calendar", lookup);
  assert.deepEqual(f.opened, ["UEMPLOYEE", "UEMPLOYEE"]);
  assert.equal(f.work.size, 1);
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[0]?.text, PRIVATE_CONTINUATION_ACK);
  assert.equal(f.posts[1]?.channel, "DPRIVATE");
  assert.equal(f.posts[1]?.text, "Synthetic private answer");
  const request = f.submissions[0]!;
  assert.equal(request.actor.externalId, f.source.actor.externalId);
  assert.equal(request.conversation.kind, "dm");
  assert.equal(request.externalSlack, undefined);
  assert.equal(request.source?.policyNamespace, externalSlackNamespace("TPARTNER", policy));
  assert.equal(request.deliveryTarget, "DPRIVATE");
  assert.match(request.conversation.threadRef, /^slack-account:TPARTNER:/);
  assert.match(request.text, /Invite Alex and Morgan/);
  assert.deepEqual(request.priorTurns, f.source.priorTurns);
  assert.deepEqual(request.attachments, f.source.attachments);
  assert.equal(request.origin?.kind, "human");
  assert.equal(automationOrigin(request)?.destination, undefined);
  assert.equal(request.deliveryCandidates, undefined);
});

test("handoff fails closed on revoked identity, wrong workspace, and missing DM", async () => {
  for (const scenario of ["revoked", "home-workspace", "workspace", "no-dm"]) {
    const f = handoffFixture();
    if (scenario === "revoked")
      f.client.users.info = async () => ({ user: { ...employee, profile: { email: "outside@outside.example" } } });
    if (scenario === "home-workspace")
      f.client.users.info = async () => ({ user: { ...employee, team_id: "TPARTNER" } });
    if (scenario === "no-dm") f.client.conversations.open = async () => ({ channel: { id: "CNOTADM" } });
    await assert.rejects(
      continueInPrivate(f.core, "source", "private task", () => ({
        client: f.client,
        teamId: scenario === "workspace" ? "TOTHER" : "TPARTNER",
        policy,
      })),
    );
    assert.equal(f.submissions.length, 0);
    assert.equal(f.posts.length, 0);
  }
});

test("a recovered private result posts only through its originating account", async () => {
  const posts: unknown[] = [];
  const client = {
    conversations: { history: async () => ({ messages: [] }) },
    chat: {
      postMessage: async (args: unknown) => {
        posts.push(args);
        return { ts: "3" };
      },
    },
  };
  const send = createSlackSender({
    core: {} as never,
    flow: { inFlightRuns: new Set() } as never,
    threads: { mark: () => {} } as never,
    clientForAccount: (id) => {
      assert.equal(id, "partner");
      return client;
    },
    externalNamespace: () => externalSlackNamespace("TPARTNER", policy),
    defaultClient: {
      chat: {
        postMessage: () => {
          throw new Error("default account used");
        },
      },
    },
  });
  await send({
    idempotencyKey: "run:dm-run",
    text: "Synthetic private result",
    createdAt: Date.now() - 30_000,
    destination: {
      type: "slack",
      target: "DPRIVATE",
      slackAccountId: "partner",
      slackPolicyNamespace: externalSlackNamespace("TPARTNER", policy),
    },
  });
  assert.equal(posts.length, 1);
  assert.equal((posts[0] as { channel: string }).channel, "DPRIVATE");
});

test("an external account's sender neither borrows a missing default identity nor releases pre-policy answers", async () => {
  for (const [hasDefault, target, slackPolicyNamespace] of [
    [false, "CSHARED", undefined],
    [true, "CSHARED", undefined],
    [true, "DPRIVATE", undefined],
    [true, "DPRIVATE", externalSlackNamespace("TPARTNER", { ...policy, companyTeamIds: ["TOTHER"] })],
  ] as const) {
    const client = {
      chat: {
        postMessage: () => {
          throw new Error("legacy data released");
        },
      },
    };
    const send = createSlackSender({
      core: {} as never,
      flow: { inFlightRuns: new Set() } as never,
      threads: {} as never,
      clientForAccount: (id) => {
        assert.equal(id, "default");
        return hasDefault ? client : undefined;
      },
      externalNamespace: () => externalSlackNamespace("TPARTNER", policy),
    });
    const post = send({
      idempotencyKey: "run:legacy",
      text: "Synthetic pre-policy private answer",
      createdAt: 1,
      destination: { type: "slack", target, ...(slackPolicyNamespace ? { slackPolicyNamespace } : {}) },
    });
    if (hasDefault) assert.equal(await post, undefined);
    else await assert.rejects(post, /Slack account default is not connected/);
  }
});

test("delegated human-origin runs cannot restart themselves as a person's private continuation", async () => {
  const { runs } = testRunStore();
  const client = createSlackCoreClient({ runs } as SlackCoreClientDeps);
  const request = {
    surface: "slack",
    actor: { id: "employee", type: "internal" as const },
    conversation: { kind: "dm" as const, threadRef: "external:dm", audience: [] },
    origin: { kind: "human" as const },
    externalSlack: { accountId: "partner", teamId: "TPARTNER", userId: "UEMPLOYEE", ...policy },
    text: "continue privately",
  };
  const direct = await runs.enqueue({ sessionId: request.conversation.threadRef, request });
  assert.ok(await client.privateContinuationSource!(direct.run.id));
  for (const provenance of [{ sessionSenderId: "child" }, { delegatingRunId: direct.run.id }]) {
    const delegated = await runs.enqueue({
      sessionId: request.conversation.threadRef,
      request: { ...request, ...provenance },
    });
    assert.equal(await client.privateContinuationSource!(delegated.run.id), null);
  }
});

test("private continuation extraction skips code, keeps the first directive, and stays linear-time on an opener flood", () => {
  assert.deepEqual(
    extractPrivateContinuation("OK [[continue-private: a [[continue-private: b]] tail [[continue-private: c]]"),
    { text: "OK", task: "b" },
  );
  assert.deepEqual(extractPrivateContinuation("Use `[[continue-private: like this]]` to hand off"), {
    text: "Use `[[continue-private: like this]]` to hand off",
  });
  assert.deepEqual(extractPrivateContinuation("Plain reply"), { text: "Plain reply" });
  const flood = "][[continue-private:".repeat(25_000) + "]";
  const started = performance.now();
  const out = extractPrivateContinuation(flood);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1_000, `opener flood took ${Math.round(elapsed)}ms`);
  assert.deepEqual(out, { text: "]" });
});

const corePolicy = { companyDomains: ["example.com"], companyTeamIds: ["TCOMPANY"], serviceCredentials: ["safe"] };
const externalSlackPolicies = { batch: corePolicy };
const namespace = externalSlackNamespace("T1", corePolicy);
function request(text: string): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: "U1" },
    origin: { kind: "human" },
    externalSlack: {
      accountId: "batch",
      teamId: "T1",
      userId: "U1",
      companyDomains: ["example.com"],
      companyTeamIds: ["TCOMPANY"],
      serviceCredentials: ["safe"],
    },
    conversation: {
      kind: "channel",
      channelRef: `${namespace}:C1`,
      threadRef: `${namespace}:C1:thread`,
      audience: [{ externalId: "U1" }, { externalId: "outsider", isExternalGuest: true }],
    },
    text,
  };
}

test("external Slack strips private and org preloads before the prompt, but keeps shared-safe code useful", async (t) => {
  const b = buildApp(
    testConfig({
      memoryCapture: "off",
      externalSlackPolicies,
      signingSecret: "synthetic-signing-key",
      apiBaseUrl: "https://core.example.test",
    }),
  );
  await b.config.hydrate?.();
  await b.identity.hydrate();
  await b.start();
  t.after(async () => {
    await b.runtime.stop();
  });
  await b.config.setInstructions("org:default-org", "ORG_INSTRUCTIONS_SENTINEL");
  await b.memory.capture("personal:U1", ["PERSONAL_MEMORY_SENTINEL"], Date.now(), "U1");
  await b.memory.capture("org:default-org", ["ORG_MEMORY_SENTINEL"], Date.now(), "U1");
  await b.workspace.write("org:default-org", "secret.txt", "ORG_FILE_SENTINEL");
  await b.workspace.write("personal:U1", "secret.txt", "PERSONAL_FILE_SENTINEL");
  for (const slug of ["safe", "confidential"]) {
    await b.serviceCreds.setServiceCredential("org:default-org", {
      slug,
      name: slug,
      delivery: "env",
      envKey: slug.toUpperCase(),
      secret: `SYNTHETIC_${slug}`,
      host: "",
    });
    await b.acl.grant({
      ownerScopeId: "org:default-org",
      ref: encodeRef(serviceCredRef(slug)),
      granteeScopeId: "org:default-org",
      permission: "read",
      grantedBy: "U1",
    });
  }
  const mustNotRead = async (): Promise<never> => {
    throw new Error("PRIVATE_PRELOAD_CALLED");
  };
  b.keychain!.listByOwners = mustNotRead;
  b.keychain!.listByOwner = mustNotRead;
  b.keychain!.grantsForScope = mustNotRead;
  b.keychain!.listConnectorsByOwners = mustNotRead;
  const prompt = await b.app.turn(request("!sysprompt"));
  assert.equal(prompt.status, "ok", JSON.stringify(prompt));
  assert.doesNotMatch(
    prompt.reply!,
    /PERSONAL_MEMORY_SENTINEL|ORG_MEMORY_SENTINEL|ORG_INSTRUCTIONS_SENTINEL|PERSONAL_FILE_SENTINEL|ORG_FILE_SENTINEL|confidential/,
  );
  assert.match(prompt.reply!, /safe/);
  await selectDefaultSandbox(b, "U1", scopeId("channel", `${namespace}:C1`));
  const provisions: string[][] = [];
  const provision = b.sandbox.provision.bind(b.sandbox);
  b.sandbox.provision = (layers, opts) => {
    provisions.push(layers.map((l) => l.scopeId));
    return provision(layers, opts);
  };
  const run = b.sandbox.run.bind(b.sandbox);
  const seenClaims: CapabilityClaims[] = [];
  let safeEnv;
  b.sandbox.run = async (handle, command, opts) => {
    if (handle.env?.AGENT_API_TOKEN)
      seenClaims.push((await verifyCapabilityToken(handle.env.AGENT_API_TOKEN, TEST_CAPABILITY_SECRET))!);
    if (handle.env?.SAFE) safeEnv = handle.env.SAFE;
    assert.equal(handle.env?.CONFIDENTIAL, undefined);
    return run(handle, command, opts);
  };
  const code = await b.app.turn(
    request(`!execute ${JSON.stringify({ command: "printf external-code-ok", credentials: ["safe"] })}`),
  );
  assert.equal(code.status, "ok", JSON.stringify(code));
  assert.match(code.reply!, /external-code-ok/);
  assert.equal(safeEnv, "SYNTHETIC_safe");
  assert.ok(provisions.length);
  assert.ok(provisions.every((scopes) => scopes.every((scope) => scope.startsWith("channel:external-slack:"))));
  assert.equal(seenClaims.at(-1)?.externalSlack, true);
  assert.equal(seenClaims.at(-1)?.ownerConnections, undefined);
  const missing = request("!sysprompt");
  delete missing.externalSlack;
  assert.equal((await b.app.turn(missing)).status, "refused");
  const privateRequest = {
    ...missing,
    slackSource: { accountId: "batch", teamId: "T1", userId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "slack-account:T1:dm:D1" },
  };
  assert.equal((await b.app.turn(privateRequest)).status, "refused");
  assert.equal((await b.app.turn({ ...privateRequest, slackSource: undefined })).status, "refused");
});

test("external native tool ceiling cannot delegate, switch sandboxes, read confidential data or invoke MCP", async () => {
  let runs = 0;
  const tools = externalTools(
    new Proxy({} as ToolContext, {
      get: () => () => {
        runs++;
        return Promise.resolve("ok");
      },
    }),
    () => Promise.reject(new Error("no private access to that sandbox")),
  );
  await tools.execute("printf safe");
  assert.equal(runs, 1);
  for (const opts of [{ scratch: true }, { reachTarget: "private" }, { sandboxId: "private" }])
    await assert.rejects(tools.execute("unsafe", opts), /private access/);
  for (const call of [
    () => tools.memoryRead(),
    () => tools.read("global/secret"),
    () => tools.callMcpTool("private", {}),
    () => tools.cronList(),
  ])
    assert.throws(call, /private access/);
  assert.equal(tools.sessionSyscalls, undefined);
  assert.equal(runs, 1);
});

test("external broker requires the current run lease and both external-safe and ordinary grants", async () => {
  const { externalSlackCapabilityAllowed } = await import("../../src/api/external-slack-capability.ts");
  const { createAclStore } = await import("../../src/acl/acl-store.ts");
  const { runs, ledger } = testRunStore();
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const req = request("test");
  const { run: queued } = await runs.enqueue({
    sessionId: req.conversation.threadRef,
    request: {
      ...req,
      actor: { id: "U1", type: "internal" },
      conversation: { ...req.conversation, publishMembers: undefined, audience: [{ id: "U1", type: "internal" }] },
      origin: { kind: "human" },
    },
  });
  const { run, token } = (await claimTurn(ledger, queued.id))!;
  const claims: CapabilityClaims = {
    actorId: "U1",
    scopeId: `channel:${namespace}:C1`,
    aud: "credential-broker",
    externalSlack: true,
    credentials: ["safe"],
    runId: run.id,
    runAttempt: run.attempts,
    runLeaseToken: token,
    threadRef: run.sessionId,
    exp: Date.now() + 60_000,
  };
  assert.equal(await externalSlackCapabilityAllowed(claims, { runs, acl, externalSlackPolicies }), false);
  for (const slug of ["safe", "confidential"])
    await acl.grant({
      ownerScopeId: "org:default-org",
      ref: encodeRef(serviceCredRef(slug)),
      granteeScopeId: "org:default-org",
      permission: "read",
      grantedBy: "U1",
    });
  assert.equal(await externalSlackCapabilityAllowed(claims, { runs, acl, externalSlackPolicies }), true);
  assert.equal(
    await externalSlackCapabilityAllowed(claims, {
      runs,
      acl,
      externalSlackPolicies: { batch: { ...corePolicy, serviceCredentials: [] } },
    }),
    false,
  );

  for (const patch of [
    { credentials: ["confidential"] },
    { runLeaseToken: "stale" },
    { actorId: "U2" },
    { scopeId: "personal:U1" },
    { runAttempt: run.attempts + 1 },
  ])
    assert.equal(
      await externalSlackCapabilityAllowed({ ...claims, ...patch }, { runs, acl, externalSlackPolicies }),
      false,
    );
  await acl.revoke("org:default-org", encodeRef(serviceCredRef("safe")), "org:default-org", "U1");
  assert.equal(await externalSlackCapabilityAllowed(claims, { runs, acl, externalSlackPolicies }), false);
});

test("external policy changes invalidate retained requests while untouched workspaces stay unchanged", async () => {
  const { externalSlackRequestAllowed } = await import("../../src/resolution/external-slack.ts");
  const req = request("test");
  assert.equal(externalSlackRequestAllowed(req, externalSlackPolicies), true);
  assert.equal(externalSlackRequestAllowed(req, {}), false);
  assert.equal(externalSlackRequestAllowed(req, { batch: { ...corePolicy, serviceCredentials: [] } }), false);
  assert.equal(externalSlackRequestAllowed(req, { batch: { ...corePolicy, companyTeamIds: ["TOTHER"] } }), false);
  const legacy = {
    ...req,
    externalSlack: undefined,
    conversation: { ...req.conversation, channelRef: "C1", threadRef: "C1:old" },
  };
  assert.equal(externalSlackRequestAllowed(legacy, externalSlackPolicies), false);
  assert.equal(externalSlackRequestAllowed({ ...legacy, surface: "web" }, externalSlackPolicies, true), false);
  assert.equal(
    externalSlackRequestAllowed(
      { ...legacy, slackSource: { accountId: "staff", teamId: "STAFF", userId: "U1" } },
      externalSlackPolicies,
    ),
    true,
  );
  assert.equal(
    externalSlackRequestAllowed({ ...legacy, conversation: { kind: "dm", threadRef: "dm:U1" } }, externalSlackPolicies),
    true,
  );
});

test("external account DMs require admission under the current policy", async () => {
  const { externalSlackRequestAllowed } = await import("../../src/resolution/external-slack.ts");
  const dm = {
    surface: "slack",
    conversation: { kind: "dm" as const, threadRef: "slack-account:T1:dm:D1" },
    slackSource: { accountId: "batch", teamId: "T1", userId: "U1" },
  };
  assert.equal(externalSlackRequestAllowed(dm, externalSlackPolicies), false);
  assert.equal(externalSlackRequestAllowed({ ...dm, slackSource: undefined }, externalSlackPolicies), false);
  const current = { ...dm, slackSource: { ...dm.slackSource, externalPolicyNamespace: namespace } };
  assert.equal(externalSlackRequestAllowed(current, externalSlackPolicies), true);
  for (const changed of [
    { ...corePolicy, companyTeamIds: ["TOTHER"] },
    { ...corePolicy, companyDomains: ["other.example"] },
    { ...corePolicy, serviceCredentials: [] },
  ])
    assert.equal(externalSlackRequestAllowed(current, { batch: changed }), false);
  assert.equal(externalSlackRequestAllowed(dm, {}), true);
});

test("external sandbox API token cannot reach private APIs, while its safe broker token works", async (t) => {
  const { createServer } = await import("../../src/api/server.ts");
  const { mintCapabilityToken } = await import("../../src/auth/capability-token.ts");
  const { serverDeps } = await import("../../src/wiring.ts");
  const config = testConfig({ signingSecret: "synthetic-signing-key-for-http-test", externalSlackPolicies });
  const b = buildApp(config);
  await b.identity.hydrate();
  t.after(async () => {
    await b.runtime.stop();
  });
  await b.serviceCreds.setServiceCredential("org:default-org", {
    slug: "safe",
    name: "safe",
    host: "public.example",
    delivery: "broker",
    secret: "SYNTHETIC_BROKER_SECRET",
  });
  await b.acl.grant({
    ownerScopeId: "org:default-org",
    ref: encodeRef(serviceCredRef("safe")),
    granteeScopeId: "org:default-org",
    permission: "read",
    grantedBy: "U1",
  });
  const req = request("test");
  const { run: queued } = await b.runs.enqueue({
    sessionId: req.conversation.threadRef,
    request: {
      ...req,
      actor: { id: "U1", type: "internal" },
      conversation: { ...req.conversation, publishMembers: undefined, audience: [{ id: "U1", type: "internal" }] },
      origin: { kind: "human" },
    },
  });
  const { run, token } = (await claimTurn(b.turnLedger, queued.id))!;
  let forwarded = 0;
  const server = createServer(b.app, {
    ...serverDeps(config, b),
    brokerFetch: async () => {
      forwarded++;
      return { status: 200, contentType: "application/json", text: async () => '{"public":"ok"}' };
    },
    credentialHttpFetch: async () => {
      forwarded++;
      return { status: 200, headers: {}, body: Readable.from(["0000"]) };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const claims: CapabilityClaims = {
    actorId: "U1",
    scopeId: `channel:${namespace}:C1`,
    externalSlack: true,
    runId: run.id,
    runAttempt: run.attempts,
    runLeaseToken: token,
    threadRef: run.sessionId,
    exp: Date.now() + 60_000,
  };
  const control = await mintCapabilityToken({ ...claims, aud: "control-plane" }, TEST_CAPABILITY_SECRET);
  for (const path of ["/v1/apis", "/v1/keychain", "/v1/admin/whoami", "/v1/admin/memory", "/v1/memory", "/v1/crons"])
    assert.equal((await fetch(`${base}${path}`, { headers: { "x-agent-capability": control } })).status, 403, path);
  const broker = await mintCapabilityToken(
    { ...claims, aud: "credential-broker", credentials: ["safe"] },
    TEST_CAPABILITY_SECRET,
  );
  const call = (token: string) =>
    fetch(`${base}/v1/credentials/broker`, {
      method: "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      body: JSON.stringify({ credential: "safe", url: "https://public.example/data", method: "GET" }),
    });
  const git = (token: string) =>
    fetch(`${base}/v1/credentials/http/safe/repo.git/info/refs`, { headers: { "x-agent-capability": token } });
  assert.equal((await call(control)).status, 403);
  assert.equal((await git(control)).status, 403);
  const success = await call(broker);
  assert.equal(success.status, 200, await success.text());
  assert.equal((await git(broker)).status, 200);
  assert.equal(forwarded, 2);
  externalSlackPolicies.batch = { ...corePolicy, serviceCredentials: [] };
  try {
    assert.equal((await call(broker)).status, 403);
    assert.equal((await git(broker)).status, 403);
    assert.equal(forwarded, 2);
  } finally {
    externalSlackPolicies.batch = corePolicy;
  }
});
