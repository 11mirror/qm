import { test } from "node:test";
import assert from "node:assert/strict";
import { seedRawMessagesIntoSession } from "../../src/harness/pi-turn-session.ts";
import { reconstructMessagesFromHistory } from "../../src/harness/replay.ts";
import { storedItem, type NewItem } from "../../src/sessions/items.ts";

test("seedRawMessagesIntoSession pushes the reconstructed tool round (incl. toolResult) onto the live array + persists", () => {
  const liveMessages: unknown[] = [];
  const persisted: unknown[] = [];
  const stubSession = {
    agent: { state: { messages: liveMessages } },
    sessionManager: { appendMessage: (m: unknown) => persisted.push(m) },
  };
  const at = (item: NewItem, seq: number) => storedItem(item, { sessionId: "s", seq, createdAt: seq });
  const history = [
    at({ kind: "UserMessage", text: "sign up" }, 1),
    at({ kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "browse" } }, 2),
    at({ kind: "ToolResult", tool: "execute", callId: "c1", text: "user: a / pass: b", isError: false }, 3),
    at({ kind: "AgentMessage", text: "done" }, 4),
  ];
  seedRawMessagesIntoSession(stubSession, reconstructMessagesFromHistory(history));

  assert.deepEqual(
    (liveMessages as Array<{ role: string }>).map((m) => m.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  assert.deepEqual(persisted, liveMessages);
  const toolResult = liveMessages[2] as { role: string; toolCallId: string; content: Array<{ text: string }> };
  assert.equal(toolResult.toolCallId, "c1");
  assert.match(toolResult.content[0]!.text, /pass: b/);
});

test("seedRawMessagesIntoSession is a no-op for empty input and degrades gracefully without Pi internals", () => {
  seedRawMessagesIntoSession({ agent: { state: { messages: [] } } }, []);
  assert.doesNotThrow(() => seedRawMessagesIntoSession({}, reconstructMessagesFromHistory([])));
});
