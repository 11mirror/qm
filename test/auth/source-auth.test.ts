import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createInsecureTestServer, createServer } from "../../src/api/server.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { createSourceAuth, verifySignature, SOURCE_AUTH_REPLAY_WINDOW_MS } from "../../src/auth/source-auth.ts";
import { signRequest } from "../../plugins/chassis/src/source-auth-sign.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { listenLocal } from "../support/listen-local.ts";

const SECRET = "unit-test-secret";
const W = SOURCE_AUTH_REPLAY_WINDOW_MS;

function signedReq(tsSec: number, body: string, eventId = `evt-${tsSec}-${body}`) {
  return { signature: signRequest(SECRET, tsSec, body), timestamp: tsSec, body, eventId };
}

test("a non-numeric timestamp is rejected even when the signature matches the NaN canonical string", () => {
  const body = "POST\n/v1/turns\n{}";
  const forged = { signature: signRequest(SECRET, Number.NaN, body), timestamp: Number.NaN, body };
  const r = verifySignature(SECRET, forged, Date.now(), W);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /invalid timestamp/);
});

test("verify: accepts a fresh signed request once, rejects the replay as a duplicate", async () => {
  const clock = 1_000_000_000_000;
  const auth = createSourceAuth({
    dedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    now: () => clock,
  });
  const req = signedReq(Math.floor(clock / 1000), "hello");
  assert.deepEqual(await auth.verify(req), { ok: true });
  const replay = await auth.verify(req);
  assert.equal(replay.ok, false);
  assert.match((replay as { reason: string }).reason, /duplicate/);
});

test("dedupe covers the FULL acceptance window: a future-stamped request can't be replayed late in its life", async () => {
  let clock = 1_000_000_000_000;
  const t0 = clock;
  const auth = createSourceAuth({
    dedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    now: () => clock,
  });

  const futureTs = Math.floor((t0 + W) / 1000);
  const req = signedReq(futureTs, "future-stamped");
  assert.deepEqual(await auth.verify(req), { ok: true });

  for (let i = 1; i <= 3; i++) {
    clock = t0 + Math.floor((i * W) / 2);
    assert.deepEqual(await auth.verify(signedReq(Math.floor(clock / 1000), `filler-${i}`)), { ok: true });
  }

  clock = t0 + Math.floor(1.9 * W);
  const replay = await auth.verify(req);
  assert.equal(replay.ok, false);
  assert.match((replay as { reason: string }).reason, /duplicate/);

  clock = futureTs * 1000 + W + 1000;
  const stale = await auth.verify(req);
  assert.equal(stale.ok, false);
  assert.match((stale as { reason: string }).reason, /stale/);
});

test("a replay at the exact staleness boundary (|now - ts| == window) is still a duplicate", async () => {
  let clock = 1_000_000_000_000;
  const auth = createSourceAuth({
    dedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    now: () => clock,
  });
  const ts = Math.floor(clock / 1000);
  const req = signedReq(ts, "boundary");
  assert.deepEqual(await auth.verify(req), { ok: true });

  clock = ts * 1000 + W;
  const replay = await auth.verify(req);
  assert.equal(replay.ok, false);
  assert.match((replay as { reason: string }).reason, /duplicate/);
});

test("a shared dedupe store closes the cross-instance replay window", async () => {
  const clock = 1_000_000_000_000;
  const now = () => clock;
  const shared = createPostgresReplayDedupe(testDatabaseUrl());
  const instanceA = createSourceAuth({ signingSecret: SECRET, now, dedupe: shared });
  const instanceB = createSourceAuth({ signingSecret: SECRET, now, dedupe: shared });

  const req = signedReq(Math.floor(clock / 1000), "cross-instance");
  assert.deepEqual(await instanceA.verify(req), { ok: true });
  const replay = await instanceB.verify(req);
  assert.equal(replay.ok, false);
  assert.match((replay as { reason: string }).reason, /duplicate/);
});

const GATE_SECRET = "test-signing-secret".repeat(3);

test("the normal server refuses to start without source-auth material", () => {
  const built = buildApp(testConfig());
  assert.throws(() => createServer(built.app), /CORE_SIGNING_SECRET must be at least 32 characters/);
});

function start(signingSecret?: string): { base: string; close: () => Promise<void> } {
  const built = buildApp(testConfig({}));
  const server = signingSecret
    ? createServer(built.app, { replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()), signingSecret })
    : createInsecureTestServer(built.app);
  const base = listenLocal(server);
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function sign(method: string, pathWithQuery: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(GATE_SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

const turnBody = (actorId: string) =>
  JSON.stringify({
    origin: { kind: "direct" },
    surface: "test",
    actor: { externalId: actorId },
    conversation: { kind: "dm", threadRef: `t-${actorId}` },
    text: "hello",
  });

test("with a signing secret, an UNSIGNED turn is rejected 401 (no impersonation)", async () => {
  const srv = start(GATE_SECRET);
  try {
    const res = await fetch(`${srv.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: turnBody("U-attacker"),
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("a FORGED actor whose body differs from what was signed is rejected", async () => {
  const srv = start(GATE_SECRET);
  try {
    const headers = sign("POST", "/v1/turns", turnBody("U-real"));
    const res = await fetch(`${srv.base}/v1/turns`, { method: "POST", headers, body: turnBody("U-ceo") });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("a non-numeric x-timestamp is rejected even when the signature matches the NaN canonical string", async () => {
  const srv = start(GATE_SECRET);
  try {
    const body = turnBody("U1");
    const headers = {
      "content-type": "application/json",
      "x-timestamp": "not-a-number",
      "x-signature": signRequest(GATE_SECRET, Number.NaN, `POST\n/v1/turns\n${body}`),
    };
    const res = await fetch(`${srv.base}/v1/turns`, { method: "POST", headers, body });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("a correctly-signed turn is accepted", async () => {
  const srv = start(GATE_SECRET);
  try {
    const body = turnBody("U1");
    const res = await fetch(`${srv.base}/v1/turns`, { method: "POST", headers: sign("POST", "/v1/turns", body), body });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "ok");
  } finally {
    await srv.close();
  }
});

test("a signature for one route can't be replayed against another (method+path bound)", async () => {
  const srv = start(GATE_SECRET);
  try {
    const headers = sign("GET", "/v1/surface-context/pending?source=slack", "");
    const res = await fetch(`${srv.base}/v1/sessions?principalId=U-victim`, { headers });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("a replayed signature is rejected (dedup) on a mutating route", async () => {
  const srv = start(GATE_SECRET);
  try {
    const body = turnBody("U1");
    const headers = sign("POST", "/v1/turns", body);
    const first = await fetch(`${srv.base}/v1/turns`, { method: "POST", headers, body });
    assert.equal(first.status, 200);
    const replay = await fetch(`${srv.base}/v1/turns`, { method: "POST", headers, body });
    assert.equal(replay.status, 401);
  } finally {
    await srv.close();
  }
});

test("an identical signed GET re-sent in the same second is accepted (reads are not replay-deduped)", async () => {
  const srv = start(GATE_SECRET);
  try {
    const headers = sign("GET", "/v1/surface-context/pending?source=slack", "");
    const first = await fetch(`${srv.base}/v1/surface-context/pending?source=slack`, { headers });
    assert.equal(first.status, 200);
    const second = await fetch(`${srv.base}/v1/surface-context/pending?source=slack`, { headers });
    assert.equal(second.status, 200);
  } finally {
    await srv.close();
  }
});

test("deployment ingress /d/:id is rejected 401 without a valid signature", async () => {
  const srv = start(GATE_SECRET);
  try {
    const res = await fetch(`${srv.base}/d/some-id/`, { headers: { "x-as-principal": "U-attacker" } });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("the explicit insecure test server leaves the boundary open", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: turnBody("U1"),
    });
    assert.equal(res.status, 200);
  } finally {
    await srv.close();
  }
});

test("POST /v1/blobs requires x-content-sha256 when authed, then binds the body (spec §13)", async () => {
  const built = buildApp(testConfig());
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: GATE_SECRET,
    blobTransfer: built.blobTransfer,
  });
  const base = listenLocal(server);
  try {
    const body = Buffer.from("payload bytes");
    const sha = createHash("sha256").update(body).digest("hex");
    const tsA = Math.floor(Date.now() / 1000);
    const noSha = await fetch(`${base}/v1/blobs`, {
      method: "POST",
      headers: { "x-timestamp": String(tsA), "x-signature": signRequest(GATE_SECRET, tsA, "POST\n/v1/blobs\n") },
      body,
    });
    assert.equal(noSha.status, 400);
    const tsB = Math.floor(Date.now() / 1000);
    const ok = await fetch(`${base}/v1/blobs`, {
      method: "POST",
      headers: {
        "x-content-sha256": sha,
        "x-timestamp": String(tsB),
        "x-signature": signRequest(GATE_SECRET, tsB, `POST\n/v1/blobs\n${sha}`),
      },
      body,
    });
    assert.equal(ok.status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("egress-audit ingest requires source auth: unsigned is 401, signed lands — including under portal-identity enforcement", async () => {
  const built = buildApp(testConfig());
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: GATE_SECRET,
    egressAudit: built.egressAudit,
    requireSignedPortalIdentity: true,
    capabilitySecret: `${GATE_SECRET}-cap`,
    portalIdentitySecret: `${GATE_SECRET}-portal`,
  });
  server.listen(0);
  const srv = {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  try {
    const body = JSON.stringify({ records: [{ host: "api.github.com", verdict: "ok", scopeLabel: "personal:U1" }] });
    const unsigned = await fetch(`${srv.base}/v1/egress-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(unsigned.status, 401);
    const signed = await fetch(`${srv.base}/v1/egress-audit`, {
      method: "POST",
      headers: sign("POST", "/v1/egress-audit", body),
      body,
    });
    assert.equal(signed.status, 200);
    assert.deepEqual(await signed.json(), { accepted: 1, rejected: 0 });
  } finally {
    await srv.close();
  }
});
