import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { App, RedeployInput } from "../../../src/api/app.ts";
import { createServer } from "../../../src/api/server.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../../../src/auth/capability-token.ts";
import { createPostgresReplayDedupe } from "../../../src/auth/replay-dedupe.ts";
import { signRequest } from "../../../src/auth/source-auth.ts";
import { scopeId } from "../../../src/types.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";

const SECRET = "agent-deployment-fetch-secret".repeat(2);

describe("agent deployment fetch", () => {
  let upstream: Server;
  let server: Server;
  let base: string;
  let upstreamPort: number;
  let downPort: number;

  const capFor = (actorId: string) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );

  const get = async (path: string, actorId?: string) =>
    fetch(`${base}${path}`, {
      headers: actorId ? { "x-agent-capability": await capFor(actorId) } : {},
    });

  before(async () => {
    upstream = createHttpServer((req, res) => {
      if (req.url === "/binary") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from([0, 255, 1, 254]));
        return;
      }
      if (req.url === "/large") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("abcdefghij");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>owner dashboard</h1>");
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;

    const closed = createHttpServer();
    await new Promise<void>((resolve) => closed.listen(0, resolve));
    downPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const app = {
      authorizesCapabilityScope: async () => true,
      reachDeployment: async (id: string, viewer: string) => {
        if (id !== "mine" && id !== "down") return { status: "not_found" as const };
        if (viewer !== "U1") return { status: "denied" as const };
        return {
          status: "ok" as const,
          endpoint: { host: "127.0.0.1", port: id === "down" ? downPort : upstreamPort },
        };
      },
    } as unknown as App;
    server = createServer(app, { replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()), signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("requires an identified viewer", async () => {
    assert.equal((await get("/v1/deployments/mine/fetch")).status, 401);
  });

  it("fetches rendered text for the owner", async () => {
    const response = await get("/v1/deployments/mine/fetch", "U1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<h1>owner dashboard</h1>",
      truncated: false,
    });
  });

  it("hides an out-of-reach deployment", async () => {
    assert.equal((await get("/v1/deployments/mine/fetch", "U2")).status, 404);
  });

  it("truncates at the requested byte cap", async () => {
    const response = await get("/v1/deployments/mine/fetch?path=%2Flarge&maxBytes=4", "U1");
    assert.deepEqual(await response.json(), {
      status: 200,
      contentType: "text/plain",
      body: "abcd",
      truncated: true,
    });
  });

  it("maps an unavailable upstream to 502", async () => {
    const response = await get("/v1/deployments/down/fetch", "U1");
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "upstream_unreachable" });
  });

  it("encodes binary content as base64", async () => {
    const response = await get("/v1/deployments/mine/fetch?path=%2Fbinary", "U1");
    assert.deepEqual(await response.json(), {
      status: 200,
      contentType: "application/octet-stream",
      body: Buffer.from([0, 255, 1, 254]).toString("base64"),
      encoding: "base64",
      truncated: false,
    });
  });

  it("rejects encoded traversal variants", async () => {
    assert.equal((await get("/v1/deployments/mine/fetch?path=%2F%2525252e%2525252e%2525255csecret", "U1")).status, 400);
  });
});

const DEPLOY_LOGS_ROUTE_SECRET = "deploy-logs-route-secret".repeat(2);

describe("deployment logs route", () => {
  let server: Server;
  let base: string;
  let lastTail: number | null = null;

  const capFor = (actorId: string) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      DEPLOY_LOGS_ROUTE_SECRET,
    );

  const get = async (path: string, actorId?: string) =>
    fetch(`${base}${path}`, {
      headers: actorId ? { "x-agent-capability": await capFor(actorId) } : {},
    });

  before(async () => {
    const app = {
      authorizesCapabilityScope: async () => true,
      deploymentLogsFor: async (id: string, viewer: string, opts: { tailLines: number }) => {
        lastTail = opts.tailLines;
        if (id === "missing") return { status: "not_found" as const };
        if (viewer !== "U1") return { status: "denied" as const };
        if (id === "silent") return { status: "ok" as const, logs: null };
        return { status: "ok" as const, logs: "line1\nline2\n" };
      },
    } as unknown as App;
    server = createServer(app, {
      replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
      signingSecret: DEPLOY_LOGS_ROUTE_SECRET,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("requires an identified viewer", async () => {
    assert.equal((await get("/v1/deployments/mine/logs")).status, 401);
  });

  it("returns logs to a viewer who can reach the deployment", async () => {
    const response = await get("/v1/deployments/mine/logs", "U1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { logs: "line1\nline2\n" });
    assert.equal(lastTail, 200);
  });

  it("passes tailLines through and rejects out-of-range values", async () => {
    assert.equal((await get("/v1/deployments/mine/logs?tailLines=50", "U1")).status, 200);
    assert.equal(lastTail, 50);
    assert.equal((await get("/v1/deployments/mine/logs?tailLines=0", "U1")).status, 400);
    assert.equal((await get("/v1/deployments/mine/logs?tailLines=2001", "U1")).status, 400);
    assert.equal((await get("/v1/deployments/mine/logs?tailLines=abc", "U1")).status, 400);
  });

  it("hides denied and missing deployments as not_found", async () => {
    assert.equal((await get("/v1/deployments/mine/logs", "U2")).status, 404);
    assert.equal((await get("/v1/deployments/missing/logs", "U1")).status, 404);
  });

  it("says when the provider keeps no logs", async () => {
    const response = await get("/v1/deployments/silent/logs", "U1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { logs: null, message: "no logs available for this deployment" });
  });
});

const DEPLOY_REDEPLOY_ROUTE_SECRET = "deploy-redeploy-route-secret".repeat(2);

describe("deployment redeploy route", () => {
  let server: Server;
  let base: string;
  let received: RedeployInput | undefined;

  const post = async (path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(DEPLOY_REDEPLOY_ROUTE_SECRET, ts, `POST\n${path}\n${raw}`),
      },
      body: raw,
    });
  };

  before(async () => {
    const deployment = {
      id: "dep-1",
      name: "envy",
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      currentVersion: 1,
      status: "running" as const,
      endpoint: null,
      versions: [{ version: 1, createdAt: 1, entrypoint: "x", snapshotDir: "/tmp" }],
    };
    const app = {
      listDeployments: async () => [deployment],
      getDeployment: async (idOrName: string) =>
        idOrName === deployment.id || idOrName === deployment.name ? deployment : null,
      canManageDeployment: async () => true,
      redeploy: async (_id: string, input: RedeployInput) => {
        received = input;
        return deployment;
      },
    } as unknown as App;
    server = createServer(app, {
      replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
      signingSecret: DEPLOY_REDEPLOY_ROUTE_SECRET,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("forwards env, home files and alwaysOn to the deploy service and answers with the view", async () => {
    const body = {
      entrypoint: "node app.js",
      files: [{ path: "app.js", data: "listen" }],
      homeFiles: [{ path: ".npmrc", data: "token" }],
      env: { DB_URL: "postgres://one" },
      alwaysOn: false,
    };
    const response = await post("/v1/deployments/envy/redeploy", body);
    assert.equal(response.status, 200);
    assert.deepEqual(received, body);
    const { deployment } = (await response.json()) as { deployment: { versions: Record<string, unknown>[] } };
    assert.deepEqual(Object.keys(deployment.versions[0]!), ["version", "createdAt"], "no snapshot paths or env");
  });

  it("still requires an entrypoint and files", async () => {
    assert.equal((await post("/v1/deployments/envy/redeploy", { env: { A: "1" } })).status, 400);
  });

  it("rejects malformed optional fields", async () => {
    const valid = { entrypoint: "node app.js", files: [] };
    for (const bad of [
      { alwaysOn: "false" },
      { env: "DB=two" },
      { env: null },
      { env: ["A=1"] },
      { homeFiles: null },
    ]) {
      const response = await post("/v1/deployments/envy/redeploy", { ...valid, ...bad });
      assert.equal(response.status, 400, JSON.stringify(bad));
    }
  });
});
