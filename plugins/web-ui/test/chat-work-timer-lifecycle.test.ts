import assert from "node:assert/strict";
import test from "node:test";
import { itemsToMessages, type AssistantWork } from "../src/transcript-messages.ts";
import { item } from "./support/item-fixture.ts";
import { harness, SESSION } from "./support/deep-link-boot-fixture.ts";

test("replacing and disposing a chat disconnects its live work timer", async () => {
  const h = await harness({ path: "/", openNewChat: true });
  try {
    h.releaseSessions();
    await h.boot();
    const chat = h.visibleConversation();
    for (const release of [
      () => chat.newChat(),
      () => chat.mountReadOnly({ ...SESSION, type: "dm", createdAt: 1000, canContinue: false }, []),
      () => chat.dispose(),
    ]) {
      chat.newChat();
      const agent = chat.state.agent!;
      const startedAt = Date.now() - 1230;
      const message = itemsToMessages([
        item("AgentMessage", { seq: 1, text: "QA", createdAt: startedAt }),
      ])[0] as AssistantWork;
      message.content = [];
      message.work = {
        status: "working",
        startedAt,
        activity: [
          {
            item: item("ToolCall", {
              seq: 2,
              tool: "execute",
              callId: "c1",
              body: { command: "printf start" },
              createdAt: startedAt,
            }),
          },
          {
            item: item("ToolCall", {
              seq: 3,
              tool: "execute",
              callId: "c2",
              body: { command: "sleep 10" },
              createdAt: startedAt,
            }),
          },
        ],
      };
      Object.assign(agent.state, { messages: [], streamingMessage: message, isStreaming: true });
      chat.drawActiveChat();
      const oldHost = chat.state.host!;
      assert.match(oldHost.textContent ?? "", /1\.\d{2}s/);
      release();
      assert.equal(oldHost.textContent, "");
    }
  } finally {
    await h.close();
  }
});
