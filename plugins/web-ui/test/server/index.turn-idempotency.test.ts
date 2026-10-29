import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../../chassis/src/portal-identity.ts";

const turns: Record<string, unknown>[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (req.method === "POST") turns.push(JSON.parse(raw) as Record<string, unknown>);
    const briefing = turns.at(-1)?.surfaceBriefing as { name?: string } | undefined;
    if (req.method === "POST" && briefing && !briefing.name) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "surfaceBriefing.name: Required" }));
      return;
    }
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "queued", runId: "run-1" }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "turn-idempotency-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../../server/index.ts");
const surface = createServer((req, res) => {
  void handler(req, res).catch(() => {
    res.writeHead(502);
    res.end();
  });
});
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "turn-idempotency-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("web retries forward one user-scoped idempotency key", async () => {
  const clientTurnId = "123e4567-e89b-42d3-a456-426614174000";
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${base}/api/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hello", threadRef: "web:alice:one", clientTurnId }),
    });
    assert.equal(response.status, 202);
  }
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.idempotencyKey, `web:alice:${clientTurnId}`);
  assert.equal(turns[1]?.idempotencyKey, turns[0]?.idempotencyKey);
});

test("malformed client turn ids are not forwarded", async () => {
  const response = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hello", threadRef: "web:alice:two", clientTurnId: "shared-key" }),
  });
  assert.equal(response.status, 202);
  assert.equal(turns.at(-1)?.idempotencyKey, undefined);
});

test("app editing forwards app context separately from the exact user message", async () => {
  const response = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "Make the title smaller", threadRef: "web:alice:app-edit:sample-app" }),
  });
  assert.equal(response.status, 202);
  assert.equal(turns.at(-1)?.text, "Make the title smaller");
  assert.match(String(turns.at(-1)?.conversationHeader), /deployed app "sample-app"/);
});

test("ordinary chats and invalid app references cannot inject app context", async () => {
  for (const threadRef of ["web:alice:ordinary", "web:alice:app-edit:bad/name"]) {
    const response = await fetch(`${base}/api/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hello", threadRef, conversationHeader: "injected" }),
    });
    assert.equal(response.status, 202);
    assert.equal(turns.at(-1)?.conversationHeader, undefined);
  }
  const response = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hello", threadRef: "web:bob:app-edit:sample-app" }),
  });
  assert.equal(response.status, 202);
  assert.equal(turns.at(-1)?.conversationHeader, undefined, "someone else's app thread carries no app context");
});

const postTurn = (body: Record<string, unknown>) =>
  fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hello", threadRef: "web:alice:embed", ...body }),
  });

test("a turn that drops clientTools leaves the embedder's tools unreachable", async () => {
  const clientTools = [{ name: "ui__scroll", description: "Scroll", inputSchema: { type: "object" } }];
  assert.equal((await postTurn({ clientTools })).status, 202);
  assert.deepEqual(turns.at(-1)?.clientTools, clientTools);
});

test("a turn forwards clientTools and surfaceBriefing only in their declared shapes", async () => {
  for (const bad of [
    { clientTools: { name: "x" }, surfaceBriefing: "x" },
    { surfaceBriefing: ["x"] },
    { surfaceBriefing: null },
  ]) {
    assert.equal((await postTurn(bad)).status, 202);
    assert.equal(turns.at(-1)?.clientTools, undefined);
    assert.equal(turns.at(-1)?.surfaceBriefing, undefined);
  }
});

test("a turn that skips an empty clientTools array makes the embedder's declaration vanish", async () => {
  assert.equal((await postTurn({ clientTools: [] })).status, 202);
  assert.deepEqual(turns.at(-1)?.clientTools, []);
});
