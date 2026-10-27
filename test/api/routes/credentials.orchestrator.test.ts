import "../../support/auto-fake-sprites.ts";
import { selectDefaultSandbox } from "../../support/default-sandbox.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { type TurnRequest } from "../../../src/types.ts";
import { verifyCapabilityToken, CREDENTIAL_BROKER_AUD } from "../../../src/auth/capability-token.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "../../support/test-config.ts";
import { recorded } from "../../support/recorded.ts";
import { ADMIN, start, putCred, getCfg, SECRET } from "../../support/service-credentials.ts";
import { failedTurn } from "../../support/orchestrator-app.ts";
import { buildTestApp } from "../../support/test-app.ts";

const internalActor = { externalId: "U1" };
const dm = (text: string): TurnRequest => ({
  origin: { kind: "direct" },
  surface: "test",
  actor: internalActor,
  conversation: { kind: "dm", threadRef: "dm:U1:t1" },
  text,
});

function buildWithCapture() {
  const built = buildTestApp(testConfig({ maxAttempts: 1, signingSecret: SECRET, apiBaseUrl: "http://core.internal" }));
  let captured: Record<string, string> | undefined;
  const realProvision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = async (layers, opts) => {
    captured = opts?.env;
    return realProvision(layers, opts);
  };
  let executed: Record<string, string> | undefined;
  const realRun = built.sandbox.run.bind(built.sandbox);
  built.sandbox.run = (handle, command, opts) => {
    if (command === "echo hi" || command === "echo bot") executed = handle.env;
    return realRun(handle, command, opts);
  };
  return { built, env: () => captured, executionEnv: () => executed };
}

test("orchestrator vends a capability for only the requested org credential", async () => {
  const { built, env, executionEnv } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "x-firehose",
    name: "X",
    secret: "s",
    host: "api.x.com",
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:x-firehose",
    granteeScopeId: "org:default-org",
    permission: "read",
    grantedBy: "admin",
  });

  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "unselected",
    name: "Unselected",
    secret: "synthetic-unused",
    host: "other.example.com",
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:unselected",
    granteeScopeId: "org:default-org",
    permission: "read",
    grantedBy: "admin",
  });
  await selectDefaultSandbox(built, "U1", "personal:U1", "channel:C1");
  await built.app.turn(dm("!run echo hi"));
  assert.equal(executionEnv()?.AGENT_CREDENTIAL_TOKEN, undefined);
  const res = await built.app.turn(
    dm(`!execute ${JSON.stringify({ command: "echo hi", credentials: ["x-firehose"] })}`),
  );
  assert.equal(res.status, "ok", res.reason);
  assert.equal(env()?.AGENT_CREDENTIAL_TOKEN, undefined);
  const token = executionEnv()?.AGENT_CREDENTIAL_TOKEN;
  assert.ok(token, "expected a credential-broker token in the sandbox env");
  const claims = await verifyCapabilityToken(token!, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.aud, CREDENTIAL_BROKER_AUD);
  assert.deepEqual(claims?.credentials, ["x-firehose"]);

  const actor = { externalId: "B-LEGACY", isBot: true };
  await built.app.turn({
    surface: "slack",
    actor,
    botActor: true,
    conversation: {
      kind: "channel",
      threadRef: "ch:C1:bot",
      channelRef: "C1",
      isPrivate: true,
      audience: [actor],
      publishMembers: [actor],
    },
    text: `!execute ${JSON.stringify({ command: "echo bot", credentials: ["x-firehose"] })}`,
    origin: { kind: "human" },
  });
  const botClaims = await verifyCapabilityToken(executionEnv()!.AGENT_CREDENTIAL_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(botClaims?.botActor, true);
  assert.equal(botClaims?.liveActor, true);
  assert.deepEqual(botClaims?.members, [{ id: "B-LEGACY", type: "internal" }]);
});

test("orchestrator does NOT stamp a credential granted only to someone else", async () => {
  const { built, env } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "x-firehose",
    name: "X",
    secret: "s",
    host: "api.x.com",
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:x-firehose",
    granteeScopeId: "personal:U2",
    permission: "read",
    grantedBy: "admin",
  });
  await selectDefaultSandbox(built, "U1", "personal:U1");

  await failedTurn(
    built,
    dm(`!execute ${JSON.stringify({ command: "echo hi", credentials: ["x-firehose"] })}`),
    /not available/,
  );
  const res = await built.app.turn(dm("!run echo hi"));
  assert.equal(res.status, "ok", res.reason);
  assert.equal(env()?.AGENT_CREDENTIAL_TOKEN, undefined, "an unentitled session must get no credential token");
});

test("a channel grantee stamps the credential in that channel's conversations and nowhere else", async () => {
  const { built, env, executionEnv } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "x-firehose",
    name: "X",
    secret: "s",
    host: "api.x.com",
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:x-firehose",
    granteeScopeId: "channel:C1",
    permission: "read",
    grantedBy: "admin",
  });

  const channelTurn = (channelRef: string): TurnRequest => ({
    origin: { kind: "direct" },
    surface: "slack",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: `ch:${channelRef}:t1`,
      channelRef,
      audience: [internalActor, { externalId: "U2" }],
      publishMembers: [internalActor, { externalId: "U2" }],
    },
    text: "!run echo hi",
  });

  await selectDefaultSandbox(built, "U1", "channel:C1", "channel:C2", "personal:U1");
  await built.app.turn(channelTurn("C1"));
  assert.equal(executionEnv()?.AGENT_CREDENTIAL_TOKEN, undefined);
  let res = await built.app.turn({
    ...channelTurn("C1"),
    text: `!execute ${JSON.stringify({ command: "echo hi", credentials: ["x-firehose"] })}`,
  });
  assert.equal(res.status, "ok", res.reason);
  assert.equal(env()?.AGENT_CREDENTIAL_TOKEN, undefined);
  const token = executionEnv()?.AGENT_CREDENTIAL_TOKEN;
  assert.ok(token, "the granted channel's conversation should get a credential token");
  const claims = await verifyCapabilityToken(token!, TEST_CAPABILITY_SECRET);
  assert.deepEqual(claims?.credentials, ["x-firehose"]);

  await failedTurn(
    built,
    { ...channelTurn("C2"), text: `!execute ${JSON.stringify({ command: "echo hi", credentials: ["x-firehose"] })}` },
    /not available/,
  );
  res = await built.app.turn(channelTurn("C2"));
  assert.equal(res.status, "ok", res.reason);
  assert.equal(env()?.AGENT_CREDENTIAL_TOKEN, undefined, "another channel must not get the credential");

  await failedTurn(
    built,
    dm(`!execute ${JSON.stringify({ command: "echo hi", credentials: ["x-firehose"] })}`),
    /not available/,
  );
  res = await built.app.turn(dm("!run echo hi"));
  assert.equal(res.status, "ok", res.reason);
  assert.equal(env()?.AGENT_CREDENTIAL_TOKEN, undefined, "a member's DM must not get a channel-granted credential");
});

test("orchestrator stamps nothing when the org has no service credentials (zero-cost common path)", async () => {
  const { built, env } = buildWithCapture();
  await selectDefaultSandbox(built, "U1", "personal:U1");
  const res = await built.app.turn(dm("!run echo hi"));
  assert.equal(res.status, "ok", res.reason);
  assert.equal(env()?.AGENT_CREDENTIAL_TOKEN, undefined);
  assert.ok(env()?.AGENT_API_TOKEN, "control-plane token should still be present");
});

test("the system prompt advertises an entitled credential (host/methods/paths) so the agent can use the broker", async () => {
  const { built } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "x-firehose",
    name: "X firehose",
    secret: "s",
    host: "api.x.com",
    allowedMethods: ["GET"],
    allowedPathPrefixes: ["/2/tweets/search/"],
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:x-firehose",
    granteeScopeId: "org:default-org",
    permission: "read",
    grantedBy: "admin",
  });
  const res = await built.app.turn(dm("!sysprompt"));
  const reply = res.reply ?? "";
  assert.match(reply, /### Organization/);
  assert.match(reply, /x-firehose.*X firehose.*api\.x\.com.*GET.*\/2\/tweets\/search\//s);
  assert.match(reply, /use-shared-credential/);
  assert.doesNotMatch(reply, /curl -fsS -X POST.*credentials\/broker/);
});

test("the system prompt does NOT advertise a credential the session isn't entitled to", async () => {
  const { built } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "x-firehose",
    name: "X firehose",
    secret: "s",
    host: "api.x.com",
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:x-firehose",
    granteeScopeId: "personal:U2",
    permission: "read",
    grantedBy: "admin",
  });
  const res = await built.app.turn(dm("!sysprompt"));
  assert.doesNotMatch(res.reply ?? "", /### Organization/);
});

test("the published-apps switch defaults on, round-trips, survives a partial update, and rejects non-booleans", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "acme-data", name: "Acme data", secret: "s", host: "relay.example" });
    let loaded = (await getCfg(srv.base)).serviceCredentials.find((c) => c.slug === "acme-data")!;
    assert.equal(loaded.deployments, true);
    assert.equal(
      (
        await putCred(srv.base, {
          slug: "acme-data",
          name: "Acme data",
          host: "relay.example",
          deployments: false,
          expectedUpdatedAt: loaded.updatedAt,
        })
      ).status,
      200,
    );
    loaded = (await getCfg(srv.base)).serviceCredentials.find((c) => c.slug === "acme-data")!;
    assert.equal(loaded.deployments, false);
    assert.equal(
      (
        await putCred(srv.base, {
          slug: "acme-data",
          name: "Acme data renamed",
          host: "relay.example",
          expectedUpdatedAt: loaded.updatedAt,
        })
      ).status,
      200,
    );
    loaded = (await getCfg(srv.base)).serviceCredentials.find((c) => c.slug === "acme-data")!;
    assert.equal(loaded.deployments, false, "a partial update keeps the switch as it was");
    const bad = await putCred(srv.base, {
      slug: "acme-data",
      name: "Acme data",
      host: "relay.example",
      deployments: "no",
      expectedUpdatedAt: loaded.updatedAt,
    });
    assert.equal(bad.status, 400);
  } finally {
    await srv.close();
  }
});

test("credential lists batch grants and finish without usage reads", async (t) => {
  const srv = start();
  t.after(srv.close);
  for (const slug of ["first", "second"]) {
    assert.equal(
      (await putCred(srv.base, { slug, name: slug, host: "api.example.com", secret: "private" })).status,
      200,
    );
  }
  const listGrants = t.mock.method(srv.built.acl, "list");
  t.mock.method(srv.built.acl, "grantsFor", () => {
    throw new Error("per-credential grant read");
  });
  t.mock.method(srv.built.credentialUsage, "list", () => {
    throw new Error("raw usage read");
  });
  t.mock.method(srv.built.credentialUsage, "summary", () => {
    throw new Error("summary read on list path");
  });
  const response = await fetch(`${srv.base}/v1/admin/scopes/org:default-org?view=credentials`, {
    headers: ADMIN,
    signal: AbortSignal.timeout(500),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { serviceCredentials: { grantees: string[]; usageCount?: number }[] };
  assert.equal(body.serviceCredentials.length, 2);
  assert.equal(listGrants.mock.callCount(), 1);
  for (const credential of body.serviceCredentials) {
    assert.deepEqual(credential.grantees, ["org:default-org"]);
    assert.equal(credential.usageCount, undefined);
  }
});

test("usage summaries authorize before reads and include only the requested scope's credentials", async (t) => {
  const srv = start();
  t.after(srv.close);
  await putCred(srv.base, { slug: "summary", name: "Summary", host: "api.example.com", secret: "private" });
  srv.built.credentialUsage.record({
    slug: "summary",
    host: "api.example.com",
    status: "ok",
    scopeLabel: "personal:U1",
    principalId: "U1",
  });
  srv.built.credentialUsage.record({
    slug: "unlisted",
    host: "api.example.com",
    status: "ok",
    scopeLabel: "personal:U2",
    principalId: "U2",
  });
  await recorded(() => srv.built.credentialUsage.list(), 2);
  const read = t.mock.method(srv.built.serviceCreds, "listServiceCredentials");
  const summarize = t.mock.method(srv.built.credentialUsage, "summary");
  const path = `${srv.base}/v1/admin/scopes/org:default-org/credential-usage`;
  assert.equal((await fetch(path, { headers: { "x-admin-actor": "nobody@default-org" } })).status, 403);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(summarize.mock.callCount(), 0);
  const response = await fetch(path, { headers: ADMIN });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    summaries: { slug: string; usageCount: number; recentUsagePrincipals: string[] }[];
  };
  assert.equal(body.summaries.length, 1);
  assert.equal(body.summaries[0]!.slug, "summary");
  assert.equal(body.summaries[0]!.usageCount, 1);
  assert.deepEqual(body.summaries[0]!.recentUsagePrincipals, ["U1"]);
  assert.deepEqual(summarize.mock.calls[0]!.arguments, [["summary"]]);
  assert.doesNotMatch(JSON.stringify(body), /private|unlisted|U2/);
});

test("credential inventory and policy reordering do not resend unchanged credentials", async () => {
  const { built } = buildWithCapture();
  for (const slug of ["z-service", "a-service"]) {
    await built.serviceCreds.setServiceCredential("org:default-org", {
      slug,
      name: slug,
      secret: "s",
      host: "api.example.com",
      allowedMethods: ["POST", "GET"],
      allowedPathPrefixes: ["/z", "/a"],
    });
    await built.acl.grant({
      ownerScopeId: "org:default-org",
      ref: `service-cred:${slug}`,
      granteeScopeId: "org:default-org",
      permission: "read",
      grantedBy: "admin",
    });
  }
  const first = await built.app.turn(dm("!sysprompt"));
  assert.equal(first.status, "ok");
  assert.match(first.reply ?? "", /z-service/);
  assert.match(first.reply ?? "", /a-service/);
  assert.match(first.reply ?? "", /### Organization/);
  const list = built.serviceCreds.listServiceCredentials.bind(built.serviceCreds);
  built.serviceCreds.listServiceCredentials = async (...args) =>
    (await list(...args)).reverse().map((record) => ({
      ...record,
      allowedMethods: record.allowedMethods?.toReversed(),
      allowedPathPrefixes: record.allowedPathPrefixes?.toReversed(),
    }));
  const second = await built.app.turn(dm("!sysprompt"));
  assert.equal(second.status, "ok");
  assert.match(second.reply ?? "", /<environment>/);
  assert.doesNotMatch(second.reply ?? "", /## Credentials|No longer included: Credentials|service_[az]-service/);
});
