import assert from "node:assert/strict";
import { test } from "node:test";
import { appState } from "../src/shell-state.ts";
import { uiCanvasPanel, fitSnapshot } from "../src/ui-canvas.ts";

test("redraws during an in-flight canvas fetch do not restart it", async () => {
  let fetches = 0;
  const releases: Array<() => void> = [];
  const release = () => releases.splice(0).forEach((r) => r());
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches++;
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response(JSON.stringify({ canvas: null }), { status: 200 });
  }) as typeof fetch;
  appState.me = { email: "a@example.com" } as unknown as typeof appState.me;
  let redraws = 0;
  const owner = { chat: { state: { sessionId: "s-livelock" }, redraw: () => redraws++ } } as unknown as Parameters<
    typeof uiCanvasPanel
  >[0];
  try {
    for (let i = 0; i < 5; i++) uiCanvasPanel(owner);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    for (let i = 0; i < 20 && redraws < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fetches, 2, "one fetch each for the session and always-on canvas");
    assert.ok(redraws >= 1);
  } finally {
    globalThis.fetch = original;
    appState.me = null;
  }
});

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

test("snapshots fit the byte budget by trimming html first, then css, sessions and the screenshot", () => {
  const snapshot = { url: "u", html: "é".repeat(5_000), css: "c".repeat(2_000), sessions: [{ id: "a" }] };
  const small = fitSnapshot(snapshot, 100_000);
  assert.deepEqual(small, snapshot, "untouched when it fits");
  const fitted = fitSnapshot(snapshot, 6_000);
  assert.ok(bytes(fitted) <= 6_000);
  assert.deepEqual(fitted.truncated, ["html"]);
  assert.equal(fitted.css, snapshot.css);
  const tiny = fitSnapshot({ ...snapshot, screenshot: { dataUrl: "x".repeat(3_000) } }, 200);
  assert.ok(bytes(tiny) <= 200);
  assert.deepEqual(tiny.truncated, ["html", "css", "sessions", "screenshot"]);
});
