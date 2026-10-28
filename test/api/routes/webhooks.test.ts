import "../../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createControlService } from "../../../src/api/control-service.ts";
import { createInsecureTestServer, createServer } from "../../../src/api/server.ts";
import {
  CAPABILITY_TTL_MS,
  CONTROL_PLANE_AUD,
  mintCapabilityToken,
  type CapabilityClaims,
} from "../../../src/auth/capability-token.ts";
import { createPostgresReplayDedupe } from "../../../src/auth/replay-dedupe.ts";
import { signRequest } from "../../../plugins/chassis/src/source-auth-sign.ts";
import { buildApp } from "../../support/build-app.ts";
import { settle, runNowSettled } from "../../support/settle.ts";
import { testConfig } from "../../support/test-config.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";
import { listen } from "../../support/project-routes.ts";

const SECRET = "core-signing-secret".repeat(3);
const HOOK_SECRET = "hook-secret";

function start(signingSecret?: string, publicUrl?: string): { base: string; close: () => Promise<void> } {
  const built = buildApp(testConfig());
  const deps = { ...(publicUrl ? { publicUrl } : {}), webhookReceiver: built.webhookReceiver };
  const server = signingSecret
    ? createServer(built.app, { replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()), ...deps, signingSecret })
    : createInsecureTestServer(built.app, deps);
  server.listen(0);
  void built.jobs.start();
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await built.jobs.stop();
    },
  };
}

function sign(method: string, pathWithQuery: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

const githubSig = (rawBody: string) => "sha256=" + createHmac("sha256", HOOK_SECRET).update(rawBody).digest("hex");

const regBody = (owner = "U1", createdBy = "U1") =>
  JSON.stringify({
    ownerScopeId: "personal:U1",
    owner,
    createdBy,
    action: "triage",
    verification: { scheme: "github", secret: HOOK_SECRET },
  });

test("register → list elides the secret; the inbound URL is returned", async () => {
  const srv = start(SECRET);
  try {
    const body = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", body),
      body,
    });
    assert.equal(created.status, 200);
    const { webhook, url } = (await created.json()) as {
      webhook: { id: string; verification: { secret: string } };
      url: string;
    };
    assert.equal(url, `/v1/webhooks/incoming/${webhook.id}`);
    assert.equal(webhook.verification.secret, HOOK_SECRET);

    const listPath = "/v1/webhooks?viewer=U1";
    const listed = await fetch(`${srv.base}${listPath}`, { headers: sign("GET", listPath, "") });
    const { webhooks } = (await listed.json()) as { webhooks: Array<{ verification: { secret: string } }> };
    assert.equal(webhooks[0]?.verification.secret, "***");
  } finally {
    await srv.close();
  }
});

test("with a public base configured, the inbound URL is ABSOLUTE (publicly reachable, not the 6PN api base)", async () => {
  const srv = start(SECRET, "https://portal.example.com");
  try {
    const body = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", body),
      body,
    });
    assert.equal(created.status, 200);
    const { webhook, url } = (await created.json()) as { webhook: { id: string }; url: string };
    assert.equal(url, `https://portal.example.com/v1/webhooks/incoming/${webhook.id}`);
  } finally {
    await srv.close();
  }
});

test("registration is anti-escalation gated (different owner needs consent)", async () => {
  const srv = start(SECRET);
  try {
    const body = regBody("U2", "U1");
    const res = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", body),
      body,
    });
    assert.equal(res.status, 400);
  } finally {
    await srv.close();
  }
});

test("registration requires core source-auth (unsigned → 401)", async () => {
  const srv = start(SECRET);
  try {
    const res = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: regBody(),
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("registration rejects webhook configurations without a verifiable signature", async () => {
  const srv = start(SECRET);
  try {
    for (const verification of [{ scheme: "none" }, { scheme: "github" }]) {
      const body = JSON.stringify({
        ownerScopeId: "personal:U1",
        owner: "U1",
        createdBy: "U1",
        action: "unsafe",
        verification,
      });
      const res = await fetch(`${srv.base}/v1/webhooks`, {
        method: "POST",
        headers: sign("POST", "/v1/webhooks", body),
        body,
      });
      assert.equal(res.status, 400);
    }
  } finally {
    await srv.close();
  }
});

test("inbound ingress is gated by the per-webhook signature, NOT core source-auth", async () => {
  const srv = start(SECRET);
  try {
    const reg = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", reg),
      body: reg,
    });
    const { webhook } = (await created.json()) as { webhook: { id: string } };
    const eventBody = JSON.stringify({ action: "opened" });

    const ok = await fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": githubSig(eventBody),
        "x-github-delivery": "d-1",
        "x-github-event": "issues",
      },
      body: eventBody,
    });
    assert.equal(ok.status, 202);

    const bad = await fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
        "x-github-delivery": "d-2",
        "x-github-event": "issues",
      },
      body: eventBody,
    });
    assert.equal(bad.status, 401);

    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await srv.close();
  }
});

test("an over-cap inbound body is rejected 413 by the upstream readRawBody, before deliver()", async () => {
  const srv = start(SECRET);
  try {
    const reg = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", reg),
      body: reg,
    });
    const { webhook } = (await created.json()) as { webhook: { id: string } };
    const huge = "x".repeat(1_000_001);
    const res = await fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": githubSig(huge),
        "x-github-delivery": "d-big",
        "x-github-event": "issues",
      },
      body: huge,
    });
    assert.equal(res.status, 413);
  } finally {
    await srv.close();
  }
});

test("inbound per-webhook auth holds even in core dev mode (no core secret)", async () => {
  const srv = start();
  try {
    const reg = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: reg,
    });
    const { webhook } = (await created.json()) as { webhook: { id: string } };
    const eventBody = JSON.stringify({ action: "opened" });

    const forged = await fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
        "x-github-delivery": "d-3",
        "x-github-event": "issues",
      },
      body: eventBody,
    });
    assert.equal(forged.status, 401);
  } finally {
    await srv.close();
  }
});

test("signed webhook history enforces viewer permissions and links to an owner-readable worklog", async () => {
  const srv = start(SECRET);
  try {
    const body = regBody();
    const created = await fetch(`${srv.base}/v1/webhooks`, {
      method: "POST",
      headers: sign("POST", "/v1/webhooks", body),
      body,
    });
    const { webhook } = (await created.json()) as { webhook: { id: string } };
    for (const [suffix, status] of [
      ["?viewer=U1", 200],
      ["?viewer=U2", 404],
      ["", 404],
    ] as const) {
      const path = `/v1/webhooks/${webhook.id}/events${suffix}`;
      const res = await fetch(`${srv.base}${path}`, { headers: sign("GET", path, "") });
      assert.equal(res.status, status);
      if (status === 200) assert.deepEqual(await res.json(), { events: [] });
    }
    assert.equal((await fetch(`${srv.base}/v1/webhooks/${webhook.id}/events?viewer=U1`)).status, 401);
    const eventBody = JSON.stringify({ message: "agent message for worklog" });
    const accepted = await fetch(`${srv.base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": githubSig(eventBody) },
      body: eventBody,
    });
    assert.equal(accepted.status, 202);
    const historyPath = `/v1/webhooks/${webhook.id}/events?viewer=U1`;
    let events: Array<{ sessionId?: string; payload: string }> = [];
    for (let i = 0; i < 100; i++) {
      const history = await fetch(`${srv.base}${historyPath}`, { headers: sign("GET", historyPath, "") });
      ({ events } = (await history.json()) as { events: typeof events });
      if (events[0]?.sessionId) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(events.length, 1);
    assert.ok(events[0]?.sessionId);
    assert.match(events[0]!.payload, /agent message for worklog/);
    const sessionPath = `/v1/sessions/${events[0]!.sessionId}?viewer=U1`;
    let worklog = "";
    await settle(async () => {
      const res = await fetch(`${srv.base}${sessionPath}`, { headers: sign("GET", sessionPath, "") });
      assert.equal(res.status, 200);
      worklog = JSON.stringify(await res.json());
      return /agent message for worklog/.test(worklog);
    });
    assert.match(worklog, /agent message for worklog/);
    const otherPath = `/v1/sessions/${events[0]!.sessionId}?viewer=U2`;
    assert.equal((await fetch(`${srv.base}${otherPath}`, { headers: sign("GET", otherPath, "") })).status, 404);
  } finally {
    await srv.close();
  }
});

const PROJECT_TRIGGER_AUTH_SECRET = "project-trigger-secret".repeat(3);

function signed(method: string, path: string, body = ""): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(PROJECT_TRIGGER_AUTH_SECRET, ts, `${method}\n${path}\n${body}`),
  };
}

async function signedStatus(base: string, method: string, path: string, body = ""): Promise<number> {
  return (await fetch(`${base}${path}`, { method, headers: signed(method, path, body), ...(body ? { body } : {}) }))
    .status;
}

async function capabilityStatus(base: string, capability: string): Promise<number> {
  return (await fetch(`${base}/v1/instructions`, { headers: { "x-agent-capability": capability } })).status;
}

function claims(actorId: string): CapabilityClaims {
  return { actorId, scopeId: `personal:${actorId}`, exp: Date.now() + 60_000 };
}

async function token(actorId: string, scopeId: CapabilityClaims["scopeId"], scopeVersion?: string): Promise<string> {
  return await mintCapabilityToken(
    {
      actorId,
      scopeId,
      ...(scopeVersion ? { scopeVersion } : {}),
      aud: CONTROL_PLANE_AUD,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    PROJECT_TRIGGER_AUTH_SECRET,
  );
}

test("Project trigger access follows current membership while Slack-group owner access is unchanged", async (t) => {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  await built.app.upsertGroups([{ groupId: "G-slack", principalId: "member" }]);
  await built.app.upsertChannels([{ channelId: "C-public", name: "public", isPrivate: false }], []);
  const project = await built.app.createProject("owner", "Launch");
  assert.ok(project);
  const initialVersion = await built.projects.version(project.scopeId.slice("group:".length));
  assert.ok(initialVersion);
  const staleOwnerToken = await token("owner", project.scopeId, initialVersion);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");

  const projectCron = await built.app.createCron({
    ownerScopeId: project.scopeId,
    owner: "member",
    createdBy: "member",
    action: "project secret",
    schedule: { everyMs: 60_000 },
  });
  const slackScope = "group:G-slack" as const;
  const slackCron = await built.app.createCron({
    ownerScopeId: slackScope,
    owner: "member",
    createdBy: "member",
    action: "slack task",
    schedule: { everyMs: 60_000 },
  });
  const publicCron = await built.app.createCron({
    ownerScopeId: "channel:C-public",
    owner: "owner",
    createdBy: "owner",
    action: "public task",
    schedule: { everyMs: 60_000 },
  });
  const projectWebhook = await built.app.createWebhook({
    ownerScopeId: project.scopeId,
    owner: "member",
    createdBy: "member",
    action: "project hook",
    verification: { scheme: "github", secret: "project-hook-secret" },
  });
  const slackWebhook = await built.app.createWebhook({
    ownerScopeId: slackScope,
    owner: "member",
    createdBy: "member",
    action: "slack hook",
    verification: { scheme: "github", secret: "slack-hook-secret" },
  });

  const control = createControlService(built.app, built.scheduler);
  assert.ok((await control.listCrons(claims("member"))).crons.some((cron) => cron.id === projectCron.id));
  assert.ok((await control.listCrons(claims("owner"))).visible.some((cron) => cron.id === projectCron.id));
  assert.ok((await control.listWebhooks(claims("owner"))).some((webhook) => webhook.id === projectWebhook.id));

  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: PROJECT_TRIGGER_AUTH_SECRET,
    scheduler: built.scheduler,
  });
  const base = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const currentVersion = await built.projects.version(project.scopeId.slice("group:".length));
  assert.ok(currentVersion);
  const projectToken = await token("member", project.scopeId, currentVersion);
  const slackToken = await token("member", slackScope);
  assert.equal(await capabilityStatus(base, staleOwnerToken), 403);
  assert.equal(await capabilityStatus(base, projectToken), 200);

  assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");

  await runNowSettled(built.scheduler, built.crons, projectCron.id);
  assert.equal(await built.crons.get(projectCron.id), null, "a Project cron is deleted once its owner leaves");

  assert.equal(await capabilityStatus(base, projectToken), 403);
  assert.equal(await capabilityStatus(base, await token("member", `personal:member`)), 200);
  assert.equal(await capabilityStatus(base, slackToken), 200);

  const listedCrons = await built.app.listCronsForViewer("member");
  assert.ok(!listedCrons.owned.some((cron) => cron.id === projectCron.id));
  assert.ok(!listedCrons.visible.some((cron) => cron.id === projectCron.id));
  assert.ok(listedCrons.owned.some((cron) => cron.id === slackCron.id));

  const controlledCrons = await control.listCrons(claims("member"));
  assert.ok(!controlledCrons.crons.some((cron) => cron.id === projectCron.id));
  assert.ok(!controlledCrons.visible.some((cron) => cron.id === projectCron.id));
  assert.ok(controlledCrons.crons.some((cron) => cron.id === slackCron.id));
  assert.equal((await control.getCron(projectCron.id, claims("member"))).ok, false);
  assert.equal((await control.patchCron(projectCron.id, { title: "hijack" }, claims("member"))).ok, false);
  assert.equal((await control.getCron(slackCron.id, claims("member"))).ok, true);

  const controlledWebhooks = await control.listWebhooks(claims("member"));
  assert.ok(!controlledWebhooks.some((webhook) => webhook.id === projectWebhook.id));
  assert.ok(controlledWebhooks.some((webhook) => webhook.id === slackWebhook.id));
  assert.equal((await control.disableWebhook(projectWebhook.id, claims("member"))).ok, false);

  const cronListPath = "/v1/crons?viewer=member";
  const cronList = await fetch(`${base}${cronListPath}`, { headers: signed("GET", cronListPath) });
  const cronBody = (await cronList.json()) as { crons: Array<{ id: string }>; visible: Array<{ id: string }> };
  assert.ok(![...cronBody.crons, ...cronBody.visible].some((cron) => cron.id === projectCron.id));
  assert.ok(cronBody.crons.some((cron) => cron.id === slackCron.id));

  for (const suffix of [
    `/v1/crons/${projectCron.id}?principalId=member`,
    `/v1/crons/${projectCron.id}/runs?principalId=member`,
  ]) {
    assert.equal(await signedStatus(base, "GET", suffix), 404);
  }
  const projectPatchPath = `/v1/crons/${projectCron.id}?principalId=member`;
  const projectPatchBody = JSON.stringify({ title: "hijack" });
  assert.equal(await signedStatus(base, "PATCH", projectPatchPath, projectPatchBody), 404);
  const slackGetPath = `/v1/crons/${slackCron.id}?principalId=member`;
  assert.equal(await signedStatus(base, "GET", slackGetPath), 200);
  const publicGetPath = `/v1/crons/${publicCron.id}?principalId=member`;
  assert.equal(await signedStatus(base, "GET", publicGetPath), 200);
  const publicRunsPath = `/v1/crons/${publicCron.id}/runs?principalId=member`;
  assert.equal(await signedStatus(base, "GET", publicRunsPath), 404);

  const webhookListPath = "/v1/webhooks?viewer=member";
  const webhookList = await fetch(`${base}${webhookListPath}`, { headers: signed("GET", webhookListPath) });
  const webhookBody = (await webhookList.json()) as { webhooks: Array<{ id: string }> };
  assert.ok(!webhookBody.webhooks.some((webhook) => webhook.id === projectWebhook.id));
  assert.ok(webhookBody.webhooks.some((webhook) => webhook.id === slackWebhook.id));

  const projectDisablePath = `/v1/webhooks/${projectWebhook.id}/disable?principalId=member`;
  assert.equal(await signedStatus(base, "POST", projectDisablePath), 404);
  const slackDisablePath = `/v1/webhooks/${slackWebhook.id}/disable?principalId=member`;
  assert.equal(await signedStatus(base, "POST", slackDisablePath), 200);
});
