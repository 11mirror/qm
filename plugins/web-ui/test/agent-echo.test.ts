import assert from "node:assert/strict";
import test from "node:test";
import { item } from "./support/item-fixture.ts";
import { itemsToMessages, userItemMessage, forkCutSeq, type AssistantWork } from "../src/transcript-messages.ts";
import { activityItems } from "../src/items.ts";

test("agent Slack echoes never become user bubbles or fork boundaries", () => {
  const echo = item("UserMessage", {
    seq: 3,
    text: "reply",
    body: { overheard: true, sourceRole: "agent", name: "Alice" },
  });
  const items = [
    item("UserMessage", { seq: 1, text: "question" }),
    item("AgentMessage", { seq: 2, text: "reply" }),
    echo,
    item("UserMessage", { seq: 4, text: "nice", body: { overheard: true, name: "Bob" } }),
  ];
  const messages = itemsToMessages(items);
  assert.equal(userItemMessage(echo), null);
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  assert.equal(messages.filter((m) => JSON.stringify(m).includes('"reply"')).length, 1);
  assert.equal(forkCutSeq(items, messages, 2), 4);
});

test("agent Slack revisions name the agent rather than a person", () => {
  const messages = itemsToMessages([
    item("Retraction", {
      seq: 3,
      body: {
        kind: "message_revision",
        action: "edited",
        ts: "2.0",
        text: "fixed",
        name: "Alice",
        sourceRole: "agent",
      },
    }),
  ]);
  assert.equal((messages[0] as { byAgent?: boolean }).byAgent, true);
  assert.equal((messages[0] as { speaker?: string }).speaker, undefined);
});

test("an agent echo closes preceding unfinished work", () => {
  const messages = itemsToMessages([
    item("UserMessage", { seq: 1, text: "start" }),
    item("ToolCall", { seq: 2, tool: "execute", callId: "a" }),
    item("UserMessage", { seq: 3, text: "echo", body: { overheard: true, sourceRole: "agent" } }),
    item("UserMessage", { seq: 4, text: "wake", hidden: true }),
    item("ToolCall", { seq: 5, tool: "execute", callId: "b" }),
    item("AgentMessage", { seq: 6, text: "done" }),
  ]);
  assert.deepEqual(
    messages.map((m) => [
      m.role,
      (m as AssistantWork).work ? activityItems((m as AssistantWork).work!.activity).map((i) => i.seq) : undefined,
    ]),
    [
      ["user", undefined],
      ["assistant", [2]],
      ["assistant", [5]],
    ],
  );
});
