import { item } from "./support/item-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { WorkBlock } from "../src/core-bridge.ts";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement", "Document", "CSSStyleSheet", "customElements"] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, {
  requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(Date.now()), 50),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
const { html, render, nothing } = await import("lit");
const { liveWorkDuration } = await import("../src/live-work-duration.ts");

test("the live label advances between chat renders and stops when disconnected", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 157_230 });
  const work: WorkBlock = { status: "working", startedAt: 100_000, activity: [] };
  const host = document.createElement("div");
  const part = render(html`${liveWorkDuration(work)}`, host);
  assert.equal(host.textContent, "57.23s");
  t.mock.timers.tick(50);
  assert.equal(host.textContent, "57.28s");
  part.setConnected(false);
  t.mock.timers.tick(500);
  assert.equal(host.textContent, "57.28s");
  part.setConnected(true);
  assert.equal(host.textContent, "57.78s");
  t.mock.timers.tick(50);
  assert.equal(host.textContent, "57.83s");
  render(nothing, host);
  t.mock.timers.tick(100);
  assert.equal(host.textContent, "");
});

test("approval waits keep their recorded duration", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 157_230 });
  const work: WorkBlock = {
    status: "working",
    startedAt: 100_000,
    activity: [
      { item: item("ToolCall", { seq: 1, createdAt: 101_000, callId: "c", body: { command: "help" } }) },
      { item: item("ToolResult", { seq: 2, createdAt: 108_120, callId: "c", body: { blocked: "needs_approval" } }) },
    ],
  };
  const host = document.createElement("div");
  render(html`${liveWorkDuration(work)}`, host);
  assert.equal(host.textContent, "8.12s");
  t.mock.timers.tick(1000);
  assert.equal(host.textContent, "8.12s");
  render(nothing, host);
});
