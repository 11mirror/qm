import "../../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createInsecureTestServer, createServer } from "../../../src/api/server.ts";
import { buildApp } from "../../support/build-app.ts";
import { testConfig } from "../../support/test-config.ts";
import { mintCapabilityToken, BLOB_TRANSFER_AUD } from "../../../src/auth/capability-token.ts";
import { CAPABILITY_HEADER } from "../../../src/api/contract.ts";
import { scopeId } from "../../../src/types.ts";
import { createPostgresReplayDedupe } from "../../../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";

function start(): { base: string; close: () => Promise<void> } {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app, { blobTransfer: built.blobTransfer });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

test("POST /v1/blobs stages bytes and GET /v1/blobs/:id streams them back", async () => {
  const s = start();
  try {
    const body = Buffer.from("the quick brown fox".repeat(1000));
    const up = await fetch(`${s.base}/v1/blobs`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-content-sha256": sha(body) },
      body,
    });
    assert.equal(up.status, 200);
    const { blobId, sizeBytes } = (await up.json()) as { blobId: string; sizeBytes: number };
    assert.equal(sizeBytes, body.length);
    assert.ok(blobId);

    const down = await fetch(`${s.base}/v1/blobs/${blobId}`);
    assert.equal(down.status, 200);
    assert.equal(down.headers.get("content-length"), String(body.length));
    const got = Buffer.from(await down.arrayBuffer());
    assert.ok(got.equals(body));
  } finally {
    await s.close();
  }
});

test("POST /v1/blobs rejects a body that doesn't match x-content-sha256 (400)", async () => {
  const s = start();
  try {
    const body = Buffer.from("payload");
    const res = await fetch(`${s.base}/v1/blobs`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-content-sha256": "0".repeat(64) },
      body,
    });
    assert.equal(res.status, 400);
  } finally {
    await s.close();
  }
});

test("GET /v1/blobs/:id is 404 for an unknown id", async () => {
  const s = start();
  try {
    assert.equal((await fetch(`${s.base}/v1/blobs/ffffffffffffffffffffffffffffffff`)).status, 404);
  } finally {
    await s.close();
  }
});

const SECRET = "blob-auth-secret".repeat(3);

function startSigned(): { base: string; close: () => Promise<void> } {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    blobTransfer: built.blobTransfer,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const tok = (blob: { dir: "read" | "write"; id?: string }) =>
  mintCapabilityToken(
    {
      actorId: "fly-sandbox",
      scopeId: scopeId("personal", "fly-sandbox"),
      aud: BLOB_TRANSFER_AUD,
      blob,
      exp: Date.now() + 60_000,
    },
    SECRET,
  );

async function stageBlob(base: string): Promise<string> {
  const body = Buffer.from("blob channel payload".repeat(64));
  const res = await fetch(`${base}/v1/blobs`, {
    method: "POST",
    headers: { [CAPABILITY_HEADER]: await tok({ dir: "write" }), "content-type": "application/octet-stream" },
    body,
  });
  assert.equal(res.status, 200, "a write-transfer token stages a blob");
  return ((await res.json()) as { blobId: string }).blobId;
}

test("a read token pinned to a blob id can fetch exactly that blob", async () => {
  const s = startSigned();
  try {
    const id = await stageBlob(s.base);
    const res = await fetch(`${s.base}/v1/blobs/${id}`, {
      headers: { [CAPABILITY_HEADER]: await tok({ dir: "read", id }) },
    });
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).length > 0);
  } finally {
    await s.close();
  }
});

test("a read token for a DIFFERENT blob id cannot fetch this one (403)", async () => {
  const s = startSigned();
  try {
    const id = await stageBlob(s.base);
    const res = await fetch(`${s.base}/v1/blobs/${id}`, {
      headers: { [CAPABILITY_HEADER]: await tok({ dir: "read", id: "some-other-blob" }) },
    });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("a read token cannot be used to WRITE (wrong direction, 403)", async () => {
  const s = startSigned();
  try {
    const res = await fetch(`${s.base}/v1/blobs`, {
      method: "POST",
      headers: { [CAPABILITY_HEADER]: await tok({ dir: "read", id: "x" }), "content-type": "application/octet-stream" },
      body: Buffer.from("nope"),
    });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("no auth at all (with a signing secret set) is rejected", async () => {
  const s = startSigned();
  try {
    const id = await stageBlob(s.base);
    const res = await fetch(`${s.base}/v1/blobs/${id}`);
    assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
  } finally {
    await s.close();
  }
});
