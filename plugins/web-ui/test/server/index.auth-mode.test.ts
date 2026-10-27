import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../../chassis/src/portal-identity.ts";

const core = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => core.listen(0, r));

const SECRET = "auth-mode-portal-test-secret";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("an unauthenticated request is refused", async () => {
  const r = await fetch(`${base}/me`);
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "sign in", reason: "unauthenticated" });
});

test("there is no cookie sign-in endpoint", async () => {
  const r = await fetch(`${base}/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "alice" }),
  });
  assert.equal(r.status, 404);
});

test("a webuiuser cookie confers nothing", async () => {
  const r = await fetch(`${base}/me`, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).reason, "unauthenticated");
});

test("a verified principal outside WEB_UI_PRINCIPALS is not_allowed, not unauthenticated", async () => {
  const token = mintPortalIdentity({ p: "mallory", exp: Date.now() + 60_000 }, SECRET);
  const r = await fetch(`${base}/me`, { headers: { [PORTAL_IDENTITY_HEADER]: token } });
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.reason, "not_allowed");
});

test("a verified allowed principal gets through", async () => {
  const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET);
  const r = await fetch(`${base}/me`, { headers: { [PORTAL_IDENTITY_HEADER]: token } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.user, "alice");
});
