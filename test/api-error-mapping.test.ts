import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

test("domain refusals keep their 4xx while backend failures surface as 500", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "error-mapping-")) }));
  const failures: unknown[] = [
    new Error("a refusal the caller can fix"),
    new pg.DatabaseError("connection to the database was lost", 0, "error"),
    new TypeError("cannot read properties of undefined"),
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", syscall: "connect" }),
  ];
  let next: unknown;
  built.app.createWebhook = async () => {
    throw next;
  };
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const webhook = JSON.stringify({
    ownerScopeId: "personal:alice",
    owner: "alice",
    createdBy: "alice",
    action: "summarize",
    verification: { scheme: "hmac-sha256", secret: "s" },
  });
  try {
    const seen: Array<[number, unknown]> = [];
    for (const failure of failures) {
      next = failure;
      const res = await fetch(`${base}/v1/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: webhook,
      });
      seen.push([res.status, await res.json()]);
    }
    assert.deepEqual(seen, [
      [400, { error: "webhook_create_failed", message: "a refusal the caller can fix" }],
      [500, { error: "internal_error", message: "internal server error" }],
      [500, { error: "internal_error", message: "internal server error" }],
      [500, { error: "internal_error", message: "internal server error" }],
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
