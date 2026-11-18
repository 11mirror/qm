import assert from "node:assert/strict";
import { test } from "node:test";
import { surfaceRoutes } from "../src/api/routes/surface.ts";
import { findRoute, type ApiCtx } from "../src/api/routes/route.ts";
import type { FinnyCertifiedResultRecord } from "../src/finny/certified-result.ts";

const result = {
  id: "result-1",
  scopeId: "personal:U1",
  schema: "finny.result.v1",
  summary: { period: "2026-10-31", currency: "INR", metrics: [], exceptions: [], caveats: [] },
} as unknown as FinnyCertifiedResultRecord;

async function request(viewer: string, stored: FinnyCertifiedResultRecord, managesScope = false) {
  const path = `/v1/finny/results/${stored.id}`;
  const found = findRoute(surfaceRoutes, "GET", path);
  assert.ok(found);
  const output = { status: 0, body: undefined as unknown, headers: new Map<string, string>() };
  const response = {
    setHeader(name: string, value: string) {
      output.headers.set(name.toLowerCase(), value);
    },
    getHeader() {},
    writeHead(status: number) {
      output.status = status;
      return this;
    },
    end(body?: string) {
      output.body = body ? JSON.parse(body) : undefined;
    },
  } as unknown as ApiCtx["res"];
  await found.route.handle({
    app: { managesScope: async () => managesScope },
    deps: { finnyResultReader: { get: async () => stored } },
    params: found.params,
    res: response,
    url: new URL(`https://core.example${path}?viewer=${viewer}`),
  } as unknown as ApiCtx);
  return output;
}

test("certified result download authorizes personal and managed organization scopes", async () => {
  const personal = await request("U1", result);
  assert.equal(personal.status, 200);
  assert.deepEqual(personal.body, result);
  assert.match(personal.headers.get("content-disposition") ?? "", /finny-result-result-1\.json/);
  assert.equal((await request("U2", result)).status, 404);
  const organization = { ...result, scopeId: "org:sharechat" };
  assert.equal((await request("U1", organization, true)).status, 200);
  assert.equal((await request("U1", organization, false)).status, 404);
});
