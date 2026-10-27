import "../../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createServer } from "../../../src/api/server.ts";
import { type BuiltApp } from "../../../src/wiring.ts";
import { buildApp } from "../../support/build-app.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  CONTROL_PLANE_AUD,
  CREDENTIAL_BROKER_AUD,
} from "../../../src/auth/capability-token.ts";
import type { BrokerFetch } from "../../../src/api/credential-broker.ts";
import type { CredentialHttpFetch } from "../../../src/api/credential-http-broker.ts";
import { testConfig } from "../../support/test-config.ts";
import { createPostgresReplayDedupe } from "../../../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";
import { listenLocal } from "../../support/listen-local.ts";
import { start, putCred, getCfg, SECRET } from "../../support/service-credentials.ts";

function startBroker(brokerFetch: BrokerFetch): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    config: built.config,
    serviceCreds: built.serviceCreds,
    acl: built.acl,
    credentialUsage: built.credentialUsage,
    auditLog: built.auditLog,
    brokerFetch,
  });
  const base = listenLocal(server);
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function startGitBroker(credentialHttpFetch: CredentialHttpFetch): {
  base: string;
  built: BuiltApp;
  close: () => Promise<void>;
} {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    config: built.config,
    serviceCreds: built.serviceCreds,
    acl: built.acl,
    credentialUsage: built.credentialUsage,
    auditLog: built.auditLog,
    credentialHttpFetch,
  });
  const base = listenLocal(server);
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const brokerToken = (credentials: string[], aud: string = CREDENTIAL_BROKER_AUD) =>
  mintCapabilityToken(
    { actorId: "U1", scopeId: "personal:U1", aud, credentials, exp: Date.now() + CAPABILITY_TTL_MS },
    SECRET,
  );

test("re-sharing reconciles the ACL allow-list (org-wide → specific people → delete)", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    assert.deepEqual((await getCfg(srv.base)).serviceCredentials[0]!.grantees, ["org:default-org"]);

    const createdVersion = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    await putCred(srv.base, {
      slug: "k",
      name: "K",
      host: "h.example",
      grantees: ["personal:bob", "personal:alice"],
      expectedUpdatedAt: createdVersion,
    });
    assert.deepEqual((await getCfg(srv.base)).serviceCredentials[0]!.grantees.sort(), [
      "personal:alice",
      "personal:bob",
    ]);

    const sharedVersion = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    assert.equal((await putCred(srv.base, { slug: "k", delete: true, expectedUpdatedAt: sharedVersion })).status, 200);
    assert.equal((await getCfg(srv.base)).serviceCredentials.length, 0);
    const grants = await srv.built.acl.grantsFor("org:default-org", "service-cred:k");
    assert.equal(grants.length, 0);
  } finally {
    await srv.close();
  }
});

test("a channel grantee is accepted and saved", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const version = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    const r = await putCred(srv.base, {
      slug: "k",
      name: "K",
      host: "h.example",
      grantees: ["channel:C1", "personal:bob"],
      expectedUpdatedAt: version,
    });
    assert.equal(r.status, 200);
    assert.deepEqual((await getCfg(srv.base)).serviceCredentials[0]!.grantees.sort(), ["channel:C1", "personal:bob"]);
  } finally {
    await srv.close();
  }
});

test("a non-org/personal/team/channel grantee is rejected", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const version = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    const r = await putCred(srv.base, {
      slug: "k",
      name: "K",
      host: "h.example",
      grantees: ["group:G1"],
      expectedUpdatedAt: version,
    });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /grantee must be/);

    const disguised = await putCred(srv.base, {
      slug: "k",
      name: "K",
      host: "h.example",
      grantees: ["personal:channel:C1"],
      expectedUpdatedAt: version,
    });
    assert.equal(disguised.status, 400);
    assert.match(await disguised.text(), /personal:channel:C1/);

    const emptyRef = await putCred(srv.base, {
      slug: "k",
      name: "K",
      host: "h.example",
      grantees: ["channel:"],
      expectedUpdatedAt: version,
    });
    assert.equal(emptyRef.status, 400);
    assert.match(await emptyRef.text(), /grantee must be/);
  } finally {
    await srv.close();
  }
});

test("credential capability grammar rejects malformed headers, methods, and paths before mutation", async () => {
  const srv = start();
  try {
    const base = { slug: "k", name: "K", secret: "s", host: "h.example" };
    assert.equal((await putCred(srv.base, { ...base, injection: { header: "Bad Header" } })).status, 400);
    assert.equal((await putCred(srv.base, { ...base, injection: { header: "X-QM-Actor" } })).status, 400);
    assert.equal((await putCred(srv.base, { ...base, injection: { actor: "true" } })).status, 400);
    assert.equal((await putCred(srv.base, { ...base, allowedMethods: ["GET /oops"] })).status, 400);
    assert.equal((await putCred(srv.base, { ...base, allowedPathPrefixes: ["relative/path"] })).status, 400);
    assert.equal((await getCfg(srv.base)).serviceCredentials.length, 0);
  } finally {
    await srv.close();
  }
});

const broker = (base: string, token: string, body: object) =>
  fetch(`${base}/v1/credentials/broker`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-capability": token },
    body: JSON.stringify(body),
  });

async function readStreamBody(stream?: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  if (!stream) return "";
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

test("broker route: a credential-broker token uses the secret by proxy; usage is recorded", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const srv = startBroker(async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status: 200, contentType: "application/json", text: async () => '{"data":[]}' };
  });
  try {
    await srv.built.serviceCreds.setServiceCredential("org:default-org", {
      slug: "x-firehose",
      name: "X",
      secret: "super-secret-bearer",
      host: "api.x.com",
      allowedPathPrefixes: ["/2/"],
    });
    const res = await broker(srv.base, await brokerToken(["x-firehose"]), {
      credential: "x-firehose",
      method: "GET",
      url: "https://api.x.com/2/tweets/search/recent?query=ai",
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { status: number; body: string };
    assert.equal(json.status, 200);
    assert.equal(json.body, '{"data":[]}');
    assert.equal(calls[0]!.headers["Authorization"], "Bearer super-secret-bearer");
    assert.doesNotMatch(JSON.stringify(json), /super-secret-bearer/);
    assert.equal((await srv.built.credentialUsage.list({ slug: "x-firehose" })).length, 1);
  } finally {
    await srv.close();
  }
});

test("broker route: a slug NOT in the token's set is refused (403)", async () => {
  const srv = startBroker(async () => {
    throw new Error("must not fetch");
  });
  try {
    await srv.built.serviceCreds.setServiceCredential("org:default-org", {
      slug: "x-firehose",
      name: "X",
      secret: "s",
      host: "api.x.com",
    });
    const res = await broker(srv.base, await brokerToken([]), { credential: "x-firehose", url: "https://api.x.com/x" });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /not_entitled/);
  } finally {
    await srv.close();
  }
});

test("broker route: a control-plane token is rejected (cross-onramp wall); no token → 401", async () => {
  const srv = startBroker(async () => {
    throw new Error("must not fetch");
  });
  try {
    await srv.built.serviceCreds.setServiceCredential("org:default-org", {
      slug: "x-firehose",
      name: "X",
      secret: "s",
      host: "api.x.com",
    });
    const r1 = await broker(srv.base, await brokerToken(["x-firehose"], CONTROL_PLANE_AUD), {
      credential: "x-firehose",
      url: "https://api.x.com/x",
    });
    assert.equal(r1.status, 403);
    assert.match(await r1.text(), /credential-broker/);
    const r2 = await fetch(`${srv.base}/v1/credentials/broker`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "x-firehose", url: "https://api.x.com/x" }),
    });
    assert.equal(r2.status, 401);
  } finally {
    await srv.close();
  }
});

test("git http broker streams smart-http GET and POST through an entitled service credential", async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const srv = startGitBroker(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: await readStreamBody(init.body) });
    return {
      status: 200,
      headers: {
        "content-type":
          init.method === "GET"
            ? "application/x-git-receive-pack-advertisement"
            : "application/x-git-receive-pack-result",
      },
      body: Readable.from([init.method === "GET" ? "001e# service=git-receive-pack\n0000" : "0000"]),
    };
  });
  try {
    await srv.built.serviceCreds.setServiceCredential("org:default-org", {
      slug: "gitlab",
      name: "GitLab git",
      secret: "dXNlcjp0b2tlbg==",
      host: "gitlab.example",
      injection: { scheme: "Basic " },
      allowedMethods: ["GET", "POST"],
      allowedPathPrefixes: ["/acme/repo.git"],
    });

    const token = await brokerToken(["gitlab"]);
    const discovery = await fetch(
      `${srv.base}/v1/credentials/http/gitlab/acme/repo.git/info/refs?service=git-receive-pack`,
      {
        headers: { "x-agent-capability": token, "git-protocol": "version=2" },
      },
    );
    assert.equal(discovery.status, 200);
    assert.match(discovery.headers.get("content-type") ?? "", /x-git-receive-pack-advertisement/);
    assert.match(await discovery.text(), /git-receive-pack/);

    const push = await fetch(`${srv.base}/v1/credentials/http/gitlab/acme/repo.git/git-receive-pack`, {
      method: "POST",
      headers: {
        "x-agent-capability": token,
        "content-type": "application/x-git-receive-pack-request",
        "git-protocol": "version=2",
      },
      body: "PACKDATA",
    });
    assert.equal(push.status, 200);
    assert.equal(await push.text(), "0000");

    assert.equal(calls[0]!.url, "https://gitlab.example/acme/repo.git/info/refs?service=git-receive-pack");
    assert.equal(calls[0]!.headers.Authorization, "Basic dXNlcjp0b2tlbg==");
    assert.equal(calls[0]!.headers["git-protocol"], "version=2");
    assert.equal(calls[1]!.url, "https://gitlab.example/acme/repo.git/git-receive-pack");
    assert.equal(calls[1]!.headers.Authorization, "Basic dXNlcjp0b2tlbg==");
    assert.equal(calls[1]!.headers["content-type"], "application/x-git-receive-pack-request");
    assert.equal(calls[1]!.body, "PACKDATA");
    assert.equal((await srv.built.credentialUsage.list({ slug: "gitlab" })).filter((r) => r.status === "ok").length, 2);
  } finally {
    await srv.close();
  }
});

test("git http broker enforces broker-token audience, entitlement, method, and path", async () => {
  const srv = startGitBroker(async () => {
    throw new Error("must not fetch");
  });
  try {
    await srv.built.serviceCreds.setServiceCredential("org:default-org", {
      slug: "gitlab",
      name: "GitLab git",
      secret: "s",
      host: "gitlab.example",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/acme/repo.git"],
    });
    const path = `${srv.base}/v1/credentials/http/gitlab/acme/repo.git/git-receive-pack`;

    assert.equal((await fetch(path)).status, 401);
    assert.equal(
      (await fetch(path, { headers: { "x-agent-capability": await brokerToken(["gitlab"], CONTROL_PLANE_AUD) } }))
        .status,
      403,
    );
    assert.equal((await fetch(path, { headers: { "x-agent-capability": await brokerToken([]) } })).status, 403);
    assert.equal(
      (
        await fetch(path.replace("/acme/repo.git/", "/other/repo.git/"), {
          headers: { "x-agent-capability": await brokerToken(["gitlab"]) },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(path, {
          method: "POST",
          headers: { "x-agent-capability": await brokerToken(["gitlab"]) },
          body: "PACK",
        })
      ).status,
      403,
    );
  } finally {
    await srv.close();
  }
});
