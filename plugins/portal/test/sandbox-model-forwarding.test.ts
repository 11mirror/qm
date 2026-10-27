import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

let sandboxModelRequests = 0;
let agentApiRequests = 0;

const upstream = createServer((req, res) => {
  if (req.url?.startsWith("/v1/sandbox-model/")) sandboxModelRequests++;
  if (req.url?.startsWith("/v1/memory/self")) agentApiRequests++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, headers: req.headers }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "http://portal.test";
process.env.PORTAL_SESSION_SECRET = "sandbox-model-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "sandbox-model-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  upstream.close();
});

test("sandbox model calls reach core with their documented auth headers; other /v1 routes still need a capability", async () => {
  const call = (path: string, headers: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "portal_session=spoofed", ...headers },
      body: "{}",
    });
  const before = sandboxModelRequests;
  const bearer = await call("/v1/sandbox-model/v1/chat/completions?x=1", {
    authorization: "Bearer sandbox.model.token",
  });
  assert.equal(bearer.status, 200);
  const bearerBody = (await bearer.json()) as { url: string; headers: Record<string, string> };
  assert.equal(bearerBody.url, "/v1/sandbox-model/v1/chat/completions?x=1");
  assert.equal(bearerBody.headers.authorization, "Bearer sandbox.model.token");
  assert.equal(bearerBody.headers.cookie, undefined);

  const anthropic = await call("/v1/sandbox-model/v1/messages", {
    "x-api-key": "sandbox.model.token",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "tools-2024",
  });
  assert.equal(anthropic.status, 200);
  const anthropicHeaders = ((await anthropic.json()) as { headers: Record<string, string> }).headers;
  assert.equal(anthropicHeaders["x-api-key"], "sandbox.model.token");
  assert.equal(anthropicHeaders["anthropic-version"], "2023-06-01");
  assert.equal(anthropicHeaders["anthropic-beta"], "tools-2024");
  assert.equal(sandboxModelRequests, before + 2);

  assert.equal((await call("/v1/sandbox-model/v1/chat/completions", {})).status, 404);
  assert.equal((await call("/v1/sandbox-model/v1/chat/completions", { authorization: "Bearer " })).status, 404);
  assert.equal((await call("/v1/sandbox-model/v1/chat/completions", { authorization: "Basic abc" })).status, 404);
  assert.equal(sandboxModelRequests, before + 2);

  const agentBefore = agentApiRequests;
  const credentials: Array<Record<string, string>> = [
    { authorization: "Bearer sandbox.model.token" },
    { "x-api-key": "sandbox.model.token" },
  ];
  for (const headers of credentials) {
    assert.equal((await call("/v1/memory/self", headers)).status, 404);
    assert.equal((await call("/v1/sandbox-model/../memory/self", headers)).status, 404);
  }
  assert.equal(agentApiRequests, agentBefore);
});
