import type { Item } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import { activityItems } from "../src/items.ts";
import { messageWorkTimeline } from "../src/timeline.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { itemsToMessages, type AssistantWork } from "../src/transcript-messages.ts";
import { kinds, MODEL } from "./support/transcript-fixture.ts";

test("thinking items are interleaved into the work block by seq (reload path)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "do it" }),
    item("Reasoning", { createdAt: 110, seq: 2, text: "let me look" }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "ls" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "execute", body: { code: 0 } }),
    item("Reasoning", { createdAt: 135, seq: 5, text: "", body: { redacted: true } }),
    item("AgentMessage", { createdAt: 140, seq: 6, text: "done" }),
  ];
  const work = (itemsToMessages(items, MODEL)[1] as AssistantWork).work;
  assert.deepEqual(
    kinds(work),
    ["Reasoning", "ToolCall", "ToolResult"],
    "renderable thinking is kept in seq order; the redacted (empty) thinking is dropped",
  );
});

test("interstitial text items fold into the work timeline; the final reply stays separate", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "go" }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Looking now." }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "ls" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 140, seq: 5, text: "All set." }),
  ];
  const msg = itemsToMessages(items, MODEL)[1] as AssistantWork;
  assert.deepEqual(
    kinds(msg.work),
    ["AgentMessage", "ToolCall", "ToolResult"],
    "narration is woven into the work block in seq order",
  );
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "All set.",
    "the final reply is the assistant entry, not a text segment",
  );
});

test("a turn ending on a tool-call step doesn't duplicate its narration (reply == last text)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "delete it" }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Deleting now." }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "rm -rf x" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "execute", body: { blocked: "needs_approval" } }),
    item("AgentMessage", { createdAt: 140, seq: 5, text: "Deleting now." }),
  ];
  const msg = itemsToMessages(items, MODEL)[1] as AssistantWork;
  assert.deepEqual(
    kinds(msg.work),
    ["ToolCall", "ToolResult"],
    "the duplicated narration segment is dropped from the work block",
  );
  assert.equal((msg.content[0] as { text: string }).text, "Deleting now.", "it shows once, as the reply");
});

test("a wake-wrapped user entry renders its display text, never the raw envelope", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 0,
      text: '<wake reason="addressed" surface="web"><addressed-messages>…</addressed-messages></wake>',
      body: { display: "Do you have any policies around sensitive data?", name: "carol" },
    }),
    item("AgentMessage", { createdAt: 130, seq: 1, text: "done" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal((msgs[0] as { content?: string }).content, "Do you have any policies around sensitive data?");
  assert.ok(!JSON.stringify(msgs).includes("<wake"), "the envelope never reaches the transcript");
});

test("a surface post renders as the reply bubble; the closing self-log demotes to work narration", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "<wake…>", body: { display: "any policies?" } }),
    item("Reasoning", { createdAt: 105, seq: 1, text: "I should summarize the policies." }),
    item("ToolCall", {
      createdAt: 110,
      seq: 2,
      tool: "web",
      callId: "c1",
      body: { action: "post", text: "Yes — conversation boundaries, credentials, least access." },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 3,
      tool: "web",
      callId: "c1",
      text: "[sent]",
      isError: false,
      body: { action: "post", ok: true },
    }),
    item("AgentMessage", { createdAt: 130, seq: 4, text: "Replied in thread with a policy summary." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 3, "user + post reply + demoted-log work block");
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.role, "assistant");
  assert.equal(reply.content[0]?.text, "Yes — conversation boundaries, credentials, least access.");
  assert.ok(
    !JSON.stringify(reply.work?.activity ?? []).includes('"tool_call"'),
    "the post call folds into the bubble, not a work row",
  );
  const trailer = msgs[2] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(trailer.content[0]?.text ?? "", "", "the self-log is not a reply bubble");
  assert.deepEqual(messageWorkTimeline(trailer.work!, ""), [], "the demoted-only trailer has no visible work fold");
  assert.ok(
    JSON.stringify(trailer.work?.activity ?? []).includes("Replied in thread"),
    "the self-log survives as work narration",
  );
});

test("a legacy bytes-only post entry keeps the old rendering (work row + closing text as reply)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "hi" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "web", callId: "c1", body: { action: "post", bytes: 873 } }),
    item("ToolResult", {
      createdAt: 120,
      seq: 3,
      tool: "web",
      callId: "c1",
      text: "[sent]",
      isError: false,
      body: { action: "post", ok: true },
    }),
    item("AgentMessage", { createdAt: 130, seq: 4, text: "Replied in thread." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.content[0]?.text, "Replied in thread.");
  assert.deepEqual(kinds(reply.work), ["ToolCall", "ToolResult"]);
});

test("a failed text-less post (missing_text) stays visible as a failed work row", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "hi" }),
    item("ToolResult", {
      createdAt: 140,
      seq: 5,
      tool: "web",
      callId: "c2",
      text: '[error] the "post" action requires `text`.',
      isError: true,
      body: { action: "post", error: "missing_text" },
    }),
    item("ToolCall", {
      createdAt: 150,
      seq: 6,
      tool: "web",
      callId: "c3",
      body: { action: "post", text: "second try" },
    }),
    item("ToolResult", {
      createdAt: 160,
      seq: 7,
      tool: "web",
      callId: "c3",
      text: "[sent]",
      isError: false,
      body: { action: "post", ok: true },
    }),
    item("AgentMessage", { createdAt: 170, seq: 8, text: "Recovered and replied." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.content[0]?.text, "second try");
  assert.ok(
    JSON.stringify(reply.work?.activity ?? []).includes("missing_text"),
    "the failed attempt still shows in the timeline",
  );
});

test("a FAILED post never renders as a delivered reply — its rows stay in the work timeline and the closing text stays the reply", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "hi" }),
    item("ToolCall", {
      createdAt: 110,
      seq: 1,
      tool: "web",
      callId: "c1",
      body: { action: "post", text: "undelivered answer" },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 2,
      tool: "web",
      callId: "c1",
      text: "[not sent] delivery failed",
      isError: true,
      body: { action: "post", ok: false },
    }),
    item("AgentMessage", { createdAt: 130, seq: 3, text: "I couldn't deliver that reply — the send failed." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(
    reply.content[0]?.text,
    "I couldn't deliver that reply — the send failed.",
    "the agent's explanation stays the visible reply",
  );
  assert.ok(JSON.stringify(reply.work?.activity ?? []).includes("[not sent]"), "the failure row stays visible");
});

test("an interrupted post (no result) renders as a work row, not a sent bubble", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "hi" }),
    item("ToolCall", {
      createdAt: 110,
      seq: 1,
      tool: "web",
      callId: "c1",
      body: { action: "post", text: "maybe sent" },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2);
  const trailer = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(trailer.content[0]?.text ?? "", "", "no bubble claims the text was delivered");
  assert.ok(JSON.stringify(trailer.work?.activity ?? []).includes("maybe sent"), "the call is still visible as work");
});

test("a posted turn that closes empty is NOT promoted — the post bubble is already the reply", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "<wake…>", body: { display: "any policies?" } }),
    item("ToolCall", {
      createdAt: 110,
      seq: 1,
      tool: "web",
      callId: "c1",
      body: { action: "post", text: "Yes — three of them." },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 2,
      tool: "web",
      callId: "c1",
      text: "[sent]",
      isError: false,
      body: { action: "post", ok: true },
    }),
    item("AgentMessage", { createdAt: 130, seq: 3, variant: "narration", text: "Logged the summary for follow-up." }),
    item("ToolCall", { createdAt: 140, seq: 4, tool: "execute", body: { command: "echo done" } }),
    item("ToolResult", { createdAt: 150, seq: 5, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 160, seq: 6, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.content[0]?.text, "Yes — three of them.", "the delivered post stays the reply");
  const trailer = msgs[2] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(trailer.content[0]?.text ?? "", "", "trailing narration is not promoted into a second reply bubble");
  assert.ok(
    JSON.stringify(trailer.work?.activity ?? []).includes("Logged the summary"),
    "the narration survives as work",
  );
});

test("a turn that closed empty after narrating surfaces the last narration as the reply", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: '<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>fetch done</why></wake>',
      hidden: true,
    }),
    item("AgentMessage", {
      createdAt: 110,
      seq: 2,
      variant: "narration",
      text: "All benign — building the replay harness.",
    }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "node replay.js" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", {
      createdAt: 140,
      seq: 5,
      variant: "narration",
      text: "Server.js is nearly true — 8 bad lines. Applying the fixes.",
    }),
    item("ToolCall", { createdAt: 150, seq: 6, tool: "execute", body: { command: "node apply.js" } }),
    item("ToolResult", { createdAt: 160, seq: 7, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 170, seq: 8, text: "" }),
  ];
  const msg = itemsToMessages(items, MODEL)[0] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "Server.js is nearly true — 8 bad lines. Applying the fixes.",
    "the last narration becomes the visible reply instead of a bare tool-call count",
  );
  assert.deepEqual(
    kinds(msg.work),
    ["AgentMessage", "ToolCall", "ToolResult", "ToolCall", "ToolResult"],
    "the promoted segment moves out of the work block; earlier narration stays",
  );
});

const wakeEntry = (seq: number, createdAt: number): Item =>
  item("UserMessage", {
    createdAt,
    seq,
    text: '<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>still running</why></wake>',
    hidden: true,
  });

const silentFinish = (seq: number, createdAt: number): Item[] => [
  item("ToolCall", { createdAt, seq, tool: "finish_silently", body: { reason: "nothing new" } }),
  item("ToolResult", { createdAt: createdAt + 1, seq: seq + 1, tool: "finish_silently", body: { silent: true } }),
];

test("a wake that only finishes silently leaves nothing in the transcript", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 10, seq: 1, text: "watch the deploy" }),
    item("AgentMessage", { createdAt: 20, seq: 2, text: "Watching." }),
    wakeEntry(3, 100),
    item("AgentMessage", { createdAt: 110, seq: 4, variant: "narration", text: "Heartbeat check." }),
    ...silentFinish(5, 120),
    item("AgentMessage", { createdAt: 140, seq: 7, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.deepEqual(
    msgs.map((m) => (m as { role: string }).role),
    ["user", "assistant"],
  );
  assert.equal(((msgs[1] as AssistantWork).content[0] as { text: string }).text, "Watching.");
});

test("a silent wake keeps its real tool work but drops the finish_silently call", () => {
  const items: Item[] = [
    wakeEntry(1, 100),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "background", body: { action: "poll" } }),
    item("ToolResult", { createdAt: 115, seq: 3, tool: "background", body: { action: "poll" } }),
    ...silentFinish(4, 120),
    item("AgentMessage", { createdAt: 140, seq: 6, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 1);
  const msg = msgs[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "", "intentional silence is not turned into a message");
  assert.deepEqual(
    activityItems(msg.work?.activity ?? []).map((a) => a.tool),
    ["background", "background"],
  );
});

test("a wake that replies is unchanged", () => {
  const items: Item[] = [
    wakeEntry(1, 100),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "background", body: { action: "poll" } }),
    item("ToolResult", { createdAt: 115, seq: 3, tool: "background", body: { action: "poll" } }),
    item("AgentMessage", { createdAt: 140, seq: 4, text: "Deploy finished." }),
  ];
  const msg = itemsToMessages(items, MODEL)[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "Deploy finished.");
  assert.equal(msg.work?.activity.length, 2);
});

test("a visible turn that finishes silently still shows the finish_silently call", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "no reply needed" }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Nothing to add." }),
    ...silentFinish(3, 120),
    item("AgentMessage", { createdAt: 140, seq: 5, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const msg = msgs[msgs.length - 1] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "", "intentional silence is not turned into a message");
  assert.deepEqual(kinds(msg.work), ["AgentMessage", "ToolCall", "ToolResult"]);
});

test("a no-op finish_silently (non-poll, no silent:true) does NOT suppress promotion", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "do it" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "finish_silently" }),
    item("ToolResult", { createdAt: 120, seq: 3, tool: "finish_silently", body: { noop: "not_a_poll_fire" } }),
    item("AgentMessage", { createdAt: 130, seq: 4, variant: "narration", text: "Actually, here's the result." }),
    item("ToolCall", { createdAt: 140, seq: 5, tool: "execute", body: { command: "ls" } }),
    item("ToolResult", { createdAt: 150, seq: 6, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 160, seq: 7, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const msg = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "Actually, here's the result.",
    "a no-op silence call is not real silence",
  );
});

test("an explicit stay_silent decline stays collapsed — narration is not promoted", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "<wake…>", body: { display: "fyi thread" } }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Not my place to weigh in here." }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "stay_silent", body: { reason: "not addressed to me" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "stay_silent", body: { ok: true } }),
    item("AgentMessage", { createdAt: 140, seq: 5, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const msg = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "",
    "a deliberate decline is not turned into a visible message",
  );
});

test("posted state does not leak across a hidden turn boundary — the next turn's reply stays visible", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "<wake…>", body: { display: "any policies?" } }),
    item("ToolCall", {
      createdAt: 110,
      seq: 2,
      tool: "web",
      callId: "c1",
      body: { action: "post", text: "Yes — three of them." },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 3,
      tool: "web",
      callId: "c1",
      text: "[sent]",
      isError: false,
      body: { action: "post", ok: true },
    }),
    item("AgentMessage", { createdAt: 130, seq: 4, text: "" }),
    item("UserMessage", { createdAt: 140, seq: 5, text: "[keychain wake] credential arrived", hidden: true }),
    item("ToolCall", { createdAt: 150, seq: 6, tool: "execute", body: { command: "use-credential" } }),
    item("ToolResult", { createdAt: 160, seq: 7, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 170, seq: 8, text: "Credential loaded; task complete." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const last = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (last.content[0] as { text: string }).text,
    "Credential loaded; task complete.",
    "the later turn's reply is not demoted by the earlier turn's post",
  );
});

test("a still-running turn (no closing entry yet) is not promoted", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "go" }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Working on it." }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "ls" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const msg = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "",
    "an in-flight turn keeps streaming live; the rebuild doesn't fake a reply",
  );
  assert.deepEqual(kinds(msg.work), ["AgentMessage", "ToolCall"]);
});

test("a closed empty turn with no narration stays a bare work row", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: '<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>tick</why></wake>',
      hidden: true,
    }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "tail log" } }),
    item("ToolResult", { createdAt: 120, seq: 3, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 130, seq: 4, text: "" }),
  ];
  const msg = itemsToMessages(items, MODEL)[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "");
  assert.deepEqual(kinds(msg.work), ["ToolCall", "ToolResult"]);
});

test("a mid-turn hidden entry (resume/wake note) does not split the turn; promotion still fires", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: '<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>fetch done</why></wake>',
      hidden: true,
    }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Applying the fixes." }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "node apply.js" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "execute", body: { code: 0 } }),
    item("UserMessage", {
      createdAt: 140,
      seq: 5,
      text: "(system note: the platform restarted mid-turn…)",
      hidden: true,
    }),
    item("AgentMessage", { createdAt: 150, seq: 6, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 1, "one turn, not a bare row plus a separate empty block");
  const msg = msgs[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "Applying the fixes.");
  assert.deepEqual(kinds(msg.work), ["ToolCall", "ToolResult"]);
});

test("a turn resumed past a hidden note renders as one block with the real reply", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: '<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>fetch done</why></wake>',
      hidden: true,
    }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "node rebuild.js" } }),
    item("ToolResult", { createdAt: 120, seq: 3, tool: "execute", body: { code: 0 } }),
    item("UserMessage", {
      createdAt: 130,
      seq: 4,
      text: "(system note: the platform restarted mid-turn…)",
      hidden: true,
    }),
    item("AgentMessage", { createdAt: 140, seq: 5, text: "Recon-app rebuilt and republished — all eight are live." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 1);
  const msg = msgs[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "Recon-app rebuilt and republished — all eight are live.");
  assert.deepEqual(kinds(msg.work), ["ToolCall", "ToolResult"], "the work block is not split at the hidden note");
});

test("a file-only post (empty text) still renders its delivered files", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "just send the file" }),
    item("ToolCall", {
      createdAt: 110,
      seq: 1,
      tool: "web",
      callId: "c2",
      body: { action: "post", text: "", files: ["out/report.pdf"] },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 2,
      tool: "web",
      callId: "c2",
      text: "[sent]",
      isError: false,
      body: {
        action: "post",
        ok: true,
        files: [{ name: "report.pdf", mimetype: "application/pdf", sizeBytes: 512, artifactId: "art-7" }],
      },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.role, "assistant");
  assert.equal(reply.content[0]?.text, "");
  assert.deepEqual(
    reply.deliveredFiles?.map((f) => ({ name: f.name, artifactId: f.artifactId })),
    [{ name: "report.pdf", artifactId: "art-7" }],
    "the file-only post's attachment still surfaces on the message",
  );
});

test("a surface post's sent files render as delivered files on the reply bubble", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "send the drafts" }),
    item("ToolCall", {
      createdAt: 110,
      seq: 1,
      tool: "web",
      callId: "c1",
      body: {
        action: "post",
        text: "Here they are — profiles A/B/C.",
        files: ["qm-brand/profile_A.png", "qm-brand/profile_B.png"],
      },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 2,
      tool: "web",
      callId: "c1",
      text: "[sent]",
      isError: false,
      body: {
        action: "post",
        ok: true,
        files: [
          { name: "profile_A.png", mimetype: "image/png", sizeBytes: 28720, artifactId: "art-1" },
          { name: "profile_B.png", mimetype: "image/png", sizeBytes: 21922, artifactId: "art-2" },
        ],
      },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.role, "assistant");
  assert.equal(reply.content[0]?.text, "Here they are — profiles A/B/C.");
  assert.deepEqual(
    reply.deliveredFiles?.map((f) => ({ name: f.name, artifactId: f.artifactId })),
    [
      { name: "profile_A.png", artifactId: "art-1" },
      { name: "profile_B.png", artifactId: "art-2" },
    ],
    "the attachments the post actually sent are surfaced on the message",
  );
});
