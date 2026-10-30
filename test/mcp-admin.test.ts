import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { startMcpTestServer } from "./support/mcp-test-server.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

test("MCP admin validates and preserves credential scope, without returning secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers/crm`;
  const put = (body: object, headers = ADMIN) =>
    fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ url: "https://tools.example.com/mcp", validate: false, ...body }),
    });
  assert.equal((await put({ credentialScope: "other" })).status, 400);
  assert.equal((await put({ credentialScope: "per-user" })).status, 400);
  assert.equal(
    (await put({ credentialScope: "per-user", credentialHost: "accounts.example.com", credentialAccountType: "other" }))
      .status,
    400,
  );
  for (const credentialHost of ["", " accounts.example.com", "accounts.example.com/path", "host@evil", 1]) {
    assert.equal((await put({ credentialScope: "per-user", credentialHost })).status, 400);
  }
  assert.equal(
    (
      await put({
        credentialScope: "per-user",
        credentialHost: "accounts.example.com",
        url: "http://tools.example.com/mcp",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await put(
        { credentialScope: "per-user", credentialHost: "accounts.example.com" },
        { ...ADMIN, "x-admin-actor": "nobody@default-org" },
      )
    ).status,
    403,
  );
  const saved = await put({
    credentialScope: "per-user",
    credentialHost: "accounts.example.com",
    auth: "bearer",
    bearerToken: "catalog-secret",
    credentialAccountType: "personal",
  });
  assert.equal(saved.status, 200);
  const body = await saved.text();
  assert.doesNotMatch(body, /catalog-secret/);
  assert.equal(JSON.parse(body).server.credentialScope, "per-user");
  assert.equal((await put({ auth: "bearer" })).status, 200);
  assert.equal((await store.get("crm"))?.credentialScope, "per-user");
  assert.equal((await store.get("crm"))?.credentialHost, "accounts.example.com");
  assert.equal((await store.get("crm"))?.credentialAccountType, "personal");
  assert.equal((await store.get("crm"))?.bearerToken, "catalog-secret");
  assert.equal((await put({ credentialScope: "shared" })).status, 200);
  assert.equal((await store.get("crm"))?.credentialScope, "shared");
  assert.equal((await store.get("crm"))?.credentialHost, undefined);
  assert.equal((await store.get("crm"))?.credentialAccountType, undefined);
  assert.equal((await put({ approval: "sometimes" })).status, 400);
  assert.equal((await put({ approval: "all" })).status, 200);
  assert.equal((await store.get("crm"))?.approval, "all");
  assert.equal((await put({})).status, 200);
  assert.equal((await store.get("crm"))?.approval, "all", "an update that omits the policy keeps it");
  assert.equal((await put({ approval: "annotations" })).status, 200);
  assert.equal((await store.get("crm"))?.approval, undefined);
  assert.equal((await put({ attestActor: true })).status, 400);
  assert.equal(
    (await put({ catalog: true, attestActor: true })).status,
    400,
    "an unauthenticated upstream cannot trust the actor",
  );
  assert.equal(
    (
      await put({
        catalog: true,
        attestActor: true,
        auth: "bearer",
        bearerToken: "t",
        credentialScope: "per-user",
        credentialHost: "accounts.example.com",
      })
    ).status,
    400,
    "a per-person token could otherwise assert someone else",
  );
  assert.equal(
    (await put({ catalog: true, attestActor: true, auth: "bearer", bearerToken: "t", credentialScope: "shared" }))
      .status,
    200,
  );
  assert.deepEqual([(await store.get("crm"))?.catalog, (await store.get("crm"))?.attestActor], [true, true]);
  for (const invalid of [
    { attestContext: true },
    {
      catalog: true,
      attestActor: true,
      attestContext: true,
      attestationSecret: "operator-supplied-secret",
      auth: "bearer",
      bearerToken: "t",
    },
    {
      catalog: true,
      attestActor: true,
      attestContext: true,
      attestationPrivateKey: "operator-supplied-private-key",
      auth: "bearer",
      bearerToken: "t",
    },
  ]) {
    assert.equal((await put(invalid)).status, 400);
  }
  const attested = await put({
    catalog: true,
    attestActor: true,
    attestContext: true,
    auth: "bearer",
    bearerToken: "t",
    credentialScope: "shared",
  });
  assert.equal(attested.status, 200);
  const attestedBody = await attested.text();
  assert.doesNotMatch(attestedBody, /PRIVATE KEY/);
  const attestedServer = JSON.parse(attestedBody).server;
  assert.equal(attestedServer.hasAttestationPrivateKey, true);
  assert.match(attestedServer.attestationPublicKey, /BEGIN PUBLIC KEY/);
  assert.equal(typeof attestedServer.attestationKeyId, "string");
  assert.match((await store.get("crm"))?.attestationPrivateKey ?? "", /BEGIN PRIVATE KEY/);
  const publicKey = (await store.get("crm"))?.attestationPublicKey;
  const keyId = (await store.get("crm"))?.attestationKeyId;
  const listed = await fetch(url.replace("/crm", ""), { headers: ADMIN });
  assert.doesNotMatch(await listed.text(), /PRIVATE KEY/);
  assert.equal(
    (
      await put({
        catalog: true,
        attestActor: true,
        attestContext: true,
        rotateAttestationKey: true,
        auth: "bearer",
        bearerToken: "t",
        credentialScope: "shared",
      })
    ).status,
    400,
  );
  const prepared = await put({
    catalog: true,
    attestActor: true,
    attestContext: true,
    prepareAttestationKey: true,
    auth: "bearer",
    bearerToken: "t",
    credentialScope: "shared",
  });
  assert.equal(prepared.status, 200);
  const preparedBody = await prepared.text();
  assert.doesNotMatch(preparedBody, /PRIVATE KEY/);
  const preparedServer = JSON.parse(preparedBody).server;
  const afterPrepare = await store.get("crm");
  assert.equal(afterPrepare?.attestationPublicKey, publicKey);
  assert.equal(afterPrepare?.attestationKeyId, keyId);
  assert.notEqual(afterPrepare?.pendingAttestationPublicKey, publicKey);
  assert.notEqual(afterPrepare?.pendingAttestationKeyId, keyId);
  assert.match(afterPrepare?.pendingAttestationPrivateKey ?? "", /BEGIN PRIVATE KEY/);
  assert.equal(preparedServer.pendingAttestationPublicKey, afterPrepare?.pendingAttestationPublicKey);
  assert.equal(preparedServer.pendingAttestationKeyId, afterPrepare?.pendingAttestationKeyId);
  assert.equal(preparedServer.hasPendingAttestationPrivateKey, true);
  const preparedAgain = await put({
    catalog: true,
    attestActor: true,
    attestContext: true,
    prepareAttestationKey: true,
    auth: "bearer",
    bearerToken: "t",
    credentialScope: "shared",
  });
  assert.equal(preparedAgain.status, 200);
  assert.equal((await store.get("crm"))?.pendingAttestationKeyId, afterPrepare?.pendingAttestationKeyId);
  const preparedListed = await fetch(url.replace("/crm", ""), { headers: ADMIN });
  const preparedListedText = await preparedListed.text();
  assert.doesNotMatch(preparedListedText, /PRIVATE KEY/);
  assert.equal(
    JSON.parse(preparedListedText).servers[0].pendingAttestationKeyId,
    afterPrepare?.pendingAttestationKeyId,
  );
  assert.equal(
    (
      await put({
        catalog: true,
        attestActor: true,
        attestContext: true,
        activateAttestationKeyId: "wrong-key-id",
        auth: "bearer",
        bearerToken: "t",
        credentialScope: "shared",
      })
    ).status,
    400,
  );
  assert.equal((await store.get("crm"))?.attestationKeyId, keyId);
  const activated = await put({
    catalog: true,
    attestActor: true,
    attestContext: true,
    activateAttestationKeyId: afterPrepare?.pendingAttestationKeyId,
    auth: "bearer",
    bearerToken: "t",
    credentialScope: "shared",
  });
  assert.equal(activated.status, 200);
  assert.doesNotMatch(await activated.text(), /PRIVATE KEY/);
  const afterActivate = await store.get("crm");
  assert.equal(afterActivate?.attestationPublicKey, afterPrepare?.pendingAttestationPublicKey);
  assert.equal(afterActivate?.attestationKeyId, afterPrepare?.pendingAttestationKeyId);
  assert.equal(afterActivate?.retiredAttestationKeys?.length, 1);
  assert.equal(afterActivate?.retiredAttestationKeys?.[0]?.publicKey, publicKey);
  assert.equal(afterActivate?.retiredAttestationKeys?.[0]?.keyId, keyId);
  assert.equal(typeof afterActivate?.retiredAttestationKeys?.[0]?.retiredAt, "number");
  assert.equal(JSON.stringify(afterActivate?.retiredAttestationKeys).includes("PRIVATE KEY"), false);
  assert.equal(afterActivate?.pendingAttestationPrivateKey, undefined);
  assert.equal(afterActivate?.pendingAttestationPublicKey, undefined);
  assert.equal(afterActivate?.pendingAttestationKeyId, undefined);
  for (let i = 0; i < 3; i++) {
    assert.equal(
      (
        await put({
          catalog: true,
          attestActor: true,
          attestContext: true,
          prepareAttestationKey: true,
          auth: "bearer",
          bearerToken: "t",
          credentialScope: "shared",
        })
      ).status,
      200,
    );
    const pendingKeyId = (await store.get("crm"))?.pendingAttestationKeyId;
    assert.equal(
      (
        await put({
          catalog: true,
          attestActor: true,
          attestContext: true,
          activateAttestationKeyId: pendingKeyId,
          auth: "bearer",
          bearerToken: "t",
          credentialScope: "shared",
        })
      ).status,
      200,
    );
  }
  const retiredHistory = (await store.get("crm"))?.retiredAttestationKeys;
  assert.equal(retiredHistory?.length, 4);
  assert.equal(
    retiredHistory?.some((key) => key.keyId === keyId),
    true,
  );
  const retiredListed = await fetch(url.replace("/crm", ""), { headers: ADMIN });
  const retiredListedText = await retiredListed.text();
  assert.doesNotMatch(retiredListedText, /PRIVATE KEY/);
  assert.deepEqual(JSON.parse(retiredListedText).servers[0].retiredAttestationKeys, retiredHistory);
});

test("production wiring never uses operator fallback tokens for per-user MCP calls", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-wiring-"));
  const previous = process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM;
  process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM = "operator-token";
  const built = buildApp(testConfig({ dataDir: dir, egressServiceHosts: ["accounts.example.com"] }));
  const remote = await startMcpTestServer(t, {
    tools: [{ name: "identity", inputSchema: { type: "object" } }],
    call: (_name, _args, authorization) => ({ content: [{ type: "text", text: authorization ?? "" }] }),
  });
  const calls = () => remote.requests.filter((r) => r.rpc === "tools/call").length;
  t.after(async () => {
    built.mcpToolService.close();
    if (previous === undefined) delete process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM;
    else process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await built.mcpServers.put({
    id: "crm",
    name: "CRM",
    url: `${remote.url}/mcp`,
    auth: "none",
    credentialScope: "per-user",
    credentialHost: "accounts.example.com",
    readOnly: true,
    enabled: true,
    updatedAt: Date.now(),
    updatedBy: "internal:admin",
  });
  await built.mcpToolService.refresh();
  assert.equal(
    await built.connectorTokens.connectorAccessToken("accounts.example.com", "internal:alice"),
    "operator-token",
  );
  await assert.rejects(built.mcpToolService.call("crm_identity", {}, "internal:alice"), /Connect your account/);
  assert.equal(calls(), 0);
  await built.connectorTokens.setConnectorToken("accounts.example.com", "internal:alice", {
    accessToken: "alice-only",
  });
  assert.equal((await built.mcpToolService.call("crm_identity", {}, "internal:alice")).text, "Bearer alice-only");
  assert.equal(calls(), 1);
});

test("MCP admin accepts per-user OAuth servers, discovers endpoints from metadata, and never shadows built-in connectors", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-oauth-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
  });
  const issuer = createServer((req, res) => {
    const base = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
    const metadata: Record<string, object> = {
      "/.well-known/oauth-authorization-server/id": {
        authorization_endpoint: `${base}/id/authorize`,
        token_endpoint: `${base}/id/token`,
      },
      "/.well-known/oauth-protected-resource/mcp": {
        resource: `${base}/mcp`,
        authorization_servers: [`${base}/id`],
        scopes_supported: ["mcp:write"],
      },
    };
    const meta = metadata[req.url ?? ""];
    if (!meta) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(meta));
  });
  server.listen(0, "127.0.0.1");
  issuer.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(issuer, "listening")]);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => issuer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const issuerUrl = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers`;
  const put = (id: string, body: object) =>
    fetch(`${base}/${id}`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ url: `${issuerUrl}/mcp`, auth: "oauth-user", ...body }),
    });

  const undiscoverable = await put("orders", { clientId: "c", url: `${issuerUrl}/elsewhere` });
  assert.equal(undiscoverable.status, 400);
  assert.match(((await undiscoverable.json()) as { message: string }).message, /discovery: .*HTTP 404/);
  assert.equal((await put("github", { clientId: "c" })).status, 400, "built-in connector ids are reserved");
  assert.equal((await put("orders", { clientId: "c", credentialHost: "github.com" })).status, 400);
  assert.equal((await put("orders", { clientId: "c", oauthTokenUrl: "http://id.example.com/token" })).status, 400);

  assert.equal((await put("orders", { clientId: " c " })).status, 200);
  const record = (await store.get("orders"))!;
  assert.equal(record.credentialScope, "per-user");
  assert.equal(record.credentialHost, "127.0.0.1");
  assert.equal(record.clientId, "c");
  assert.equal(record.oauthAuthorizeUrl, `${issuerUrl}/id/authorize`);
  assert.equal(record.oauthTokenUrl, `${issuerUrl}/id/token`);
  assert.deepEqual(record.oauthScopes, ["mcp:write"]);
  assert.equal(record.clientSecret, undefined);

  assert.equal(
    (
      await put("manual", {
        clientId: "c",
        url: "https://tools.example.com/mcp",
        oauthAuthorizeUrl: "https://id.example.com/authorize",
        oauthTokenUrl: "https://id.example.com/token",
        oauthScopes: "a b",
      })
    ).status,
    200,
    "explicit endpoints skip discovery",
  );
  assert.deepEqual((await store.get("manual"))!.oauthScopes, ["a", "b"]);
});

test("MCP admin save stores the server's own description from the probe", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-about-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  const remote = await startMcpTestServer(t, { instructions: "Search and update CRM records.\nAlways query first." });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
    mcpToolService: service,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers/crm`, {
    method: "PUT",
    headers: ADMIN,
    body: JSON.stringify({ url: `${remote.url}/mcp` }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { tools: string[] }).tools, ["query", "update"]);
  assert.equal((await store.get("crm"))!.about, "Search and update CRM records.\nAlways query first.");
});
