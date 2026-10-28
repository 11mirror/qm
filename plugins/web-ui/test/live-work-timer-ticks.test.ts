import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

const CLIENT_BOOT = 1_700_000_000_000;

async function flush(t: TestContext, settled: () => boolean = () => false, rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    t.mock.timers.tick(0);
    await new Promise((resolve) => setImmediate(resolve));
    if (settled()) return;
  }
}

async function timerChanges(t: TestContext, serverLeadMs: number): Promise<Array<{ at: number; text: string }>> {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: CLIENT_BOOT });
  const serverNow = () => Date.now() + serverLeadMs;
  const startedAt = serverNow() - 500;
  const run = () => ({ status: "running", alive: true, startedAt, attempt: 1, activity: [], result: null });
  const stamped = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", date: new Date(serverNow()).toUTCString() },
    });
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION],
    entries: [{ seq: 1, type: "user", createdAt: startedAt - 1000, payload: { text: "think about it" } }],
    api: (path) => {
      if (path.includes("/api/runs/active")) return stamped({ runId: "r1", run: run(), queued: [] });
      if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
      if (path === "/api/runs/r1") return stamped(run());
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const head = () => document.querySelector<HTMLElement>("details.work-prestep > summary.work-head");
    await flush(t, () => /Thinking/.test(head()?.textContent ?? ""), 2000);
    assert.match(head()?.textContent ?? "", /Thinking/);
    const elapsed = () => head()?.querySelector(".work-elapsed")?.textContent?.trim() ?? "";
    const changes: Array<{ at: number; text: string }> = [];
    let shown = elapsed();
    changes.push({ at: 0, text: shown });
    for (let step = 1; step <= 42; step++) {
      t.mock.timers.tick(100);
      await flush(t);
      const text = elapsed();
      if (text !== shown) {
        shown = text;
        changes.push({ at: step * 100, text });
      }
    }
    return changes;
  } finally {
    await h.close();
    t.mock.timers.reset();
  }
}

test("the live Thinking timer advances once per second from the turn's start", async (t) => {
  const changes = await timerChanges(t, 0);
  assert.deepEqual(changes, [
    { at: 0, text: "" },
    { at: 600, text: "1s" },
    { at: 1600, text: "2s" },
    { at: 2600, text: "3s" },
    { at: 3600, text: "4s" },
  ]);
});

test("the live timer counts from the server's start even when the browser clock is far off", async (t) => {
  const changes = await timerChanges(t, 30_000);
  assert.deepEqual(
    changes.map((c) => c.text),
    ["", "1s", "2s", "3s", "4s"],
  );
  for (let i = 2; i < changes.length; i++) assert.equal(changes[i]!.at - changes[i - 1]!.at, 1000);
});
