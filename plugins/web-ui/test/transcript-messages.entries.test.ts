import type { Item } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { attachPendingApprovals, itemsToMessages, type AssistantWork } from "../src/transcript-messages.ts";
import type { PendingApproval } from "../src/core-bridge.ts";
import { kinds, MODEL } from "./support/transcript-fixture.ts";

test("tool items are folded into the following assistant reply's work block", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "hi" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "ls" } }),
    item("ToolResult", { createdAt: 120, seq: 3, tool: "execute", text: "a\nb", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 130, text: "done" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2, "user + assistant");
  const work = (msgs[1] as AssistantWork).work;
  assert.ok(work, "the assistant reply carries a work block");
  assert.equal(work?.status, "complete");
  assert.equal(work?.startedAt, 110, "work starts at the first tool step");
  assert.equal(work?.finishedAt, 130, "work ends at the assistant reply");
  assert.deepEqual(kinds(work), ["ToolCall", "ToolResult"]);
});

test("a subagent mail entry carries a structured ref so the transcript can render a chip", () => {
  const envelope = [
    '<wake reason="subagent" name="Poet &quot;one&quot;" sessionId="child-1" kind="final_answer" at="2026-09-03T00:00:00.000Z">',
    '  <why>Your subagent session "Poet one" finished a turn and sent back its result.</why>',
    "  <content>the poem</content>",
    "</wake>",
  ].join("\n");
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: envelope, body: { display: "[subagent Poet one: final answer]" } }),
    item("AgentMessage", { createdAt: 110, text: "here it is" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const mail = (msgs[0] as { subagentMail?: { sessionId: string; title: string; kind: string } }).subagentMail;
  assert.deepEqual(mail, { sessionId: "child-1", title: 'Poet "one"', kind: "final_answer" });
  const plain = itemsToMessages([item("UserMessage", { createdAt: 100, text: "hi" })], MODEL);
  assert.equal((plain[0] as { subagentMail?: unknown }).subagentMail, undefined);
});

test("a hidden proactive-opener user entry never renders, but its assistant greeting does", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "open the conversation", hidden: true }),
    item("AgentMessage", { createdAt: 110, text: "Hi — I'm your AI teammate 👋" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 1, "only the greeting, never the opener seed");
  assert.equal((msgs[0] as { role?: string }).role, "assistant");
});

test("a delivered cron reply renders as an assistant reply", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "remind me later" }),
    item("AgentMessage", { createdAt: 110, text: "will do" }),
    item("AgentMessage", { createdAt: 200, seq: 2, text: "Reminder: standup in 10 minutes", body: { via: "cron" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 3, "user + reply + delivered reminder");
  const delivered = msgs[2] as AssistantWork & { role?: string; content?: Array<{ text?: string }> };
  assert.equal(delivered.role, "assistant");
  assert.equal(delivered.content?.[0]?.text, "Reminder: standup in 10 minutes");
  assert.equal(delivered.work, undefined, "a delivery is a reply, not tool activity");
});

test("a migrated reply and delivered-file entry render text and file chips", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "make gifs" }),
    item("AgentMessage", { createdAt: 120, seq: 1, text: "rsi.gif" }),
    item("AgentMessage", {
      createdAt: 121,
      seq: 2,
      variant: "files_delivered",
      body: { files: [{ name: "rsi.gif", mimetype: "image/gif", sizeBytes: 42, artifactId: "art-1" }] },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2);
  assert.deepEqual((msgs[1] as AssistantWork).deliveredFiles, [
    { name: "rsi.gif", mimetype: "image/gif", sizeBytes: 42, artifactId: "art-1" },
  ]);
});

test("a durable turn_failure entry renders like the live inline error (survives reload)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "how did it go?" }),
    item("Error", { createdAt: 110, errorCode: "turn_failure", text: "API integrators: you can reduce refusals…" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2, "user + error");
  const err = msgs[1] as { role?: string; stopReason?: string; errorMessage?: string };
  assert.equal(err.role, "assistant");
  assert.equal(err.stopReason, "error");
  assert.equal(err.errorMessage, "API integrators: you can reduce refusals…");
});

test("user items carry the stored speaker identity, name and slack ts onto the rebuilt message", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      text: "hi",
      externalId: "100.1",
      body: { name: "Alice Example", speakerId: "person-a" },
    }),
    item("UserMessage", { createdAt: 110, text: "anonymous web message" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const [slack, web] = msgs as Array<{ speaker?: string; speakerId?: string; ts?: string }>;
  assert.equal(slack?.speaker, "Alice Example");
  assert.equal(slack?.speakerId, "person-a");
  assert.equal(slack?.ts, "100.1");
  assert.equal(web?.speaker, undefined);
  assert.equal(web?.speakerId, undefined);
  assert.equal(web?.ts, undefined);
});

test("a message_revision marker renders as a system note and badges the original bubble", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "original", externalId: "100.1", body: { name: "Alice Example" } }),
    item("AgentMessage", { createdAt: 110, text: "reply" }),
    item("Retraction", {
      createdAt: 120,
      body: { action: "edited", ts: "100.1", text: "fixed", name: "Alice Example" },
    }),
    item("Retraction", { createdAt: 130, body: { action: "deleted", ts: "100.1", name: "Alice Example" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 4, "user + reply + edit note + delete note");
  const original = msgs[0] as { edited?: boolean; deleted?: boolean };
  assert.equal(original.edited, true);
  assert.equal(original.deleted, true);
  const note = msgs[2] as { role?: string; action?: string; content?: string; speaker?: string; timestamp?: number };
  assert.equal(note.role, "system-note");
  assert.equal(note.action, "edited");
  assert.equal(note.content, "fixed");
  assert.equal(note.speaker, "Alice Example");
  assert.equal(note.timestamp, 120);
  assert.equal((msgs[3] as { action?: string }).action, "deleted");
});

test("a revision marker whose original message is outside the window still renders as a note", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 200, text: "later message", externalId: "200.0" }),
    item("Retraction", { createdAt: 210, body: { action: "deleted", ts: "100.1" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2);
  assert.equal((msgs[0] as { deleted?: boolean }).deleted, undefined, "the wrong bubble is never badged");
  assert.equal((msgs[1] as { role?: string }).role, "system-note");
});

test("other system items (file events, context summaries) still never render", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "hi" }),
    item("ContextCompaction", { createdAt: 106, throughSeq: 1, text: "summary" }),
    item("AgentMessage", { createdAt: 110, text: "hello" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2, "user + assistant only");
});

test("a turn with no tool items gets no work block (plain markdown, prior behavior)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 200, text: "again" }),
    item("AgentMessage", { createdAt: 210, text: "plain" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal((msgs[1] as AssistantWork).work, undefined);
});

test("user attachments survive the reload rebuild — image with text keeps a renderable attachment", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: "look at this",
      body: {
        attachments: [
          { name: "shot.png", mimetype: "image/png", sizeBytes: 116526, direction: "in", artifactId: "art-9" },
        ],
      },
    }),
    item("AgentMessage", { createdAt: 110, text: "Looking." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const user = msgs[0] as { role?: string; content?: string; attachments?: Array<Record<string, unknown>> };
  assert.equal(user.role, "user");
  assert.equal(user.content, "look at this", "the text stays the bubble text");
  assert.deepEqual(user.attachments, [
    { id: "art-9", type: "image", fileName: "shot.png", mimeType: "image/png", size: 116526, artifactId: "art-9" },
  ]);
});

test("an attachment-only user entry rebuilds as a real user message with attachments, not a \u{1F4CE} text line", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: "",
      body: {
        attachments: [{ name: "cat.png", mimetype: "image/png", sizeBytes: 5, direction: "in", artifactId: "art-1" }],
      },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 1);
  const user = msgs[0] as { content?: string; attachments?: Array<{ fileName?: string }> };
  assert.equal(user.content, "", "no synthetic emoji line");
  assert.equal(user.attachments?.[0]?.fileName, "cat.png");
});

test("a legacy user entry without artifactId keeps a metadata-only attachment (chip fallback)", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 3,
      text: "old one",
      body: { attachments: [{ name: "doc.pdf", mimetype: "application/pdf", sizeBytes: 9, direction: "in" }] },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const att = (msgs[0] as { attachments?: Array<Record<string, unknown>> }).attachments?.[0];
  assert.ok(att, "attachment survives");
  assert.equal(att!.type, "document");
  assert.equal(att!.artifactId, undefined, "no fabricated artifact link");
});

test("an attach tool result attaches openable files to the turn's assistant message", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "make a report" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "attach", callId: "c1", body: { files: ["report.md"] } }),
    item("ToolResult", {
      createdAt: 111,
      seq: 3,
      tool: "attach",
      callId: "c1",
      body: { ok: true, files: [{ name: "report.md", mimetype: "text/markdown", sizeBytes: 12, artifactId: "art-9" }] },
    }),
    item("AgentMessage", { createdAt: 120, text: "Here it is." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.deepEqual((msgs[1] as AssistantWork).deliveredFiles, [
    { name: "report.md", mimetype: "text/markdown", sizeBytes: 12, artifactId: "art-9" },
  ]);
});

test("re-attaching a path renders one chip, not two", () => {
  const attachResult = (callId: string, artifactId: string, seq: number): Item =>
    item("ToolResult", {
      createdAt: 110 + seq,
      seq,
      tool: "attach",
      callId: callId,
      body: { ok: true, files: [{ name: "report.md", mimetype: "text/markdown", sizeBytes: 12, artifactId }] },
    });
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "make a report" }),
    attachResult("c1", "art-draft", 3),
    attachResult("c2", "art-fixed", 5),
    item("AgentMessage", { createdAt: 120, text: "Here it is." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.deepEqual((msgs[1] as AssistantWork).deliveredFiles, [
    { name: "report.md", mimetype: "text/markdown", sizeBytes: 12, artifactId: "art-fixed" },
  ]);
});

test("a failed attach tool result attaches no files", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "make a report" }),
    item("ToolResult", { createdAt: 111, seq: 3, tool: "attach", callId: "c1", body: { ok: false } }),
    item("AgentMessage", { createdAt: 120, text: "I could not find it." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal((msgs[1] as AssistantWork).deliveredFiles, undefined);
});

test("tool items from a prior turn don't leak into the next turn's assistant reply", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "one" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "read", body: { path: "/x" } }),
    item("UserMessage", { createdAt: 200, text: "two" }),
    item("AgentMessage", { createdAt: 210, text: "answer" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const last = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(last.work, undefined, "the second turn's reply carries none of the first turn's activity");
  assert.ok(msgs.some((m) => kinds((m as AssistantWork).work).includes("ToolCall")));
});

test("a turn paused mid-stream (no closing assistant entry) flushes its activity into a work block", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "do it" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "rm -rf x" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2, "user + a synthetic assistant holding the paused activity");
  const work = (msgs[1] as AssistantWork).work;
  assert.ok(work, "trailing tool activity is not dropped");
  assert.deepEqual(kinds(work), ["ToolCall"]);
});

test("attachPendingApprovals hangs approvals on the trailing assistant turn after reload", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "do it" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "deploy" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const approvals: PendingApproval[] = [{ requestId: "r1", command: "deploy", reason: "needs ok" }];
  attachPendingApprovals(msgs, approvals, MODEL);
  assert.deepEqual((msgs[msgs.length - 1] as AssistantWork).work?.pendingApprovals, approvals);
});

test("attachPendingApprovals anchors a stale approval to its own turn, not the latest one", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "do it" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "deploy" } }),
    item("UserMessage", { createdAt: 200, text: "actually, nvm — what time is it?" }),
    item("AgentMessage", { createdAt: 210, text: "It's noon." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const before = msgs.length;
  const approvals: PendingApproval[] = [{ requestId: "r1", command: "deploy", reason: "needs ok" }];
  attachPendingApprovals(msgs, approvals, MODEL);
  assert.equal(msgs.length, before, "no synthetic turn is appended");
  const deployTurn = msgs.find((m) => kinds((m as AssistantWork).work).includes("ToolCall")) as AssistantWork;
  assert.deepEqual(deployTurn.work?.pendingApprovals, approvals, "buttons hang on the deploy turn");
  assert.equal((msgs[msgs.length - 1] as AssistantWork).work?.pendingApprovals, undefined, "not on the latest turn");
});

test("attachPendingApprovals attaches to a completed turn that carries the paused command (ok + pendingApprovals)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "deploy it in the background" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "deploy" } }),
    item("AgentMessage", { createdAt: 120, text: "Kicking that off." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const approvals: PendingApproval[] = [{ requestId: "r1", command: "deploy", reason: "needs ok" }];
  attachPendingApprovals(msgs, approvals, MODEL);
  assert.deepEqual((msgs[msgs.length - 1] as AssistantWork).work?.pendingApprovals, approvals);
});

test("attachPendingApprovals with no outstanding approvals leaves the transcript untouched", () => {
  const msgs: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 1 } as AgentMessage];
  attachPendingApprovals(msgs, [], MODEL);
  assert.equal(msgs.length, 1);
});

test("attachPendingApprovals appends an assistant turn when the transcript ends on the user", () => {
  const msgs = itemsToMessages([item("UserMessage", { createdAt: 100, text: "approve please" })], MODEL);
  const approvals: PendingApproval[] = [{ requestId: "r1", command: "deploy" }];
  attachPendingApprovals(msgs, approvals, MODEL);
  const last = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(last.role, "assistant");
  assert.deepEqual(last.work?.pendingApprovals, approvals);
});
