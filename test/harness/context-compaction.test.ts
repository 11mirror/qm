import { countTokens } from "../../src/util/tokens.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compactTranscript,
  INTERRUPTED_TOOL_RESULT,
  forModelContext,
  estimateItemTokens,
  overBudgetFraction,
  planCompaction,
} from "../../src/harness/context-compaction.ts";
import { storedItem, type Item, type NewItem } from "../../src/sessions/items.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { contextSummaryItem, type SessionStore } from "../../src/sessions/session-store.ts";
import { scopeId } from "../../src/types.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

function ent(item: NewItem, seq = 0, createdAt = 0): Item {
  return storedItem(item, { sessionId: "s", seq, createdAt });
}

const NOON = Date.UTC(2026, 6, 29, 12, 0);

test("compactTranscript marks an interrupted tool call (no recorded result) so the summarizer sees the gap", () => {
  const out = compactTranscript([
    ent({ kind: "UserMessage", text: "refresh the dashboard" }, 1),
    ent({ kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "bash refresh.sh" } }, 2),
    ent({ kind: "UserMessage", text: "(system note: the platform restarted mid-turn...)" }, 3),
  ]);
  assert.match(out, /ToolResult for ToolCall#2 \(none recorded\): \[system\] This call was interrupted/);
  assert.ok(out.includes(INTERRUPTED_TOOL_RESULT));
});

test("compactTranscript does NOT mark a tool call that has a recorded result", () => {
  const out = compactTranscript([
    ent({ kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "bash refresh.sh" } }, 1),
    ent({ kind: "ToolResult", tool: "execute", callId: "c1", text: "wrote inv=89", isError: false }, 2),
  ]);
  assert.doesNotMatch(out, /interrupted/);
  assert.match(out, /wrote inv=89/);
});

test("compactTranscript labels overheard entries by author and keeps a file-only one's caption", () => {
  const out = compactTranscript([
    ent(
      { kind: "UserMessage", externalId: "1", text: "I posted a chart", body: { overheard: true, name: "Alice" } },
      1,
    ),
    ent(
      { kind: "UserMessage", externalId: "2", text: "", body: { overheard: true, name: "Bob", files: ["selfie.jpg"] } },
      2,
    ),
    ent({ kind: "UserMessage", text: "whose selfie is that?" }, 3),
  ]);
  assert.match(out, /overheard#1 \(Alice\): I posted a chart/);
  assert.match(out, /overheard#2 \(Bob\): \(shared file\) \(files: selfie\.jpg\)/);
  assert.match(out, /UserMessage#3: whose selfie is that\?/);
});

test("compactTranscript fits the summarizer's token budget by cutting the longest entries' middles first, hoisting isError out of the JSON", () => {
  const rows = Array.from({ length: 20_000 }, (_, i) => `row ${i} ok`).join("\n");
  const out = compactTranscript(
    [
      ent(
        {
          kind: "ToolResult",
          tool: "execute",
          callId: "c1",
          isError: true,
          text: "tail: [exit 1]",
          body: { stdout: rows },
        },
        1,
      ),
      ent({ kind: "UserMessage", text: "short question" }, 2),
    ],
    2_000,
  );
  assert.ok(countTokens(out) <= 2_000, `transcript stays within the budget (got ${countTokens(out)} tokens)`);
  assert.ok(out.includes("…[truncated —"), "truncation is marked with how much was cut");
  assert.ok(out.startsWith("ToolResult#1: [isError]"), "failure status survives regardless of JSONB key order");
  assert.ok(out.includes("[exit 1]"), "the payload tail survives the cut");
  assert.ok(out.endsWith("UserMessage#2: short question"), "short entries are left whole");
});

test("compactTranscript without a budget leaves every entry whole", () => {
  const out = compactTranscript([ent({ kind: "UserMessage", text: `start ${"x".repeat(900_000)} end` }, 1)]);
  assert.equal(out, `UserMessage#1: start ${"x".repeat(900_000)} end`);
});

test("compactTranscript fits a giant prior-summary line and a giant overheard file list into the budget", () => {
  const out = compactTranscript(
    [
      ent(
        { kind: "ContextCompaction", throughSeq: 3, text: Array.from({ length: 30_000 }, (_, i) => `s${i}`).join(" ") },
        1,
      ),
      ent(
        {
          kind: "UserMessage",
          text: "hi",
          body: { overheard: true, name: "ada", files: Array.from({ length: 5_000 }, (_, i) => `file-${i}.txt`) },
        },
        2,
      ),
    ],
    3_000,
  );
  assert.ok(countTokens(out) <= 3_000, `every line fits the budget together (got ${countTokens(out)} tokens)`);
  assert.match(out, /Prior summary through seq 3: s0 /);
  assert.match(out, /overheard#2 \(ada\): hi \(files: file-0\.txt/);
});

test("compactTranscript stamps every line with its entry's UTC timestamp", () => {
  const out = compactTranscript([
    ent({ kind: "UserMessage", text: "refresh the dashboard", body: { name: "sam" } }, 1, NOON),
    ent({ kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "bash refresh.sh" } }, 2, NOON + 60_000),
    ent({ kind: "ToolResult", tool: "execute", callId: "c1", text: "ok", isError: false }, 3, NOON + 120_000),
    ent(
      { kind: "UserMessage", externalId: "1", text: "lunch?", body: { overheard: true, name: "Bob" } },
      4,
      NOON + 180_000,
    ),
  ]);
  assert.match(out, /^UserMessage#1 2026-07-29T12:00Z \(sam\): refresh the dashboard$/m);
  assert.match(out, /^ToolCall#2 2026-07-29T12:01Z: /m);
  assert.match(out, /^ToolResult#3 2026-07-29T12:02Z: /m);
  assert.match(out, /^overheard#4 2026-07-29T12:03Z \(Bob\): lunch\?$/m);
});

test("compactTranscript stamps a chained prior summary with when it was written", () => {
  const out = compactTranscript([ent({ kind: "ContextCompaction", throughSeq: 21, text: "earlier work" }, 22, NOON)]);
  assert.equal(out, "Prior summary through seq 21 (written 2026-07-29T12:00Z): earlier work");
});

test("compactTranscript omits the stamp when an entry has no real timestamp", () => {
  const out = compactTranscript([
    ent({ kind: "UserMessage", text: "hello" }, 1, 0),
    ent({ kind: "UserMessage", text: "again" }, 2, Number.NaN),
  ]);
  assert.match(out, /^UserMessage#1: hello$/m);
  assert.match(out, /^UserMessage#2: again$/m);
});

test("a tool_result marked interrupted still leaves its call reported as interrupted in the compaction transcript", () => {
  const out = compactTranscript([
    ent({ kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "make" } }, 1, 1),
    ent({ kind: "ToolResult", callId: "c1", text: "[exit 143]", body: { interrupted: true } }, 2, 2),
  ]);
  assert.ok(out.includes(`ToolResult for ToolCall#1 (none recorded): ${INTERRUPTED_TOOL_RESULT}`));
});

const URL = process.env.DATABASE_URL;
const pgSkip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres context-window tests";

async function seed(store: SessionStore, threadRef: string) {
  const scope = scopeId("channel", "C1");
  const s = await store.getOrCreateByThread(threadRef, "channel", scope);
  const { lease } = await store.acquireLease(s.id);
  const add = (item: NewItem) => store.append(lease!, item);
  await add({ kind: "UserMessage", text: "ancient one" });
  await add({ kind: "UserMessage", text: "ancient two" });
  await add(contextSummaryItem(0, "stale summary"));
  await add({ kind: "UserMessage", text: "middle" });
  const fresh = await add(contextSummaryItem(3, "fresh summary"));
  await add({ kind: "UserMessage", text: "recent one" });
  await add({ kind: "AgentMessage", text: "recent two" });
  await store.releaseLease(lease!);
  return { session: s, freshSummarySeq: fresh.seq };
}

async function exerciseWindow(store: SessionStore, threadRef: string) {
  const { session, freshSummarySeq } = await seed(store, threadRef);
  const window = await store.getContextWindow(session.id);

  assert.equal(window.totalItems, 7, "full count preserved for guards");
  assert.deepEqual(
    window.items.map((e) => e.seq),
    [freshSummarySeq, freshSummarySeq + 1, freshSummarySeq + 2],
    "window = latest summary + everything after its throughSeq",
  );

  const full = await store.getItems(session.id);
  assert.deepEqual(
    forModelContext(window.items),
    forModelContext(full),
    "model context built from the window is identical to one built from the full history",
  );

  const untouched = await store.getOrCreateByThread(`${threadRef}-empty`, "channel", scopeId("channel", "C1"));
  const empty = await store.getContextWindow(untouched.id);
  assert.deepEqual(empty, { items: [], totalItems: 0 });
}

test("session store: context window slices at the latest summary and keeps guards whole-history", async () => {
  await exerciseWindow(createPostgresSessionStore(testDatabaseUrl()), "ch:C1:mem");
});

test("session store: sessions without a summary return the full history", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("channel", "C1");
  const s = await store.getOrCreateByThread("ch:C1:nosummary", "channel", scope);
  const { lease } = await store.acquireLease(s.id);
  await store.append(lease!, { kind: "UserMessage", text: "a" });
  await store.append(lease!, { kind: "AgentMessage", text: "b" });
  const window = await store.getContextWindow(s.id);
  assert.equal(window.items.length, 2);
  assert.equal(window.totalItems, 2);
});

test(
  "postgres store: a payload merely mentioning context_summary text is not treated as a summary",
  { skip: pgSkip },
  async () => {
    const store = createPostgresSessionStore(URL!);
    const scope = scopeId("channel", "C1");
    const s = await store.getOrCreateByThread(`ch:C1:pg-decoy-${Date.now()}`, "channel", scope);
    const { lease } = await store.acquireLease(s.id);
    await store.append(lease!, { kind: "UserMessage", text: "first" });
    await store.append(lease!, {
      kind: "ContextCompaction",
      body: { note: "shape is wrong: no throughSeq/text" },
    });
    await store.append(lease!, {
      kind: "UserMessage",
      text: 'quoting "kind":"ContextCompaction" in chat',
    });
    const window = await store.getContextWindow(s.id);
    assert.equal(window.items.length, 3, "decoys fall back to the full history, never a wrong slice");
    assert.equal(window.totalItems, 3);
  },
);

let seq = 0;
function entry(kind: "UserMessage" | "AgentMessage", body: { text: string } & Record<string, unknown>): Item {
  seq += 1;
  const { text, ...rest } = body;
  return storedItem({ kind, text, body: rest }, { sessionId: "budget", seq, createdAt: seq });
}

const pdf = (name: string, artifactId: string, sizeBytes = 1_000_000) => ({
  name,
  mimetype: "application/pdf",
  sizeBytes,
  direction: "in" as const,
  artifactId,
});

test("a user entry's document attachments count at their expanded size", () => {
  const plain = entry("UserMessage", { text: "please review" });
  const withPdf = entry("UserMessage", { text: "please review", attachments: [pdf("contract.pdf", "f1")] });
  assert.ok(estimateItemTokens(withPdf) - estimateItemTokens(plain) >= 250_000);
  const outbound = entry("UserMessage", {
    text: "please review",
    attachments: [{ ...pdf("contract.pdf", "f1"), direction: "out" }],
  });
  assert.equal(estimateItemTokens(outbound), estimateItemTokens(plain));
});

test("history that is small in words but carries large PDFs compacts them out of the kept window", () => {
  const budget = 1_000_000;
  const history = [
    entry("UserMessage", { text: "here are the agreements", attachments: [pdf("a.pdf", "fa"), pdf("b.pdf", "fb")] }),
    entry("AgentMessage", { text: "Read both." }),
    entry("UserMessage", { text: "and the amendment", attachments: [pdf("c.pdf", "fc")] }),
    entry("AgentMessage", { text: "Read it." }),
    entry("UserMessage", { text: "and the exhibits", attachments: [pdf("d.pdf", "fd"), pdf("e.pdf", "fe")] }),
    entry("AgentMessage", { text: "Read them." }),
  ];
  assert.ok(overBudgetFraction(history, budget, 0.9), "five 1MB PDFs no longer look like a few hundred tokens");
  const plan = planCompaction(history, budget, 0.6);
  assert.ok(plan);
  const kept = plan.kept.reduce((sum, item) => sum + estimateItemTokens(item), 0);
  assert.ok(kept <= budget * 0.6, `kept ~${kept} tokens`);
  assert.match(compactTranscript(plan.toSummarize), /a\.pdf \[file fa\]/);
});

test("compaction input names each compacted document and its saved file", () => {
  const transcript = compactTranscript([
    entry("UserMessage", { text: "review these", attachments: [pdf("a.pdf", "fa"), pdf("b.pdf", "fb")] }),
    entry("AgentMessage", { text: "Done." }),
  ]);
  assert.match(transcript, /review these \(files: a\.pdf \[file fa\], b\.pdf \[file fb\]\)/);
});
