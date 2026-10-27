import "../../../support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../../../plugins/chassis/src/portal-identity.ts";

const SECRET = "web-ui-body-cap-test-secret";
const core = createHttpServer((_req, res) => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
core.listen(0);
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { handler } = await import("../../../../plugins/web-ui/server/index.ts");
const web = createHttpServer(handler);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;
const headers = {
  "content-type": "application/json",
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 3_600_000 }, SECRET),
};

after(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
});

test("an over-cap POST to /api/turn (the primary path) is rejected with 413, not 400/502", async () => {
  const huge = "x".repeat(1_000_001);
  const res = await fetch(`${webBase}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hi", pad: huge }),
  });
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "payload_too_large");
});

test("a normal-sized body is unaffected by the cap", async () => {
  const res = await fetch(`${webBase}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hi" }),
  });
  assert.notEqual(res.status, 413);
});
