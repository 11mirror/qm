import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_API_ROUTES } from "../../../portal/src/cors.ts";
import { findRoute } from "../../../chassis/src/router.ts";

process.env.CORE_API_URL ??= "http://127.0.0.1:9";
const { apiRoutes } = await import("../../server/index.ts");

const samplePath = (path: string) => path.replace(/:\w+/g, "x1");

test("every cross-origin chat route the portal allows is a route web-ui serves", () => {
  for (const { method, path } of CHAT_API_ROUTES) {
    assert.ok(findRoute(apiRoutes, method, samplePath(path)), `${method} ${path} has no web-ui route`);
  }
});
