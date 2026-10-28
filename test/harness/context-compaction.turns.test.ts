import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPACT_HARD_FRACTION,
  COMPACT_SOFT_FRACTION,
  validateCompactSummary,
  compactSummaryTokenBudget,
  compactTranscript,
  estimateHistoryTokens,
  forModelContext,
  overBudgetFraction,
  planCompaction,
} from "../../src/harness/context-compaction.ts";
import { countTokens } from "../../src/util/tokens.ts";
import type { Harness, HarnessCompactInput } from "../../src/harness/harness.ts";
import { contextSummary, contextSummaryItem } from "../../src/sessions/session-store.ts";
import { storedItem, type Item, type NewItem } from "../../src/sessions/items.ts";
import {
  tokensOf,
  msgTexts,
  budgetBetweenSoftAndHard,
  budgetKeepingOnlyNewest,
  spyHarness,
  buildOrchestrator,
  type Seed,
  seed,
  turn,
  spineTurn,
  summaryEntries,
  waitForSummary,
  waitForLeaseRelease,
} from "../support/context-compaction.ts";

test("overflow over the injected token budget summarizes: compactHistory runs over the oldest entries, a summary is appended, the session resets, the rebuilt context is bounded", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetKeepingOnlyNewest("msg 4", "msg 5"));

  const sid = await seed(
    sessions,
    msgTexts(6).map((text) => ({ text })),
  );

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  assert.ok(compactCalls.length >= 1, "compactHistory should be called on overflow");
  const summarized = compactCalls[0]!.history;
  assert.deepEqual(
    summarized.map((e) => e.seq),
    [0, 1, 2, 3, 4],
    "should summarize the oldest entries past the keep-recent budget",
  );

  const summaries = await summaryEntries(sessions, sid);
  assert.equal(contextSummary(summaries[0]!)!.throughSeq, 4, "summary throughSeq must advance to seq 4");

  assert.equal(res.reply, "history:2", "rebuilt context is [summary, keep-recent…]");
});

test("the background pass labels the lease it takes, so a turn it locks out can name what beat it", async () => {
  const { harness } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetKeepingOnlyNewest("msg 4", "msg 5"));
  const holders: Array<string | undefined> = [];
  const acquire = sessions.acquireLease.bind(sessions);
  sessions.acquireLease = async (sessionId, holder) => {
    holders.push(holder);
    return acquire(sessionId, holder);
  };

  const sid = await seed(
    sessions,
    msgTexts(6).map((text) => ({ text })),
  );
  assert.equal((await orch.handleTurn(turn("!histcount"))).status, "ok");

  const deadline = Date.now() + 3_000;
  while (!holders.includes("compaction") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(
    holders.includes("compaction"),
    "the post-turn background pass takes the lock as compaction, not as a turn",
  );
  assert.ok(holders.includes("turn"), "…and the turn itself takes it as a turn");
  await waitForLeaseRelease(sessions, sid);
});

test("token overflow triggers compaction with only a few huge entries", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, 50);

  const big = "many different tokens here ".repeat(25);
  const sid = await seed(
    sessions,
    Array.from({ length: 4 }, (_, i) => ({ text: `${big} ${i}` })),
  );

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  assert.ok(compactCalls.length >= 1, "token overflow must trigger compaction despite the low entry count");
  const summaries = await summaryEntries(sessions, sid);
  assert.ok(summaries.length >= 1, "a summary entry is written");
  assert.ok(
    compactCalls[0]!.history.length >= 1 && compactCalls[0]!.history.length < 4,
    "the oldest entries (not all, not none) are summarized; the newest turn stays verbatim",
  );
});

test("a prior summary that still fits is reused, not regenerated", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, 1_000_000);

  const sid = await seed(sessions, [
    { text: "old 0" },
    { text: "old 1" },
    { text: "old 2" },
    { text: "old 3" },
    contextSummaryItem(3, "prior summary"),
    { text: "new 5" },
  ]);

  const before = await summaryEntries(sessions, sid);
  assert.equal(before.length, 1, "fixture seeds exactly one summary");

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  assert.ok(
    compactCalls.every((c) => c.history.some((e) => e.seq >= 6)),
    "an already-fitting summary must be reused on the hot path, not regenerated",
  );

  assert.equal(res.reply, "history:2", "reuse returns [summary, recent raw…]");
});

test("with no harness summarizer, overflow falls back to a plain slice — no summary entry written", async () => {
  const { harness, compactCalls } = spyHarness({ withSummarizer: false });
  assert.equal(harness.models.compactHistory, undefined, "fixture: summarizer is absent");
  const { orch, sessions } = buildOrchestrator(harness, tokensOf("msg 2", "msg 3", "msg 4", "msg 5"));

  const sid = await seed(
    sessions,
    msgTexts(6).map((text) => ({ text })),
  );

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  assert.equal(compactCalls.length, 0, "no summarizer → compactHistory never called");
  const summaries = await summaryEntries(sessions, sid);
  assert.equal(summaries.length, 0, "fallback must NOT write a summary entry");
  assert.equal(res.reply, "history:4", "fallback returns the newest entries that fit the token budget");
});

test("a tool_call at the summarize/keep boundary whose result is KEPT is not summarized as interrupted", async () => {
  const { harness, compactCalls } = spyHarness();
  const call = at(4, { kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "bash refresh.sh" } });
  const result = at(5, { kind: "ToolResult", tool: "execute", callId: "c1", text: "wrote inv=89", isError: false });
  const { orch, sessions } = buildOrchestrator(harness, estimateHistoryTokens([call, result]));

  const sid = await seed(sessions, [
    { text: "msg 0" },
    { text: "msg 1" },
    { text: "msg 2" },
    { text: "msg 3" },
    { kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "bash refresh.sh" } },
    { kind: "ToolResult", tool: "execute", callId: "c1", text: "wrote inv=89", isError: false },
  ]);

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  assert.ok(compactCalls.length >= 1, "overflow should still trigger the inline compaction");
  assert.deepEqual(
    compactCalls[0]!.history.map((e) => e.seq),
    [0, 1, 2, 3],
    "the boundary tool_call (seq 4) must be held back with its kept result, not summarized",
  );
  const summaries = await summaryEntries(sessions, sid);
  assert.doesNotMatch(contextSummary(summaries[0]!)!.text, /interrupted/, "no false interrupted marker");
});

test("a genuinely interrupted tool_call (no result anywhere) IS marked interrupted in the summarizer's transcript", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetKeepingOnlyNewest("msg 4", "msg 5"));

  const sid = await seed(sessions, [
    { kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "bash refresh.sh" } },
    { text: "(system note: the platform restarted mid-turn...)" },
    { text: "msg 2" },
    { text: "msg 3" },
    { text: "msg 4" },
    { text: "msg 5" },
  ]);

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");

  assert.ok((await summaryEntries(sessions, sid)).length >= 1);
  assert.match(
    compactTranscript(compactCalls[0]!.history),
    /interrupted/,
    "interrupted call must be flagged, not invented",
  );
});

const at = (seq: number, item: NewItem): Item => storedItem(item, { sessionId: "s", seq, createdAt: seq });
const mkEntry = (over: Partial<Item> & { seq: number }): Item =>
  ({ ...at(over.seq, { kind: "UserMessage", text: `msg ${over.seq}` }), ...over }) as Item;

test("entry count alone never triggers compaction: hundreds of tiny entries under the token budget stay uncompacted", () => {
  const history = Array.from({ length: 500 }, (_, i) => mkEntry({ seq: i, text: `tiny ${i}` }));
  const budget = estimateHistoryTokens(history) * 4;
  assert.equal(overBudgetFraction(history, budget, COMPACT_SOFT_FRACTION), false);
  assert.equal(planCompaction(history, budget, 0.6), null);
});

for (const [kind, mkTurn] of [
  ["spine", spineTurn],
  ["DM", turn],
] as const) {
  test(`a ${kind} turn between soft and hard does NOT block on compaction; the background pass sheds it`, async () => {
    const { harness, compactCalls } = spyHarness();
    const budget = budgetBetweenSoftAndHard(tokensOf(...msgTexts(8)));
    const { orch, sessions } = buildOrchestrator(harness, budget);
    const sid = await seed(
      sessions,
      msgTexts(8).map((text) => ({ text })),
    );

    const res = await orch.handleTurn(mkTurn("!histcount"));
    assert.equal(res.status, "ok");
    assert.equal(res.reply, "history:8", "under the hard limit the turn runs on raw history, unblocked");

    const summaries = await waitForSummary(sessions, sid);
    assert.equal(summaries.length, 1, "the background pass compacts off the hot path");
    assert.equal(compactCalls.length, 1, "exactly one (background) compaction, none inline");
    assert.equal(
      compactCalls[0]!.summaryTokenBudget,
      compactSummaryTokenBudget(budget),
      "the summarizer is handed the summary's share of this session's context budget",
    );
  });
}

test("a model-overridden session's background pass sizes against the override's budget, not the scope default", async () => {
  const { harness, compactCalls } = spyHarness();
  const OVERRIDE = "tiny-context-model";
  const overrideBudget = budgetBetweenSoftAndHard(tokensOf(...msgTexts(8)));
  harness.models.contextTokenBudget = (_scopeLabel?: string, model?: string) =>
    model === OVERRIDE ? overrideBudget : 1_000_000;
  const { orch, sessions } = buildOrchestrator(harness);
  const sid = await seed(
    sessions,
    msgTexts(8).map((text) => ({ text })),
  );

  const res = await orch.handleTurn({ ...turn("!histcount"), model: OVERRIDE });
  assert.equal(res.status, "ok");
  assert.equal(res.reply, "history:8", "between soft and hard for the override ⇒ the turn itself is unblocked");

  const summaries = await waitForSummary(sessions, sid);
  assert.equal(
    summaries.length,
    1,
    "the background pass judges fullness by the override model's budget — under the scope default it would never fire",
  );
  assert.equal(compactCalls.length, 1, "exactly one background compaction against the override's budget");
});

test("a rapid follow-up that outran the background pass AND is over the HARD limit blocks and compacts inline", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, Math.floor(tokensOf(...msgTexts(8)) * COMPACT_HARD_FRACTION));
  await seed(
    sessions,
    msgTexts(8).map((text) => ({ text })),
  );

  const res = await orch.handleTurn(spineTurn("!histcount"));
  assert.equal(res.status, "ok");
  assert.ok(compactCalls.length >= 1, "over the hard limit ⇒ inline (blocking) compaction ran");
  assert.notEqual(res.reply, "history:8", "the turn did NOT see the full raw history — it was compacted first");
});

test("a session UNDER the soft threshold triggers no compaction at all (background pass is a no-op)", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, 1_000_000);
  await seed(
    sessions,
    Array.from({ length: 3 }, (_, i) => ({ text: `msg ${i}` })),
  );

  const res = await orch.handleTurn(spineTurn("!histcount"));
  assert.equal(res.reply, "history:3", "under soft ⇒ the turn runs on raw history, no inline compaction");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(compactCalls.length, 0, "nothing over soft ⇒ no compaction, foreground or background");
});

test("a DM follow-up after the background pass reuses the summary — no blocking summarizer call on its hot path", async () => {
  const { harness, compactCalls } = spyHarness();
  harness.models.compactHistory = async (input: HarnessCompactInput) => {
    compactCalls.push(input);
    return "tiny recap";
  };
  const messages = msgTexts(8).map((text) => `${text} ${"history ".repeat(1000)}`);
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...messages)));
  const sid = await seed(
    sessions,
    messages.map((text) => ({ text })),
  );

  await orch.handleTurn(turn("!histcount"));
  assert.equal((await waitForSummary(sessions, sid)).length, 1, "the background pass ran after the first DM turn");
  assert.equal(compactCalls.length, 1);
  await waitForLeaseRelease(sessions, sid);

  const expectedHistory = forModelContext(await sessions.getItems(sid));
  assert.ok(expectedHistory.some((entry) => contextSummary(entry)));
  assert.ok(expectedHistory.some((entry) => entry.kind === "UserMessage"));
  delete harness.models.compactHistory;
  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");
  assert.equal(
    res.reply,
    `history:${expectedHistory.length}`,
    "the follow-up starts on [summary, recent…] with no summarizer call",
  );
});

test("forModelContext strips thinking/text (never laundered into a durable summary)", () => {
  const entries: Item[] = [
    mkEntry({ seq: 0 }),
    at(1, { kind: "Reasoning", text: "secret reasoning" }),
    at(2, { kind: "AgentMessage", variant: "narration", text: "scaffold" }),
    at(4, { kind: "AgentMessage", text: "msg 4" }),
  ];
  assert.deepEqual(
    forModelContext(entries).map((e) => e.kind),
    ["UserMessage", "AgentMessage"],
  );
});

test("background compaction excludes thinking entries from the summary batch (Bugbot: history filter)", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(8))));
  const sid = await seed(sessions, [
    ...msgTexts(8).map((text) => ({ text })),
    { kind: "Reasoning", text: "signature-less reasoning" },
  ]);

  const res = await orch.handleTurn(spineTurn("!histcount"));
  assert.equal(res.status, "ok");
  const summaries = await waitForSummary(sessions, sid);
  assert.equal(summaries.length, 1, "a background compaction ran");
  assert.equal(compactCalls.length, 1);
  assert.ok(
    compactCalls[0]!.history.every((e) => e.kind !== "Reasoning"),
    "the summarizer batch must not include the durable thinking entry",
  );
});

test("a session parked over soft with a too-large prior summary re-summarizes (Bugbot: reuse-parked)", async () => {
  const { harness, compactCalls } = spyHarness();
  const { orch, sessions } = buildOrchestrator(
    harness,
    budgetBetweenSoftAndHard(tokensOf("prior recap", ...msgTexts(8))),
  );
  await seed(sessions, [contextSummaryItem(-1, "prior recap"), ...msgTexts(8).map((text) => ({ text }))]);

  const res = await orch.handleTurn(spineTurn("!histcount"));
  assert.equal(res.status, "ok");
  for (let i = 0; i < 300 && compactCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(compactCalls.length, 1, "over soft with an unfitting prior summary ⇒ re-summarize, not park");
  assert.ok(
    compactCalls[0]!.history.some((e) => contextSummary(e)),
    "the prior summary is chained into the new batch",
  );
});

test("validateCompactSummary accepts a trimmed summary and rejects missing output or one over the budget it was asked to fit", () => {
  assert.equal(validateCompactSummary("  a tidy summary  "), "a tidy summary");
  assert.throws(() => validateCompactSummary(undefined), /empty summary/);
  assert.throws(() => validateCompactSummary("   "), /empty summary/);
  const long = Array.from({ length: 400 }, (_, i) => `point ${i}`).join(", ");
  assert.throws(() => validateCompactSummary(long, 100), /is \d+ tokens; the budget it was asked to fit is 100/);
  assert.equal(validateCompactSummary(long, 10_000), long);
  assert.equal(validateCompactSummary(long), long);
});

test("a summarizer that rejects its own output does not commit a compaction checkpoint", async () => {
  const { harness } = spyHarness();
  harness.models.compactHistory = async () =>
    validateCompactSummary("I'll scan for new signed replies… ".repeat(2_000), 8_000);
  const { orch, sessions, errors } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(12))));
  const sid = await seed(
    sessions,
    msgTexts(12).map((text) => ({ text })),
  );

  const res = await orch.handleTurn(spineTurn("!histcount"));
  assert.equal(res.status, "ok");

  const deadline = Date.now() + 3_000;
  while (!(await errors.list({ sessionId: sid })).some((error) => error.code === "background_compaction_failed")) {
    assert.ok(Date.now() < deadline, "background compaction never reported failure");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await summaryEntries(sessions, sid)).length, 0);
});

function assertSummaryBoundary(history: Item[], label: string): void {
  const summaries = history.filter((e) => contextSummary(e));
  assert.ok(summaries.length <= 1, `${label}: at most one summary in the model context (got ${summaries.length})`);
  if (!summaries.length) return;
  const through = contextSummary(summaries[0]!)!.throughSeq;
  for (const e of history) {
    if (contextSummary(e)) continue;
    assert.ok(e.seq > through, `${label}: entry seq ${e.seq} is covered by the summary (throughSeq ${through})`);
  }
}

function captureHarness(harness: Harness) {
  const seen: Item[][] = [];
  const wrapped: Harness = {
    ...harness,
    turns: {
      ...harness.turns,
      runTurn: (input) => {
        seen.push(input.history);
        return harness.turns.runTurn(input);
      },
    },
  };
  return { wrapped, seen };
}

const stackedLog = (): Seed[] => [
  ...Array.from({ length: 4 }, (_, i) => ({ text: `old ${i}` })),
  contextSummaryItem(3, "recap A"),
  ...Array.from({ length: 3 }, (_, i) => ({ text: `mid ${i}` })),
  contextSummaryItem(7, "recap B"),
  ...Array.from({ length: 2 }, (_, i) => ({ text: `new ${i}` })),
];

test("under-HARD turn: the harness sees the boundary-filtered context, not stacked summaries over raw history", async () => {
  const base = spyHarness();
  const { wrapped, seen } = captureHarness(base.harness);
  const { orch, sessions } = buildOrchestrator(wrapped, 1_000_000);
  await seed(sessions, stackedLog());

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");
  assert.equal(seen.length, 1);
  assertSummaryBoundary(seen[0]!, "under-hard");
  assert.equal(res.reply, "history:3", "summary B + the 2 uncovered entries only");
});

test("over-HARD turn with NO summarizer (boundRecent fallback): the boundary still holds and the summary survives the slice", async () => {
  const base = spyHarness({ withSummarizer: false });
  const { wrapped, seen } = captureHarness(base.harness);
  const { orch, sessions } = buildOrchestrator(wrapped, budgetKeepingOnlyNewest("recap B", "new 1"));
  await seed(sessions, stackedLog());

  const res = await orch.handleTurn(turn("!histcount"));
  assert.equal(res.status, "ok");
  assert.equal(seen.length, 1);
  assertSummaryBoundary(seen[0]!, "boundRecent fallback");
  assert.ok(
    seen[0]!.some((e) => contextSummary(e)),
    "the bounding slice must keep the latest summary",
  );
});

test("the context window start never regresses as the log grows", () => {
  const entries: Item[] = [];
  const add = (item: NewItem) => {
    entries.push(at(entries.length, item));
  };
  let prevStart = -1;
  const startOf = (view: Item[]): number => {
    const summary = view.find((e) => contextSummary(e));
    return summary ? contextSummary(summary)!.throughSeq + 1 : (view[0]?.seq ?? 0);
  };
  for (let i = 0; i < 30; i++) {
    add({ kind: "UserMessage", text: `msg ${i}` });
    if (i === 10) add(contextSummaryItem(8, "recap 1"));
    if (i === 20) add(contextSummaryItem(17, "recap 2"));
    const start = startOf(forModelContext(entries));
    assert.ok(start >= prevStart, `window start regressed at i=${i}: ${prevStart} -> ${start}`);
    prevStart = start;
  }
});

function gatedHarness() {
  const { harness, compactCalls } = spyHarness();
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  const summarize = harness.models.compactHistory!;
  harness.models.compactHistory = async (input: HarnessCompactInput) => {
    const text = await summarize(input);
    await gate;
    return text;
  };
  return { harness, compactCalls, open };
}

async function untilTrue(what: string, predicate: () => boolean, deadlineMs = 3_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("the background pass leaves the session writable while it summarizes — a follow-up turn is never locked out", async () => {
  const { harness, compactCalls, open } = gatedHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(8))));
  const sid = await seed(
    sessions,
    msgTexts(8).map((text) => ({ text })),
  );

  assert.equal((await orch.handleTurn(turn("!histcount"))).reply, "history:8");
  await untilTrue("the background summarizer to be in flight", () => compactCalls.length === 1);

  const { lease } = await sessions.acquireLease(sid, "turn");
  assert.ok(lease, "background compaction must not hold the write-lock across its model call");
  await sessions.releaseLease(lease!);

  open();
  assert.equal((await waitForSummary(sessions, sid)).length, 1, "and the summary still lands afterwards");
});

test("the background pass summarizes first and requests its lease only after the summarizer returns", async () => {
  const { harness, compactCalls, open } = gatedHarness();
  const events: string[] = [];
  const gated = harness.models.compactHistory!;
  harness.models.compactHistory = async (input: HarnessCompactInput) => {
    events.push("summarize:start");
    const text = await gated(input);
    events.push("summarize:end");
    return text;
  };
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(8))));
  const acquire = sessions.acquireLease.bind(sessions);
  sessions.acquireLease = async (sessionId, holder) => {
    if (holder === "compaction") events.push("acquire:compaction");
    return acquire(sessionId, holder);
  };
  const sid = await seed(
    sessions,
    msgTexts(8).map((text) => ({ text })),
  );

  assert.equal((await orch.handleTurn(turn("!histcount"))).reply, "history:8");
  await untilTrue("the background summarizer to be in flight", () => events.includes("summarize:start"));

  assert.ok(
    !events.includes("acquire:compaction"),
    `the pass must not request the session lease before the summarizer has returned (saw ${events.join(" → ")})`,
  );
  const { lease: probe } = await sessions.acquireLease(sid, "turn");
  assert.ok(probe, "the session lease stays free for the whole summarization call");
  await sessions.releaseLease(probe!);

  open();
  assert.equal((await waitForSummary(sessions, sid)).length, 1, "the summary lands once the lease is taken");
  assert.ok(
    events.indexOf("acquire:compaction") > events.indexOf("summarize:end"),
    `the compaction lease must be requested strictly after the summarizer returns (saw ${events.join(" → ")})`,
  );
  assert.equal(compactCalls.length, 1, "and the model was called exactly once");
});

test("the background pass waits out a turn that holds the lock rather than throwing its summary away", async () => {
  const { harness, compactCalls, open } = gatedHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(8))));
  const sid = await seed(
    sessions,
    msgTexts(8).map((text) => ({ text })),
  );

  assert.equal((await orch.handleTurn(turn("!histcount"))).reply, "history:8");
  await untilTrue("the background summarizer to be in flight", () => compactCalls.length === 1);

  const { lease: held } = await sessions.acquireLease(sid, "turn");
  assert.ok(held);
  open();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await summaryEntries(sessions, sid)).length, 0, "the pass wrote nothing behind the turn's back");

  await sessions.releaseLease(held!);
  assert.equal((await waitForSummary(sessions, sid)).length, 1, "the summary lands once the turn is done");
  assert.equal(compactCalls.length, 1, "and the model was called exactly once for it");
});

test("a turn landing mid-summarization does not disturb the fold: it covers a prefix, the turn's entries stay", async () => {
  const { harness, compactCalls, open } = gatedHarness();
  const paddedTexts = Array.from({ length: 15 }, (_, i) => `msg ${i} ${"padding ".repeat(1000)}`);
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...paddedTexts)));
  const sid = await seed(
    sessions,
    paddedTexts.map((text) => ({ text })),
  );

  assert.equal((await orch.handleTurn(turn("!histcount"))).reply, "history:15");
  await untilTrue("the background summarizer to be in flight", () => compactCalls.length === 1);
  const beforeTurn = ((await sessions.getItems(sid)).at(-1)?.seq ?? -1) + 1;

  assert.equal((await orch.handleTurn(turn("!histcount"))).status, "ok");
  const appended = (await sessions.getItems(sid)).filter((e) => e.seq >= beforeTurn);
  assert.ok(appended.length > 0, "the turn really did write while the summarizer was parked");

  open();
  const summaries = await waitForSummary(sessions, sid);
  assert.ok(summaries.length >= 1);
  const throughSeq = contextSummary(summaries[0]!)!.throughSeq;
  assert.ok(
    throughSeq < appended[0]!.seq,
    `the fold covers only the prefix it summarized (through ${throughSeq}, turn started at ${appended[0]!.seq})`,
  );
  const survivors = await sessions.getItems(sid);
  for (const entry of appended) {
    assert.ok(
      survivors.some((e) => e.seq === entry.seq),
      `the turn's entry ${entry.seq} survived the fold`,
    );
  }
});

test("a summary that landed while the pass was summarizing makes it drop its own — never two overlapping folds", async () => {
  const { harness, compactCalls, open } = gatedHarness();
  const { orch, sessions } = buildOrchestrator(harness, budgetBetweenSoftAndHard(tokensOf(...msgTexts(8))));
  const sid = await seed(
    sessions,
    msgTexts(8).map((text) => ({ text })),
  );

  assert.equal((await orch.handleTurn(turn("!histcount"))).reply, "history:8");
  await untilTrue("the background summarizer to be in flight", () => compactCalls.length === 1);

  const { lease: rival } = await sessions.acquireLease(sid, "compaction");
  assert.ok(rival);
  await sessions.append(rival!, contextSummaryItem(6, "a rival fold"));
  await sessions.releaseLease(rival!);

  open();
  await new Promise((r) => setTimeout(r, 300));
  const summaries = await summaryEntries(sessions, sid);
  assert.equal(summaries.length, 1, "only the rival fold — the stale one was dropped");
  assert.equal(contextSummary(summaries[0]!)?.text, "a rival fold");
});

test("the token estimate counts the environment note persisted on a user entry", () => {
  const environment = `<environment>\n${"## What you remember\nlikes terse replies. ".repeat(40)}\n</environment>`;
  const bare = at(1, { kind: "UserMessage", text: "hi" });
  const withEnv = at(2, { kind: "UserMessage", text: "hi", body: { environment } });
  const delta = estimateHistoryTokens([withEnv]) - estimateHistoryTokens([bare]);
  assert.ok(delta >= countTokens(environment) * 0.9, `environment tokens must be counted (delta ${delta})`);
});
