import assert from "node:assert/strict";
import test from "node:test";
import { mountAdmin } from "./fixture.ts";

async function transcript(data: Record<string, unknown>) {
  const admin = await mountAdmin("/settings/history/s/sess-1", {
    "/scopes": { scopes: [], environments: [] },
    "/sessions/sess-1/llm": { requests: [] },
    "/sessions/sess-1": data,
  });
  await admin.settle(10);
  return admin;
}

const item = (seq: number, kind: string, extra: Record<string, unknown> = {}) => ({
  sessionId: "sess-1",
  seq,
  kind,
  createdAt: seq,
  turnId: null,
  author: null,
  callId: null,
  text: null,
  tool: null,
  variant: null,
  isError: null,
  body: {},
  ...extra,
});

test("admin transcript renders core items with the real controller helpers", async () => {
  const admin = await transcript({
    session: { scopeId: "org:acme" },
    items: [
      item(1, "UserMessage", { text: "hello", author: "u1", body: { name: "Ada" } }),
      item(2, "ToolCall", { callId: "c", tool: "execute", body: { command: "ls -la" } }),
      item(3, "ToolResult", { callId: "c", tool: "execute", text: "total 0", body: { code: 0 } }),
      item(4, "AgentMessage", { text: "all done" }),
    ],
  });
  const doc = admin.document;
  assert.equal(doc.querySelector("#view-data .empty"), null);
  assert.equal(doc.querySelector(".user-entry .entry-label")!.textContent!.trim(), "Ada");
  assert.match(doc.querySelector(".user-entry")!.textContent!, /hello/);
  assert.match(doc.querySelector(".assistant-entry")!.textContent!, /all done/);
  const tool = doc.querySelector(".tool-line-entry")!;
  assert.equal(tool.querySelector(".tool-label")!.textContent, "execute");
  assert.equal(tool.querySelector(".tool-line-preview")!.textContent, "ls -la");
  assert.match(tool.querySelector(".meta-row")!.textContent!, /exit 0/);
  admin.close();
});

test("transcript filters hide thinking and tool items but keep messages", async () => {
  const admin = await transcript({
    session: { scopeId: "org:acme" },
    items: [
      item(1, "UserMessage", { text: "hello" }),
      item(2, "Reasoning", { text: "private thought" }),
      item(3, "ToolCall", { callId: "plain", tool: "read" }),
      item(4, "ToolResult", { callId: "plain", tool: "read" }),
      item(5, "AgentMessage", { text: "reply" }),
    ],
  });
  const doc = admin.document;
  const hidden = (selector: string) =>
    [...doc.querySelectorAll(`#view-data ${selector}`)].map((entry) => entry.classList.contains("filtered"));
  assert.deepEqual(hidden(".thinking-entry"), [false]);
  doc.querySelector<HTMLInputElement>('[aria-label="Show thinking"]')!.click();
  assert.deepEqual(hidden(".thinking-entry"), [true]);
  assert.deepEqual(hidden(".tool-entry"), [false, false]);
  doc.querySelector<HTMLInputElement>('[aria-label="Show tool results"]')!.click();
  assert.deepEqual(hidden(".tool-entry"), [true, true]);
  assert.deepEqual(hidden(".user-entry, .assistant-entry"), [false, false]);
  doc.querySelector<HTMLInputElement>('[aria-label="Show thinking"]')!.click();
  assert.deepEqual(hidden(".thinking-entry"), [false]);
  admin.close();
});
