import { type Item, activityItems } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import { buildTimeline, messageWorkTimeline } from "../src/timeline.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  appendConsumedSteers,
  forkCutSeq,
  messagesWithStreaming,
  itemsToMessages,
  type AssistantWork,
  continuableMessages,
  resumeAnchor,
} from "../src/transcript-messages.ts";
import { MODEL } from "./support/transcript-fixture.ts";
import { workSeconds } from "../src/work-duration.ts";
import { runIsTerminal } from "../src/run-stream.ts";

for (const text of ["Partial answer", "", "(stopped)"]) {
  test(`stopped history retains its state without promoting commentary: ${text || "empty"}`, () => {
    const items: Item[] = [
      item("UserMessage", { seq: 1, createdAt: 1, text: "check" }),
      item("AgentMessage", {
        seq: 2,
        createdAt: 2,
        variant: "narration",
        text: "Checking.",
        body: { phase: "commentary" },
      }),
      item("AgentMessage", { seq: 3, createdAt: 3, text: text, body: { stopped: true } }),
    ];
    const messages = itemsToMessages(items);
    const answer = messages.find((message) => message.role === "assistant") as AssistantWork;
    assert.equal(answer.stopReason, "aborted");
    assert.deepEqual(answer.content, [{ type: "text", text }]);
    assert.equal(answer.work?.activity.length, 1);
    assert.equal(messageWorkTimeline(answer.work!, text)[0]?.kind, "text");
  });
}

test("live approval decisions are outside tool folds and reconcile by request identity", () => {
  const entry = item("ElicitationResponse", {
    seq: 8,
    createdAt: 100,
    elicitId: "approval-1",
    approved: true,
    body: { command: "help", scope: "once" },
  });
  const streaming = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    work: { status: "working", activity: [{ item: entry }] },
  } as unknown as AgentMessage;
  const live = messagesWithStreaming([], streaming);
  assert.equal(live.length, 2);
  assert.equal((live[0] as { role: string }).role, "approval-decision");
  assert.equal(live[1], streaming);
  assert.deepEqual(messagesWithStreaming([streaming]), live);
  assert.deepEqual(buildTimeline((streaming as AssistantWork).work!), []);
  const history = itemsToMessages([entry]);
  assert.deepEqual(messagesWithStreaming(history, streaming), [...history, streaming]);
  const repeated = {
    ...streaming,
    work: { status: "working", activity: [{ item: { ...entry, seq: 9, createdAt: 200 } }] },
  } as unknown as AgentMessage;
  assert.equal(messagesWithStreaming(history, repeated).length, 3);
  const denied = { ...entry, elicitId: "approval-2", approved: false };
  const denialStream = {
    ...streaming,
    work: { status: "complete", activity: [{ item: denied }] },
  } as unknown as AgentMessage;
  assert.equal(messagesWithStreaming(history, denialStream).length, 3);
});

test("a recorded decision clears stale approval labels without consuming a later request", () => {
  const pending = { requestId: "same-command", command: "help" };
  const blocked = (createdAt: number) =>
    ({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      timestamp: createdAt,
      work: {
        status: "complete",
        pendingApprovals: [pending],
        activity: [{ item: item("ToolResult", { seq: 1, createdAt, body: { blocked: "needs_approval" } }) }],
      },
    }) as unknown as AgentMessage;
  const decision = item("ElicitationResponse", {
    seq: 2,
    createdAt: 200,
    elicitId: pending.requestId,
    approved: false,
    body: { command: pending.command },
  });
  const old = blocked(100);
  const fresh = blocked(300);
  const streaming = {
    role: "assistant",
    content: [],
    work: { status: "working", activity: [{ item: decision }] },
  } as unknown as AgentMessage;
  const visible = messagesWithStreaming([old, fresh], streaming);
  assert.deepEqual((visible[0] as AssistantWork).work?.pendingApprovals, []);
  assert.equal(visible[1], fresh);
  assert.deepEqual((old as AssistantWork).work?.pendingApprovals, [pending]);
  const history = messagesWithStreaming([old, ...itemsToMessages([decision]), fresh]);
  assert.deepEqual((history[0] as AssistantWork).work?.pendingApprovals, []);
  assert.equal(history.at(-1), fresh);
});

test("finish_silently retains explicit posts and audit without a phantom closing reply", () => {
  const items: Item[] = [
    item("UserMessage", { seq: 1, createdAt: 100, text: "post the answer" }),
    item("ToolCall", {
      seq: 2,
      createdAt: 110,
      tool: "slack",
      callId: "post1",
      body: { action: "post", text: "The answer." },
    }),
    item("ToolResult", { seq: 3, createdAt: 120, tool: "slack", callId: "post1", body: { action: "post", ok: true } }),
    item("AgentMessage", { seq: 4, createdAt: 130, variant: "narration", text: "Nothing to add." }),
    item("ToolCall", { seq: 5, createdAt: 140, tool: "finish_silently", body: { reason: "already posted" } }),
    item("ToolResult", { seq: 6, createdAt: 150, tool: "finish_silently", body: { silent: true } }),
    item("AgentMessage", { seq: 7, createdAt: 160, text: "" }),
  ];
  const replies = itemsToMessages(items, MODEL).filter((m) => m.role === "assistant") as AssistantWork[];
  assert.deepEqual(replies.map((m) => (m.content[0] as { text: string }).text).filter(Boolean), ["The answer."]);
  assert.ok(replies.some((m) => activityItems(m.work?.activity ?? []).some((a) => a.tool === "finish_silently")));
});

test("steering retains intake identity, authors and attachments after history reload", () => {
  const messages = itemsToMessages([
    item("UserMessage", { seq: 1, createdAt: 1, text: "start" }),
    item("ToolCall", { seq: 2, createdAt: 2, tool: "read", callId: "a" }),
    item("ToolResult", { seq: 3, createdAt: 3, tool: "read", callId: "a" }),
    item("SteeringMessage", {
      seq: 4,
      createdAt: 4,
      text: "Use this instead",
      body: {
        name: "Alex",
        ts: "input-1",
        attachments: [{ name: "sample.png", mimetype: "image/png", artifactId: "image-1" }],
      },
    }),
    item("ToolCall", { seq: 5, createdAt: 5, tool: "read", callId: "b" }),
    item("ToolResult", { seq: 6, createdAt: 6, tool: "read", callId: "b" }),
    item("AgentMessage", { seq: 7, createdAt: 7, text: "Done" }),
  ]);
  const work = (messages.at(-1) as AssistantWork).work!;
  const timeline = messageWorkTimeline(work, "Done");
  assert.deepEqual(
    timeline.map((item) => item.kind),
    ["tool", "steer", "tool"],
  );
  assert.equal(timeline[1]?.kind === "steer" && timeline[1].item.seq, 4);
  const steer = messages[1] as unknown as {
    entrySeq: number;
    speaker: string;
    attachments: Array<{ artifactId: string }>;
  };
  assert.equal(steer.entrySeq, 4);
  assert.equal(steer.speaker, "Alex");
  assert.equal(steer.attachments[0]?.artifactId, "image-1");
});

test("live consumed steers join canonical history once and survive stopped/error fork accounting", () => {
  const items: Item[] = [
    item("UserMessage", { seq: 1, createdAt: 1, text: "start" }),
    item("ToolCall", { seq: 2, createdAt: 2, tool: "execute", callId: "a" }),
    item("SteeringMessage", { seq: 3, createdAt: 3, text: "Change direction" }),
    item("ToolResult", { seq: 4, createdAt: 4, tool: "execute", callId: "a" }),
    item("AgentMessage", { seq: 5, createdAt: 5, text: "(stopped)", body: { stopped: true } }),
  ];
  const work = (itemsToMessages(items).at(-1) as AssistantWork).work!;
  for (const reason of ["aborted", "error"] as const) {
    const live = itemsToMessages(items.slice(0, 1));
    appendConsumedSteers(live, work);
    appendConsumedSteers(live, work);
    assert.equal(live.length, 2);
    assert.equal((live[1] as { entrySeq?: number }).entrySeq, 3);
    live.push({ ...itemsToMessages(items).at(-1)!, stopReason: reason } as AgentMessage);
    assert.equal(forkCutSeq(items, live, live.length - 1), 5);
    assert.equal(forkCutSeq(items, live, 1), 3);
  }
});

const step = (id: string, stopReason: string, index: number, body: Record<string, unknown> = {}) => ({
  step: index,
  body: {
    ...body,
    wire: {
      message: { id, api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", stopReason },
    },
  },
});

function textOf(message: AssistantWork): string {
  const block = message.content[0];
  return block?.type === "text" ? block.text : "";
}

const interruptedAfterReply: Item[] = [
  item("UserMessage", { seq: 1, createdAt: 100, text: "Did you shrink it?" }),
  item("Reasoning", { seq: 2, createdAt: 110, text: "Time to answer.", ...step("s1", "stop", 0) }),
  item("AgentMessage", {
    seq: 3,
    createdAt: 120,
    variant: "narration",
    text: "Yes, I cut it by about a third.",
    ...step("s1", "stop", 1),
  }),
  item("UserMessage", {
    seq: 4,
    createdAt: 130,
    text: "(system note: interrupted)",
    hidden: true,
    body: { resumeNote: true },
  }),
  item("ToolCall", {
    seq: 5,
    createdAt: 140,
    tool: "execute",
    callId: "c1",
    ...step("s2", "toolUse", 0, { command: "git diff --stat" }),
  }),
  item("ToolResult", { seq: 6, createdAt: 150, tool: "execute", callId: "c1", text: "ok" }),
  item("AgentMessage", {
    seq: 7,
    createdAt: 160,
    text: "Yes, I cut it by about a third. Details follow.",
    ...step("s3", "stop", 0),
  }),
];

test("a reply the model finished before the run continued shows as a reply, not folded work", () => {
  const messages = itemsToMessages(interruptedAfterReply) as AssistantWork[];
  const replies = messages.filter((m) => m.role === "assistant");
  assert.deepEqual(
    replies.map(textOf),
    ["Yes, I cut it by about a third.", "Yes, I cut it by about a third. Details follow."],
    "both answers are visible messages",
  );
  const [first, second] = replies;
  assert.deepEqual(
    (first as AssistantWork & { entrySeqs?: number[] }).entrySeqs,
    [3, 2],
    "the first reply owns its text entry and the thinking before it",
  );
  assert.equal(first.work?.activity.length, 1, "the thinking before the first reply folds under it");
  assert.ok(
    activityItems(second.work?.activity ?? []).some((a) => a.kind === "ToolCall"),
    "the work after the interruption folds under the second reply",
  );
  assert.ok(
    !activityItems(second.work?.activity ?? []).some((a) => a.kind === "AgentMessage"),
    "the finished reply is not repeated inside the second reply's fold",
  );
});

test("text from a step that also called a tool stays narration inside the fold", () => {
  const items: Item[] = [
    item("UserMessage", { seq: 1, createdAt: 100, text: "Check it" }),
    item("AgentMessage", {
      seq: 2,
      createdAt: 110,
      variant: "narration",
      text: "Looking now.",
      ...step("s1", "toolUse", 0),
    }),
    item("ToolCall", {
      seq: 3,
      createdAt: 120,
      tool: "execute",
      callId: "c1",
      ...step("s1", "toolUse", 1, { command: "ls" }),
    }),
    item("ToolResult", { seq: 4, createdAt: 130, tool: "execute", callId: "c1", text: "ok" }),
    item("AgentMessage", { seq: 5, createdAt: 140, text: "All good.", ...step("s2", "stop", 0) }),
  ];
  const replies = (itemsToMessages(items) as AssistantWork[]).filter((m) => m.role === "assistant");
  assert.deepEqual(replies.map(textOf), ["All good."]);
  assert.ok(
    activityItems(replies[0].work?.activity ?? []).some((a) => a.kind === "AgentMessage"),
    "the narration stays in the fold",
  );
});

test("text without step metadata keeps its old rendering inside the fold", () => {
  const items: Item[] = [
    item("UserMessage", { seq: 1, createdAt: 100, text: "Check it" }),
    item("AgentMessage", { seq: 2, createdAt: 110, variant: "narration", text: "Looking now." }),
    item("AgentMessage", { seq: 3, createdAt: 140, text: "All good." }),
  ];
  const replies = (itemsToMessages(items) as AssistantWork[]).filter((m) => m.role === "assistant");
  assert.deepEqual(replies.map(textOf), ["All good."]);
  assert.ok(activityItems(replies[0].work?.activity ?? []).some((a) => a.kind === "AgentMessage"));
});

const LOG: Item[] = [
  item("UserMessage", { seq: 0, createdAt: 0, text: "first" }),
  item("ToolCall", { seq: 1, createdAt: 1 }),
  item("ToolResult", { seq: 2, createdAt: 2 }),
  item("AgentMessage", { seq: 3, createdAt: 3, text: "reply one" }),
  item("UserMessage", { seq: 4, createdAt: 4, text: "second" }),
  item("AgentMessage", { seq: 5, createdAt: 5, text: "reply two" }),
];
const ROWS = itemsToMessages(LOG);

test("forking a user message cuts at that user entry", () => {
  assert.equal(forkCutSeq(LOG, ROWS, 0), 0);
  assert.equal(forkCutSeq(LOG, ROWS, 2), 4);
});

test("forking an assistant message keeps its whole turn (tools included)", () => {
  assert.equal(forkCutSeq(LOG, ROWS, 1), 3);
});

test("forking the last assistant message stops at the items that existed when clicked", () => {
  assert.equal(forkCutSeq(LOG, ROWS, 3), 5);
});

test("a fork's rows cut at their own items, not at inherited ones", () => {
  const rows = itemsToMessages(LOG.slice(4));
  assert.equal(forkCutSeq(LOG, rows, 0, 3), 4);
  assert.equal(forkCutSeq(LOG, [{ role: "user", content: "second" }], 0, 3), 4);
});

test("an unsaved live prompt maps to the next saved user entry after the last saved row", () => {
  const live = [...itemsToMessages(LOG.slice(0, 4)), { role: "user", content: "second" }];
  assert.equal(forkCutSeq(LOG, live, 2), 4);
  assert.equal(forkCutSeq(LOG.slice(0, 4), live, 2), undefined);
  const resumed = [
    ...itemsToMessages(LOG.slice(0, 4)),
    { role: "user", content: "", resumeAnchor: true },
    { role: "assistant" },
  ];
  assert.equal(forkCutSeq(LOG, resumed, 3), 3);
});

for (const text of ["", "Partial answer", "(stopped)"]) {
  test(`stopped history preserves status, content and timing: ${JSON.stringify(text)}`, () => {
    const items: Item[] = [
      item("AgentMessage", {
        createdAt: 4000,
        seq: 1,
        text: text,
        body: { stopped: true, workStartedAt: 1000, workFinishedAt: 4000 },
      }),
    ];
    const messages = itemsToMessages(items);
    assert.equal(messages.length, 1);
    const message = messages[0] as AssistantWork;
    assert.equal(message.stopReason, "aborted");
    assert.deepEqual(message.content, [{ type: "text", text }]);
    assert.equal(workSeconds(message.work!), 3);
  });
}

test("legacy stopped placeholders are recognized without treating ordinary replies as cancellation", () => {
  for (const [text, reason] of [
    ["(stopped)", "aborted"],
    ["The process stopped.", "stop"],
  ]) {
    const message = itemsToMessages([
      item("AgentMessage", { createdAt: 1000, seq: 1, text: text }),
    ])[0] as AssistantWork;
    assert.equal(message.stopReason, reason);
  }
});

test("a turn_stopped record renders as the stopped state, once, and never as a message", () => {
  const stop = (seq: number): Item => item("Stop", { createdAt: 5000, seq, body: { reason: "by user" } });
  const request = (seq: number): Item => item("UserMessage", { createdAt: 1000, seq, text: "do the thing" });

  const bare = itemsToMessages([request(1), stop(2)]);
  assert.equal(bare.length, 2);
  assert.equal((bare[1] as AssistantWork).stopReason, "aborted");
  assert.deepEqual((bare[1] as AssistantWork).content, [{ type: "text", text: "" }]);

  const withPartial = itemsToMessages([
    request(1),
    item("AgentMessage", { createdAt: 4000, seq: 2, text: "Partial answer", body: { stopped: true } }),
    stop(3),
  ]);
  assert.equal(withPartial.length, 2, "the partial answer already shows the stopped state");
  assert.deepEqual((withPartial[1] as AssistantWork).content, [{ type: "text", text: "Partial answer" }]);

  const twoStoppedTurns = itemsToMessages([
    request(1),
    item("AgentMessage", { createdAt: 4000, seq: 2, text: "Partial answer", body: { stopped: true } }),
    stop(3),
    item("UserMessage", { createdAt: 6000, seq: 4, text: "continue", hidden: true }),
    stop(5),
  ]);
  assert.equal(
    twoStoppedTurns.filter((m) => (m as AssistantWork).stopReason === "aborted").length,
    2,
    "a later stopped turn after a hidden prompt still shows its own stopped state",
  );
});

const assistant = (text: string): AgentMessage =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as AgentMessage;
const user = (text: string): AgentMessage => ({ role: "user", content: text }) as unknown as AgentMessage;

test("approval continuation preserves the paused work without seeding its text into the new reply", () => {
  const history = itemsToMessages([
    item("UserMessage", { seq: 0, createdAt: 10, text: "show help" }),
    item("AgentMessage", {
      seq: 1,
      createdAt: 11,
      variant: "narration",
      text: "Checking help",
      body: { phase: "commentary" },
    }),
    item("ToolCall", { seq: 2, createdAt: 12, body: { command: "help" } }),
    item("ToolResult", { seq: 3, createdAt: 13, body: { blocked: "needs_approval" } }),
  ]);
  const resumed = continuableMessages(history);
  assert.deepEqual(resumed.messages.slice(0, history.length), history);
  assert.deepEqual(resumed.popped, []);
  assert.deepEqual(resumed.messages.at(-1), resumeAnchor());
  const continuing = continuableMessages([...history, assistant("New continuation")]);
  assert.deepEqual(continuing.messages, resumed.messages);
  assert.deepEqual(continuing.popped, [assistant("New continuation")]);
});

test("a pending run restores its input without consuming the previous reply", () => {
  const earlier = [user("repeat"), assistant("Earlier answer")];
  const restored = continuableMessages(earlier, {
    runId: "pending",
    seq: null,
    text: "repeat",
    createdAt: 20,
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 50 }],
  });
  assert.deepEqual(restored.messages.slice(0, 2), earlier);
  assert.deepEqual(restored.popped, []);
  assert.deepEqual(restored.messages[2], {
    role: "user",
    runId: "pending",
    content: "repeat",
    timestamp: 20,
    attachments: [{ id: "pending:0", type: "document", fileName: "notes.txt", mimeType: "text/plain", size: 50 }],
  });
});

test("a recorded input wins over an older pending snapshot without text-based deduplication", () => {
  const messages = itemsToMessages([
    item("UserMessage", { seq: 0, createdAt: 20, text: "original", turnId: "run" }),
    item("AgentMessage", {
      seq: 1,
      createdAt: 21,
      variant: "narration",
      text: "Working",
      body: { phase: "commentary" },
    }),
    item("SteeringMessage", { seq: 2, createdAt: 22, text: "steer", turnId: "run" }),
  ]);
  const resumed = continuableMessages(messages, { runId: "run", seq: null, text: "stale", createdAt: 19 });
  assert.equal(resumed.messages.length, 2);
  assert.equal(resumed.popped.length, 1);
  assert.equal((resumed.messages[0] as { content: unknown }).content, "original");
});

test("legacy run boundaries at sequence zero also identify the recorded input", () => {
  const messages = itemsToMessages([item("UserMessage", { seq: 0, createdAt: 20, text: "recorded" })]);
  const resumed = continuableMessages(messages, { runId: "legacy", seq: 0, text: "request", createdAt: 19 });
  assert.deepEqual(resumed.messages, messages);
});

test("a window holding nothing the person said still yields a continuable conversation", () => {
  const { messages, popped } = continuableMessages([assistant("tool churn"), assistant("more churn")]);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { role?: string }).role, "user");
  assert.equal((messages[0] as { resumeAnchor?: boolean }).resumeAnchor, true);
  assert.equal(popped.length, 2, "the assistant text is handed back for the live stream to re-seed");
});

test("a window that does hold the person's message is left alone", () => {
  const { messages, popped } = continuableMessages([user("do the thing"), assistant("on it")]);
  assert.deepEqual(
    messages.map((m) => (m as { role?: string }).role),
    ["user"],
  );
  assert.equal((messages[0] as { resumeAnchor?: boolean }).resumeAnchor, undefined);
  assert.equal(popped.length, 1);
});

test("an empty window anchors rather than refusing", () => {
  assert.equal(continuableMessages([]).messages.length, 1);
});

test("the anchor is never drawn", () => {
  assert.equal((resumeAnchor() as { content?: unknown }).content, "");
});

test("a run whose reply already landed is not something to attach to", () => {
  assert.equal(runIsTerminal({ status: "running", result: null, replyComplete: true }), true);
  assert.equal(runIsTerminal({ status: "done", result: null }), true);
  assert.equal(runIsTerminal({ status: "running", result: null }), false);
});
