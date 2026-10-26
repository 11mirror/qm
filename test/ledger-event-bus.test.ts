import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createPostgresLedgerEventBus, type OwnedLedgerEvent } from "../src/inbox/events.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

function event(over: Partial<OwnedLedgerEvent> = {}): OwnedLedgerEvent {
  return { cronId: "cron-1", itemId: "item-1", op: "ingest", at: 111, owner: "josh", ...over };
}

test("ledger events cross bus instances and an unsubscribed listener hears nothing more", async () => {
  const url = testDatabaseUrl();
  const a = createPostgresLedgerEventBus(url);
  const b = createPostgresLedgerEventBus(url);
  try {
    const got: OwnedLedgerEvent[] = [];
    let off = (): void => {};
    const ready = new Promise<void>((resolve) => {
      off = b.subscribe((e) => {
        if (e.cronId === "cron-xbus") {
          got.push(e);
          resolve();
        }
      });
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      a.emit(event({ cronId: "cron-xbus", itemId: "item-9", op: "action", at: 42, owner: "ada" }));
      const landed = await Promise.race([
        ready.then(() => true),
        new Promise((r) => setTimeout(r, 250)).then(() => false),
      ]);
      if (landed) break;
      if (Date.now() > deadline) assert.fail("event never crossed instances");
    }
    assert.equal(got[0]?.itemId, "item-9");
    assert.equal(got[0]?.op, "action");
    assert.equal(got[0]?.owner, "ada");
    assert.equal(got[0]?.at, 42);
    off();
    await new Promise((r) => setTimeout(r, 300));
    const heard = got.length;
    a.emit(event({ cronId: "cron-xbus", op: "reopen" }));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(got.length, heard, "an unsubscribed listener hears nothing");
  } finally {
    await a.close?.();
    await b.close?.();
  }
});

test("GET /v1/cron-items/events streams inbox writes as SSE frames, stamped with the cron owner", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-ledger-sse-"));
  const built = buildApp(testConfig({ dataDir, orgId: "acme" }));
  built.runtime.start();
  const core = createInsecureTestServer(built.app, { webhookReceiver: built.webhookReceiver });
  core.listen(0);
  const base = `http://localhost:${(core.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/v1/cron-items/events`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const cron = await built.app.createCron({
      owner: "josh",
      createdBy: "josh",
      ownerScopeId: "personal:josh",
      schedule: { everyMs: 3_600_000 },
      action: "triage",
      inbox: {},
    });
    await built.inbox.items.ingest([{ cronId: cron.id, dedupeKey: "SENTRY-1", sourcePayload: { issue: "SENTRY-1" } }]);

    const reader = res.body!.getReader();
    let buf = "";
    let frame: OwnedLedgerEvent | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !frame) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      for (const chunk of buf.split("\n\n")) {
        if (!chunk.split("\n").includes("event: inbox_item")) continue;
        const data = chunk
          .split("\n")
          .find((l) => l.startsWith("data: "))
          ?.slice("data: ".length);
        if (data) frame = JSON.parse(data) as OwnedLedgerEvent;
      }
    }
    await reader.cancel().catch(() => {});
    assert.ok(frame, "a ledger write reached the SSE stream");
    assert.equal(frame!.cronId, cron.id);
    assert.equal(frame!.op, "ingest");
    assert.equal(frame!.owner, "josh", "the frame carries the cron owner the BFF routes by");
  } finally {
    await new Promise<void>((r) => core.close(() => r()));
    await built.runtime.stop();
  }
});
