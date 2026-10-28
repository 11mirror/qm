import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";
import { createReplyHold, replyCheckPrompt } from "../src/harness/reply-hold.ts";
import { REPLY_CHECK_RETRIES } from "../src/decisions/hooks.ts";

type Sink = { entries: Array<{ seq: number; type: string; payload: Record<string, unknown> }> };

function turnInput(sessionId: string, sink: Sink, overrides: Partial<HarnessTurnInput> = {}): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    input: "status?",
    systemPrompt: "BASE",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry: NewEntry) => {
      const appended = { ...entry, seq: seq++, createdAt: Date.now() };
      sink.entries.push({ seq: appended.seq, type: entry.type, payload: entry.payload as Record<string, unknown> });
      return appended as unknown as SessionEntry;
    },
    recordModelCall: () => {},
    ...overrides,
  };
}

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textReplyEvents(text: string, thinking?: string): Array<Record<string, unknown>> {
  const at = thinking ? 1 : 0;
  return [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-test",
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    ...(thinking
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
          { type: "content_block_stop", index: 0 },
        ]
      : []),
    { type: "content_block_start", index: at, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: at, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: at },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

function fakeModel(replies: string[], thinking?: string) {
  const requests: Array<Array<{ role: string; content: unknown }>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push((JSON.parse(String(init?.body ?? "{}")) as { messages?: [] }).messages ?? []);
    return sse(textReplyEvents(replies[Math.min(requests.length, replies.length) - 1]!, thinking));
  }) as typeof globalThis.fetch;
  return { requests, restore: () => (globalThis.fetch = realFetch) };
}

const userText = (message: { content: unknown }) =>
  (message.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");

test("a held reply that fails the check is rewritten before anything streams or persists", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["Here \u2014 a draft.", "Here is a clean reply."], "let me think");
  const streamed: string[] = [];
  const checked: string[] = [];
  try {
    const result = await harness.turns.runTurn(
      turnInput("reply-check", sink, {
        onDelta: (chunk) => streamed.push(chunk),
        checkReply: async (draft) => {
          checked.push(draft);
          return draft.includes("\u2014") ? "The draft uses an em dash, which the guidance forbids." : undefined;
        },
      }),
    );
    assert.equal(result.reply, "Here is a clean reply.");
    assert.deepEqual(checked, ["Here \u2014 a draft.", "Here is a clean reply."]);
    assert.deepEqual(streamed, ["Here is a clean reply."]);
    assert.deepEqual(
      sink.entries.map((e) => e.type),
      ["user", "thinking", "assistant"],
    );
    assert.equal(sink.entries.at(-1)!.payload.text, "Here is a clean reply.");
    assert.ok(!JSON.stringify(sink.entries).includes("a draft"));
    assert.ok(!JSON.stringify(sink.entries).includes("held back"));
    assert.equal(model.requests.length, 2);
    const second = model.requests[1]!;
    assert.deepEqual(
      second.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    assert.equal(userText(second[2]!), replyCheckPrompt("The draft uses an em dash, which the guidance forbids."));
    assert.ok(JSON.stringify(second[1]!.content).includes("a draft"));
  } finally {
    model.restore();
  }
});

test("a passing reply streams once the check clears, and no check means no hold", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  for (const withCheck of [true, false]) {
    const sink: Sink = { entries: [] };
    const model = fakeModel(["All quiet."]);
    const order: string[] = [];
    try {
      const result = await harness.turns.runTurn(
        turnInput(`reply-pass-${withCheck}`, sink, {
          onDelta: (chunk) => order.push(`delta:${chunk}`),
          ...(withCheck
            ? {
                checkReply: async (draft) => {
                  order.push(`check:${draft}`);
                  return undefined;
                },
              }
            : {}),
        }),
      );
      assert.equal(result.reply, "All quiet.");
      assert.deepEqual(order, withCheck ? ["check:All quiet.", "delta:All quiet."] : ["delta:All quiet."]);
      assert.equal(model.requests.length, 1);
    } finally {
      model.restore();
    }
  }
});

test("rewrites are capped; the last draft ships even if the check still objects", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["bad 1", "bad 2", "bad 3", "bad 4"]);
  const streamed: string[] = [];
  let checks = 0;
  try {
    const result = await harness.turns.runTurn(
      turnInput("reply-cap", sink, {
        onDelta: (chunk) => streamed.push(chunk),
        checkReply: async () => (checks++, "Still wrong."),
      }),
    );
    assert.equal(model.requests.length, 1 + REPLY_CHECK_RETRIES);
    assert.equal(checks, 1 + REPLY_CHECK_RETRIES);
    assert.equal(result.reply, `bad ${1 + REPLY_CHECK_RETRIES}`);
    assert.deepEqual(streamed, [result.reply]);
    assert.deepEqual(
      sink.entries.filter((e) => e.type === "assistant").map((e) => e.payload.text),
      [result.reply],
    );
  } finally {
    model.restore();
  }
});

test("a failing check never blocks the reply", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["Fine."]);
  const streamed: string[] = [];
  try {
    const result = await harness.turns.runTurn(
      turnInput("reply-check-error", sink, {
        onDelta: (chunk) => streamed.push(chunk),
        checkReply: async () => {
          throw new Error("classifier down");
        },
      }),
    );
    assert.equal(result.reply, "Fine.");
    assert.deepEqual(streamed, ["Fine."]);
    assert.equal(model.requests.length, 1);
  } finally {
    model.restore();
  }
});

test("the hold replays block starts and deltas in order, and a drop forgets them", () => {
  const seen: string[] = [];
  const hold = createReplyHold({
    onDelta: (chunk) => seen.push(chunk),
    onTextBlockStart: () => void seen.push("<block>"),
  });
  hold.blockStart();
  hold.delta("a");
  hold.delta("b");
  assert.deepEqual(seen, []);
  hold.release();
  assert.deepEqual(seen, ["<block>", "a", "b"]);
  hold.blockStart();
  hold.delta("c");
  hold.drop();
  hold.release();
  assert.deepEqual(seen, ["<block>", "a", "b"]);
});
