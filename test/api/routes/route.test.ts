import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compilePath,
  createRouter,
  findRoute,
  type Route,
  type BaseCtx,
  type RouteAuth,
} from "../../../src/api/routes/route.ts";
import { apiRoutes, rawRoutes } from "../../../src/api/routes/index.ts";
import {
  OAUTH_CONSENT_AUD,
  CREDENTIAL_BROKER_AUD,
  BROWSER_MODEL_AUD,
  SANDBOX_MODEL_AUD,
} from "../../../src/auth/capability-token.ts";

function matched(path: string, pathname: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  return compilePath(path).test("GET", pathname, out) ? out : null;
}

test("compilePath: static paths match exactly", () => {
  assert.deepEqual(matched("/v1/crons", "/v1/crons"), {});
  assert.equal(matched("/v1/crons", "/v1/crons/x"), null);
  assert.equal(matched("/v1/crons", "/v1/cron"), null);
});

test("compilePath: a :param captures exactly one decoded segment", () => {
  assert.deepEqual(matched("/v1/crons/:id", "/v1/crons/abc"), { id: "abc" });
  assert.deepEqual(matched("/v1/crons/:id/disable", "/v1/crons/abc/disable"), { id: "abc" });
  assert.equal(matched("/v1/crons/:id", "/v1/crons/abc/disable"), null);
  assert.equal(matched("/v1/crons/:id/disable", "/v1/crons/abc"), null);
});

test("compilePath: params are URL-decoded; %2F does not smuggle a slash past segmenting", () => {
  assert.deepEqual(matched("/v1/admin/scopes/:scope", "/v1/admin/scopes/org%3Adefault-org"), {
    scope: "org:default-org",
  });
  assert.deepEqual(matched("/v1/admin/scopes/:scope", "/v1/admin/scopes/a%2Fb"), { scope: "a/b" });
});

test("compilePath: a malformed % is a clean no-match, never a throw", () => {
  assert.doesNotThrow(() => matched("/v1/crons/:id", "/v1/crons/%zz"));
  assert.equal(matched("/v1/crons/:id", "/v1/crons/%zz"), null);
});

test("findRoute: first-match wins, so a fixed suffix shadows the bare :id when listed first", () => {
  const seen: string[] = [];
  const routes: Route<BaseCtx>[] = [
    { method: "GET", path: "/v1/x/:id/title", auth: "source", handle: () => void seen.push("title") },
    { method: "GET", path: "/v1/x/:id", auth: "source", handle: () => void seen.push("id") },
  ];
  assert.equal(findRoute(routes, "GET", "/v1/x/7/title")?.route, routes[0]);
  assert.deepEqual(findRoute(routes, "GET", "/v1/x/7/title")?.params, { id: "7" });
  assert.equal(findRoute(routes, "GET", "/v1/x/7")?.route, routes[1]);
  assert.equal(findRoute(routes, "POST", "/v1/x/7"), null, "method must match too");
});

test("findRoute: a custom match route still works and yields empty params", () => {
  const route: Route<BaseCtx> = {
    match: (m, p) => m === "GET" && p.startsWith("/d/"),
    auth: "source",
    handle: () => {},
  };
  const found = findRoute([route], "GET", "/d/app/anything/here");
  assert.equal(found?.route, route);
  assert.deepEqual(found?.params, {});
});

test("each API route's literals survive URL decoding and its own path resolves to it", () => {
  for (const route of apiRoutes) {
    if (!("path" in route)) continue;
    const segments = route.path.split("/");
    const literals = segments.filter((segment) => !segment.startsWith(":"));
    assert.deepEqual(literals.map(encodeURIComponent), literals, route.path);
    const sample = segments.map((segment) => (segment.startsWith(":") ? "x" : segment)).join("/");
    assert.equal(findRoute(apiRoutes, route.method, sample)?.route, route, `${route.method} ${route.path}`);
  }
});

test("createRouter prefers a literal segment over a :param regardless of table order", () => {
  const routes: Route<BaseCtx>[] = [
    { method: "GET", path: "/v1/x/:id/content", auth: "source", handle: () => {} },
    { method: "GET", path: "/v1/x/uploads/:id", auth: "source", handle: () => {} },
    { method: "GET", path: "/v1/x/:id", auth: "source", handle: () => {} },
    { method: "GET", path: "/v1/x/pending", auth: "source", handle: () => {} },
    { match: (m, p) => m === "GET" && p.startsWith("/v1/x/"), auth: "source", handle: () => {} },
  ];
  const match = createRouter(routes);
  assert.equal(match("GET", "/v1/x/uploads/content")?.route, routes[1]);
  assert.deepEqual(match("GET", "/v1/x/uploads/content")?.params, { id: "content" });
  assert.equal(match("GET", "/v1/x/pending")?.route, routes[3]);
  assert.deepEqual(match("GET", "/v1/x/7")?.params, { id: "7" });
  assert.equal(match("GET", "/v1/x/a/b/c")?.route, routes[4], "match routes answer only when no path route does");
  assert.equal(match("POST", "/v1/x/7"), null);
});

const AUD_ROUTES = new Map<string, string>([
  ["POST /v1/browser-model/chat/completions", BROWSER_MODEL_AUD],
  ["GET /v1/sandbox-model/v1/models", SANDBOX_MODEL_AUD],
  ["POST /v1/sandbox-model/v1/chat/completions", SANDBOX_MODEL_AUD],
  ["POST /v1/sandbox-model/v1/responses", SANDBOX_MODEL_AUD],
  ["POST /v1/sandbox-model/v1/messages", SANDBOX_MODEL_AUD],
  ["POST /v1/connectors/oauth/consent/mint", OAUTH_CONSENT_AUD],
  ["POST /v1/credentials/broker", CREDENTIAL_BROKER_AUD],
]);
test("every pinned dedicated-audience route actually resolves in the table", () => {
  for (const key of AUD_ROUTES.keys()) {
    const [method, pathname] = key.split(" ") as [string, string];
    const found = findRoute(apiRoutes, method, pathname);
    assert.ok(found, `${key} is pinned but no route serves it`);
    assert.equal(
      typeof found.route.auth === "object" ? found.route.auth.aud : found.route.auth,
      AUD_ROUTES.get(key),
      `${key} resolves with unexpected auth`,
    );
  }
});

test("raw routes keep their declared auth contracts (front enforces capability audiences, handlers enforce the rest)", () => {
  const pins: Array<[string, string, RouteAuth]> = [
    ["GET", "/healthz", "public"],
    ["GET", "/readyz", "public"],
    ["GET", "/v1/spend/export", "public"],
    ["GET", "/v1/credentials/http/gitlab/acme/repo.git/info/refs", { aud: CREDENTIAL_BROKER_AUD }],
    ["POST", "/v1/credentials/http/gitlab/acme/repo.git/git-upload-pack", { aud: CREDENTIAL_BROKER_AUD }],
  ];
  for (const [method, pathname, auth] of pins) {
    const found = findRoute(rawRoutes, method, pathname);
    assert.ok(found, `${method} ${pathname} not served by a raw route`);
    assert.deepEqual(found.route.auth, auth, `${method} ${pathname} declares unexpected auth`);
  }
  for (const route of rawRoutes) {
    assert.ok(route.auth !== undefined, "every raw route must declare its auth contract");
  }
});
