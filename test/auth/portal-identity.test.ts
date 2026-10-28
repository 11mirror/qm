import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, describe, it } from "node:test";
import { authBrokerRoutes } from "../../src/api/routes/auth-broker.ts";
import { createServer } from "../../src/api/server.ts";
import { mintPortalIdentity } from "../../src/auth/portal-identity.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { signRequest } from "../../plugins/chassis/src/source-auth-sign.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { listenLocal } from "../support/listen-local.ts";

const SECRET = "portal-actor-binding-signing-secret";
const ALICE = "alice@default-org";
const BOB = "bob@default-org";

const ROUTES: Array<[string, string, "query" | "body"]> = [
  ["GET", "/v1/ui-state?key=k", "query"],
  ["PUT", "/v1/ui-state", "body"],
  ["GET", "/v1/runtime-config", "query"],
  ["PUT", "/v1/runtime-config", "body"],
  ["GET", "/v1/channel-header-pin", "query"],
  ["PUT", "/v1/channel-header-pin", "body"],
  ["PATCH", "/v1/projects/p1", "body"],
  ["PUT", "/v1/projects/p1/slack-channel", "body"],
  ["DELETE", "/v1/projects/p1/slack-channel", "body"],
  ["PUT", "/v1/contexts/policy", "body"],
  ["POST", "/v1/keychain/approvals/a1", "body"],
  ["POST", "/v1/ui/observe/c1/result", "body"],
  ["GET", "/v1/ui/canvases/s1", "query"],
  ["POST", "/v1/ui/canvases/s1", "body"],
  ["GET", "/v1/crons/c1/items/i1/image", "query"],
  ["GET", "/v1/deployments/d1", "query"],
  ["POST", "/v1/webhooks/w1/enable", "query"],
];

test("routes that act as a caller-named principal bind it to the signed portal identity", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "actor-binding-")) }));
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    requireSignedPortalIdentity: true,
    capabilitySecret: `${SECRET}-cap`,
    portalIdentitySecret: `${SECRET}-portal`,
  });
  const base = listenLocal(server);
  const call = async (
    method: string,
    path: string,
    where: "query" | "body",
    principalId: string,
    signedIn?: string,
  ) => {
    const target = where === "query" ? `${path}${path.includes("?") ? "&" : "?"}principalId=${principalId}` : path;
    const body = where === "body" ? JSON.stringify({ principalId }) : "";
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(base + target, {
      method,
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `${method}\n${target}\n${body}`),
        ...(signedIn
          ? {
              "x-portal-identity": await mintPortalIdentity(
                { p: signedIn, exp: Date.now() + 60_000 },
                `${SECRET}-portal`,
              ),
            }
          : {}),
      },
      ...(body ? { body } : {}),
    });
    return { status: res.status, body: (await res.text()).slice(0, 300) };
  };
  try {
    for (const [method, path, where] of ROUTES) {
      const spoofed = await call(method, path, where, BOB, ALICE);
      assert.equal(spoofed.status, 403, `${method} ${path}: ${spoofed.body}`);
      assert.match(spoofed.body, /portal identity does not match the requested actor/, `${method} ${path}`);
      const anonymous = await call(method, path, where, ALICE);
      assert.equal(anonymous.status, 401, `${method} ${path}: ${anonymous.body}`);
      const own = await call(method, path, where, ALICE, ALICE);
      assert.ok(
        !/portal identity (does not match|required)/.test(own.body),
        `${method} ${path} refused its own caller: ${own.body}`,
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("service-to-service writes are classified", () => {
  it("every auth-broker source write declares its actor, so production gating cannot demand a portal identity from a plugin", () => {
    const undeclared = authBrokerRoutes
      .filter((route) => "path" in route && route.auth === "source" && route.method !== "GET" && !route.actor)
      .map((route) => `${(route as { method: string }).method} ${(route as { path: string }).path}`);
    assert.deepEqual(
      undeclared,
      [],
      'a write defaults to requiring a portal identity under REQUIRE_SIGNED_PORTAL_IDENTITY; declare actor: "system" or "person" on the route',
    );
  });
});
