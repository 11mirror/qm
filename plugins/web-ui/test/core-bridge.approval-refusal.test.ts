import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveApproval } from "../src/core-bridge.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

function stubResolveResponse(body: unknown, status: number): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/approvals/a-1") && init?.method === "POST") {
      return jsonResponse(body, status);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("deciding an approval that was already decided resolves quietly with nothing to follow", async () => {
  stubResolveResponse({ error: "not_found" }, 404);
  assert.equal(await resolveApproval({ requestId: "a-1", approved: false }), null);
});
