import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

let upstreamRequests = 0;
const upstream = createServer((_req, res) => {
  upstreamRequests++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "http://portal.test";
process.env.PORTAL_SESSION_SECRET = "request-target-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "request-target-test-core-secret";
process.env.PORTAL_IDENTITY_SECRET = "request-target-test-identity-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as AddressInfo).port;

test.after(() => {
  server.close();
  upstream.close();
});

function raw(path: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "localhost", port, path, method: "GET" });
    req.on("error", reject);
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.end();
  });
}

test("request targets the URL parser rejects get the illegal-path 400, not a 500", async () => {
  const expected = { error: "bad_request", message: "illegal path" };
  for (const path of ["//interactsh.com%2f..", "//%zz", "//a%2f..", "//"]) {
    const response = await raw(path);
    assert.equal(response.status, 400, path);
    assert.deepEqual(JSON.parse(response.body), expected, path);
    assert.equal(response.headers["x-frame-options"], "DENY", path);
  }
  const parsable = await raw("//example.com/x");
  assert.equal(parsable.status, 400);
  assert.deepEqual(JSON.parse(parsable.body), expected);
  assert.equal(upstreamRequests, 0);
});
