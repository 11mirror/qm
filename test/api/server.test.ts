import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { gunzipSync } from "node:zlib";
import * as Sentry from "@sentry/node";
import pg from "pg";
import { flushErrorReporting, initializeErrorReporting } from "../../plugins/chassis/src/error-reporting.ts";
import { gzipAccepted, json as sendJson, sendBuffered } from "../../plugins/chassis/src/http.ts";
import { createServer, createInsecureTestServer, loggablePath } from "../../src/api/server.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { withTraceCarrier } from "../../src/runs/run-store.ts";
import { serverDeps } from "../../src/wiring.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { listenLocal } from "../support/listen-local.ts";

async function fixture(checkReadiness?: (signal: AbortSignal) => Promise<void>) {
  const config = testConfig({ signingSecret: "readiness-test-source-secret".repeat(3) });
  const built = buildApp(config);
  const server = createServer(built.app, {
    ...serverDeps(config, built),
    ...(checkReadiness ? { checkReadiness } : {}),
    requireSignedPortalIdentity: true,
    portalIdentitySecret: "readiness-test-portal-secret".repeat(3),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: (path: string) => fetch(`${url}${path}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("readiness is public and ready without a configured database", async () => {
  const srv = await fixture();
  try {
    const response = await srv.get("/readyz");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal((await srv.get("/healthz")).status, 200);
  } finally {
    await srv.close();
  }
});

test("readiness detects dependency loss and recovery without changing liveness or leaking errors", async () => {
  let available = true;
  let probes = 0;
  const srv = await fixture(async () => {
    probes++;
    if (!available) throw new Error("postgres://synthetic:secret@database.invalid/unavailable");
  });
  try {
    assert.equal((await srv.get("/readyz")).status, 200);
    available = false;
    const response = await srv.get("/readyz");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false });
    assert.equal((await srv.get("/healthz")).status, 200);
    assert.equal(probes, 2, "liveness must not touch the database");
    available = true;
    assert.equal((await srv.get("/readyz")).status, 200);
    assert.equal(probes, 3, "recovery must be checked, not cached");
  } finally {
    await srv.close();
  }
});

test("a stalled dependency is aborted within the readiness deadline while liveness stays responsive", async () => {
  let signal: AbortSignal | undefined;
  let recover = false;
  const srv = await fixture(async (s) => {
    signal = s;
    if (!recover) await new Promise(() => {});
  });
  try {
    const start = performance.now();
    const pending = srv.get("/readyz");
    const live = await srv.get("/healthz");
    assert.equal(live.status, 200);
    assert.ok(performance.now() - start < 500, "liveness must not wait for readiness");
    const response = await pending;
    assert.equal(response.status, 503);
    assert.ok(performance.now() - start < 2000, "readiness must return within two seconds");
    assert.deepEqual(await response.json(), { ok: false });
    assert.equal(signal?.aborted, true);
    recover = true;
    assert.equal((await srv.get("/readyz")).status, 200);
  } finally {
    await srv.close();
  }
});

test("readiness bounds a blackholed Postgres handshake and cleans up the pending connection", async () => {
  const sockets = new Set<Socket>();
  const blackhole = createTcpServer((socket) => sockets.add(socket));
  blackhole.listen(0, "127.0.0.1");
  await once(blackhole, "listening");
  const pg = createPgPool(`postgres://test:test@127.0.0.1:${(blackhole.address() as AddressInfo).port}/test`);
  const srv = await fixture(async (signal) => {
    await pg.q("SELECT 1", [], { signal });
  });
  try {
    const start = performance.now();
    const response = await srv.get("/readyz");
    assert.equal(response.status, 503);
    assert.ok(performance.now() - start < 2000);
    assert.deepEqual(await response.json(), { ok: false });
    assert.equal((await srv.get("/healthz")).status, 200);
    for (const socket of sockets) socket.destroy();
    const pool = await pg.pool();
    for (let i = 0; i < 50 && pool.totalCount; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(pool.totalCount, 0);
    assert.equal(pool.waitingCount, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await srv.close();
    await pg.close();
    await new Promise<void>((resolve) => blackhole.close(() => resolve()));
  }
});

test(
  "a stalled Postgres query discards its client and the next readiness probe recovers",
  {
    skip: !process.env.DATABASE_URL && "requires Postgres",
  },
  async () => {
    const pg = createPgPool(process.env.DATABASE_URL!);
    let slow = true;
    const srv = await fixture(async (signal) => {
      await pg.q(slow ? "SELECT pg_sleep(30)" : "SELECT 1", [], { signal });
    });
    try {
      const response = await srv.get("/readyz");
      assert.equal(response.status, 503);
      const pool = await pg.pool();
      assert.equal(pool.totalCount, 0, "a cancelled query must not retain a checked-out client");
      slow = false;
      assert.equal((await srv.get("/readyz")).status, 200);
      assert.equal(pool.totalCount, 1);
      assert.equal(pool.idleCount, 1);
    } finally {
      await srv.close();
      await pg.close();
    }
  },
);

test(
  "pool saturation fails readiness and a late acquired client is released before recovery",
  {
    skip: !process.env.DATABASE_URL && "requires Postgres",
  },
  async () => {
    const pg = createPgPool(process.env.DATABASE_URL!);
    const srv = await fixture(async (signal) => {
      await pg.q("SELECT 1", [], { signal });
    });
    const pool = await pg.pool();
    const held = await Promise.all(Array.from({ length: pool.options.max! }, () => pool.connect()));
    try {
      const start = performance.now();
      assert.equal((await srv.get("/readyz")).status, 503);
      assert.ok(performance.now() - start < 2000);
      assert.equal((await srv.get("/healthz")).status, 200);
      for (const client of held.splice(0)) client.release();
      assert.equal((await srv.get("/readyz")).status, 200);
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.idleCount, pool.totalCount, "no late acquisition may leak a client");
    } finally {
      for (const client of held) client.release();
      await srv.close();
      await pg.close();
    }
  },
);

const captured: Record<string, any>[] = [];
const collector = createHttpServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const lines = Buffer.concat(chunks).toString().split("\n");
  for (let i = 1; i + 1 < lines.length; i += 2) {
    if (JSON.parse(lines[i]!).type === "transaction") captured.push(JSON.parse(lines[i + 1]!));
  }
  res.end("{}");
});
collector.listen(0, "127.0.0.1");
await once(collector, "listening");
initializeErrorReporting(Sentry, "core", {
  SENTRY_DSN: `http://public@127.0.0.1:${(collector.address() as AddressInfo).port}/1`,
  SENTRY_TRACES_SAMPLE_RATE: "1",
});
after(async () => {
  collector.closeAllConnections();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

async function settle(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 60 && !predicate(); i++) {
    await flushErrorReporting();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("core requests are named by route template and carry no URL, query or header values", async () => {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app);
  const base = listenLocal(server);
  try {
    await fetch(`${base}/healthz`);
    await fetch(`${base}/v1/sessions/private-session-id?token=private-token`, {
      headers: { "x-qm-signature": "private-signature", cookie: "private-cookie" },
    });
    await fetch(`${base}/v1/no-such-route/private-segment-9f3a/deep`, { method: "POST" });
    const coreRequests = () =>
      captured.filter(
        (event) => event.contexts?.trace?.op === "http.server" && event.contexts.trace.data["http.route"] !== undefined,
      );
    await settle(() => coreRequests().length >= 2);
    const requests = coreRequests();
    assert.deepEqual(
      requests.map((event) => event.transaction),
      ["GET /v1/sessions/:id"],
      "health checks and 404s are not traced",
    );
    assert.doesNotMatch(JSON.stringify(requests), /private/);
    for (const event of requests) {
      assert.equal(event.tags?.service, "core");
      assert.equal(event.request, undefined);
      assert.match(event.contexts.trace.trace_id, /^[a-f0-9]{32}$/);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a run stores the request's trace context", async () => {
  const request = {
    actor: { id: "U1", type: "internal" as const },
    conversation: { kind: "dm" as const, threadRef: "dm:U1:carrier", audience: [] },
    origin: { kind: "human" as const },
    surface: "test",
    text: "hello",
    trace: { sentryTrace: "0123456789abcdef0123456789abcdef-0123456789abcdef-1" },
  };
  assert.equal(withTraceCarrier(request).trace, undefined, "a copied trace is dropped outside a request");
  await Sentry.startSpan({ name: "producer", op: "test" }, (span) => {
    assert.equal(withTraceCarrier(request).trace?.sentryTrace.split("-")[0], span.spanContext().traceId);
  });
});

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function get(base: string, path: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("error", reject);
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

function listen(server: Server): { base: string; close: () => Promise<void> } {
  server.listen(0);
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const bigBody = { rows: Array.from({ length: 200 }, (_, i) => ({ id: `row-${i}`, label: "a repetitive label" })) };
const bigJson = JSON.stringify(bigBody);

function jsonEcho(): { base: string; close: () => Promise<void> } {
  return listen(createHttpServer((req, res) => sendJson(res, 200, req.url === "/small" ? { ok: true } : bigBody)));
}

test("a client that accepts gzip gets a gzipped body that decodes to the identical bytes", async () => {
  const s = jsonEcho();
  try {
    const r = await get(s.base, "/big", { "accept-encoding": "gzip" });
    assert.equal(r.headers["content-encoding"], "gzip");
    assert.equal(r.headers["vary"], "accept-encoding");
    assert.ok(r.body.length < bigJson.length / 2, `expected real compression, got ${r.body.length}`);
    assert.equal(gunzipSync(r.body).toString("utf8"), bigJson);
  } finally {
    await s.close();
  }
});

test("a compressed response declares the length of the bytes on the wire, not of the plaintext", async () => {
  const s = jsonEcho();
  try {
    const r = await get(s.base, "/big", { "accept-encoding": "gzip" });
    assert.equal(r.headers["content-length"], String(r.body.length));
    assert.equal(r.headers["transfer-encoding"], undefined);
  } finally {
    await s.close();
  }
});

test("a caller's own content-length never survives onto a compressed body", { timeout: 5_000 }, async () => {
  const s = listen(
    createHttpServer((_req, res) =>
      sendBuffered(res, 200, { "content-type": "application/json", "content-length": String(bigJson.length) }, bigJson),
    ),
  );
  try {
    const r = await get(s.base, "/", { "accept-encoding": "gzip" });
    assert.equal(r.headers["content-length"], String(r.body.length));
    assert.equal(gunzipSync(r.body).toString("utf8"), bigJson);
  } finally {
    await s.close();
  }
});

test("a client that sends no accept-encoding gets the identical uncompressed body", async () => {
  const s = jsonEcho();
  try {
    const r = await get(s.base, "/big", {});
    assert.equal(r.headers["content-encoding"], undefined);
    assert.equal(r.body.toString("utf8"), bigJson);
  } finally {
    await s.close();
  }
});

test("a client that refuses gzip with q=0 gets the identical uncompressed body", async () => {
  const s = jsonEcho();
  try {
    const r = await get(s.base, "/big", { "accept-encoding": "gzip;q=0, deflate" });
    assert.equal(r.headers["content-encoding"], undefined);
    assert.equal(r.body.toString("utf8"), bigJson);
  } finally {
    await s.close();
  }
});

test("a payload below the minimum size is not worth compressing", async () => {
  const s = jsonEcho();
  try {
    const r = await get(s.base, "/small", { "accept-encoding": "gzip" });
    assert.equal(r.headers["content-encoding"], undefined);
    assert.equal(r.headers["vary"], "accept-encoding");
    assert.equal(r.body.toString("utf8"), '{"ok":true}');
  } finally {
    await s.close();
  }
});

test("a handler that fails after a large send still answers coherently instead of shipping an empty gzip", async () => {
  const s = listen(
    createHttpServer((_req, res) => {
      sendJson(res, 200, bigBody);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    }),
  );
  try {
    const r = await get(s.base, "/", { "accept-encoding": "gzip" });
    assert.equal(r.status, 500);
    assert.equal(r.headers["content-encoding"], undefined);
    assert.equal(r.body.toString("utf8"), '{"error":"internal_error"}');
  } finally {
    await s.close();
  }
});

test("a client that vanishes mid-compression leaves the server serving the next request", async () => {
  let abandoned: ServerResponse | undefined;
  const s = listen(
    createHttpServer((_req, res) => {
      sendJson(res, 200, bigBody);
      if (abandoned) return;
      abandoned = res;
      res.destroy();
    }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(s.base, { headers: { "accept-encoding": "gzip" }, agent: false }, () => resolve());
      req.on("error", (err: NodeJS.ErrnoException) => (err.code === "ECONNRESET" ? resolve() : reject(err)));
      req.end();
    });
    assert.equal(abandoned?.destroyed, true, "the response is gone before its compression finishes");
    const after = await get(s.base, "/", { "accept-encoding": "gzip" });
    assert.equal(gunzipSync(after.body).toString("utf8"), bigJson);
  } finally {
    await s.close();
  }
});

test(
  "a competing response that has claimed the head is never overwritten by a late compression",
  { timeout: 5_000 },
  async () => {
    const s = listen(
      createHttpServer((_req, res) => {
        sendJson(res, 200, bigBody);
        res.writeHead(500, { "content-type": "text/plain" });
        res.write("interloper");
        setTimeout(() => res.end(), 100);
      }),
    );
    try {
      const r = await get(s.base, "/", { "accept-encoding": "gzip" });
      assert.equal(r.status, 500);
      assert.equal(r.headers["content-encoding"], undefined);
      assert.equal(r.body.toString("utf8"), "interloper");
    } finally {
      await s.close();
    }
  },
);

test("the core API server compresses a response written through Fastify's hijacked reply", async () => {
  const built = buildApp(testConfig());
  const s = listen(createInsecureTestServer(built.app));
  try {
    const path = `/v1/${"x".repeat(1200)}`;
    const packed = await get(s.base, path, { "accept-encoding": "gzip" });
    assert.equal(packed.headers["content-encoding"], "gzip");
    const plain = await get(s.base, path, {});
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(gunzipSync(packed.body).toString("utf8"), plain.body.toString("utf8"));
    assert.ok(packed.body.length < plain.body.length / 2);
  } finally {
    await s.close();
  }
});

test("gzipAccepted reads the accept-encoding grammar rather than substring-matching it", () => {
  const asks = (value?: string | string[]): boolean =>
    gzipAccepted(
      value === undefined
        ? ({ headers: {} } as IncomingMessage)
        : ({ headers: { "accept-encoding": value } } as unknown as IncomingMessage),
    );
  assert.equal(gzipAccepted(undefined), false);
  assert.equal(asks(), false);
  assert.equal(asks(""), false);
  assert.equal(asks("gzip"), true);
  assert.equal(asks("GZIP, br"), true);
  assert.equal(asks(" gzip ; q=0.5 , br"), true);
  assert.equal(asks("gzip;q=0"), false);
  assert.equal(asks("gzip;q=0.0"), false);
  assert.equal(asks("gzip;q=abc"), false);
  assert.equal(asks("br, deflate"), false);
  assert.equal(asks("*"), true);
  assert.equal(asks("*;q=0"), false);
  assert.equal(asks("*, gzip;q=0"), false);
  assert.equal(asks("gzip, *;q=0"), true);
  assert.equal(asks("identity"), false);
  assert.equal(asks(["gzip", "br"]), true);
});

test("server error logs keep the path but drop query strings that can carry tokens", () => {
  assert.equal(loggablePath("/v1/drops/abc?t=secret-drop-token"), "/v1/drops/abc?<query omitted>");
  assert.equal(loggablePath("/oauth/callback?code=xyz&state=s"), "/oauth/callback?<query omitted>");
  assert.equal(loggablePath("/healthz"), "/healthz");
  assert.equal(loggablePath(undefined), "?");
});

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
  const base = listenLocal(server);
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

test("a server without a keychain key refuses to start and names the missing setting", () => {
  const config = testConfig();
  delete (config as { connectorSecretKey?: string }).connectorSecretKey;
  assert.throws(() => buildApp(config), /CONNECTOR_SECRET_KEY is required/);
});
