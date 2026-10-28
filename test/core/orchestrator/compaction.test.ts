import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompaction } from "../../../src/core/orchestrator/compaction.ts";
import type { OrchestratorDeps } from "../../../src/core/orchestrator/types.ts";
import { estimateHistoryTokens, forModelContext } from "../../../src/harness/context-compaction.ts";
import { contextSummary, contextSummaryItem } from "../../../src/sessions/session-store.ts";
import { reconstructMessagesFromHistory } from "../../../src/harness/replay.ts";
import { countTokens } from "../../../src/util/tokens.ts";
import type { NewItem } from "../../../src/sessions/items.ts";
import { createPostgresSessionStore } from "../../../src/sessions/postgres-session-store.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../../support/test-database.ts";
import { inlineJobs } from "../../support/inline-jobs.ts";
import { createJobWorker } from "../../../src/jobs/job-worker.ts";
import { createGoalRecord } from "../../../src/harness/goal.ts";
import type { ScopeId } from "../../../src/types.ts";

async function fixture() {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread("recovery", "dm", "personal:test");
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  for (let i = 0; i < 12; i++)
    await sessions.append(lease, { kind: "UserMessage", text: `old message ${i} `.repeat(100) });
  const harness = {
    models: {
      compactHistory: async (): Promise<string> => {
        throw new Error("summary unavailable");
      },
    },
    turns: {},
  };
  const compaction = createCompaction({
    sessions,
    harness,
    maxContextTokens: 500,
    jobs: inlineJobs(),
  } as unknown as OrchestratorDeps);
  const input = {
    session,
    lease,
    visibleHistory: forModelContext((await sessions.getContextWindow(session.id)).items),
    scopeId: "personal:test",
    orgScopeId: "org:test",
    actorId: "test",
  };
  return { sessions, harness, compaction, input };
}

test("mandatory summarizer failure recovers instead of wedging the pending turn", async () => {
  const f = await fixture();
  try {
    const history = await f.compaction.compactContextIfNeeded(f.input);
    assert.ok(history.length < f.input.visibleHistory.length);
    assert.equal((await f.sessions.getItems(f.input.session.id)).length, f.input.visibleHistory.length + 1);
    assert.deepEqual(forModelContext((await f.sessions.getContextWindow(f.input.session.id)).items), history);
  } finally {
    await f.sessions.releaseLease(f.input.lease);
  }
});

async function refresh(f: Awaited<ReturnType<typeof fixture>>) {
  f.input.visibleHistory = forModelContext((await f.sessions.getContextWindow(f.input.session.id)).items);
}

test("recent recovery preserves a fitting saved summary without a model call", async () => {
  const f = await fixture();
  try {
    await f.sessions.append(f.input.lease, contextSummaryItem(11, "Saved work."));
    await f.sessions.append(f.input.lease, { kind: "UserMessage", text: "Continue verification." });
    await refresh(f);
    let calls = 0;
    f.harness.models.compactHistory = async () => {
      calls++;
      return "unexpected";
    };
    const before = await f.sessions.getItems(f.input.session.id);
    const history = await f.compaction.compactRecent(f.input);
    assert.equal(calls, 0);
    assert.match(contextSummary(history[0]!)!.text, /without a new summary/);
    assert.match(contextSummary(history[0]!)!.text, /Saved work/);
    assert.ok(estimateHistoryTokens(history) <= 300);
    const all = await f.sessions.getItems(f.input.session.id);
    assert.deepEqual(all.slice(0, before.length), before);
    assert.deepEqual(forModelContext((await f.sessions.getContextWindow(f.input.session.id)).items), history);
    assert.equal(history[0]!.body.mode, "recent");
  } finally {
    await f.sessions.releaseLease(f.input.lease);
  }
});

for (const failure of ["throw", "empty", "oversized"] as const) {
  test(`foreground ${failure} summary uses deterministic recovery`, async () => {
    const f = await fixture();
    try {
      f.harness.models.compactHistory = async () => {
        if (failure === "throw") throw new Error("provider refused");
        return failure === "empty" ? "" : "x".repeat(20000);
      };
      const history = await f.compaction.compactContextIfNeeded(f.input);
      assert.ok(estimateHistoryTokens(history) <= 300);
      assert.equal(history[0]!.body.mode, "recent");
    } finally {
      await f.sessions.releaseLease(f.input.lease);
    }
  });
}

for (const stage of ["before", "during", "abort-error"] as const) {
  test(`cancellation ${stage} cannot commit a recovery boundary`, async () => {
    const f = await fixture();
    const abort = new AbortController();
    try {
      if (stage === "before") abort.abort();
      f.harness.models.compactHistory = async () => {
        if (stage === "during") abort.abort();
        throw new DOMException("cancelled", "AbortError");
      };
      await assert.rejects(f.compaction.compactContextIfNeeded({ ...f.input, cancel: abort.signal }), {
        name: "AbortError",
      });
      assert.deepEqual(await f.sessions.getItems(f.input.session.id), f.input.visibleHistory);
    } finally {
      await f.sessions.releaseLease(f.input.lease);
    }
  });
}

for (const stage of ["append"] as const) {
  test(`${stage} failure is not swallowed or retried as summarization failure`, async () => {
    const f = await fixture();
    try {
      let calls = 0;
      f.harness.models.compactHistory = async () => {
        calls++;
        return "Summary.";
      };
      f.sessions[stage] = async () => {
        throw new Error("storage unavailable");
      };
      await assert.rejects(f.compaction.compactContextIfNeeded(f.input), /storage unavailable/);
      assert.equal(calls, 1);
      assert.ok(!(await f.sessions.getItems(f.input.session.id)).some((e) => e.body.mode === "recent"));
    } finally {
      await f.sessions.releaseLease(f.input.lease);
    }
  });
}

test("oversized entries and orphaned parallel tool results cannot bypass the recent budget", async () => {
  const f = await fixture();
  try {
    for (const item of [
      { kind: "ToolCall", callId: "large", tool: "files", body: { data: "oversized ".repeat(1000) } },
      { kind: "ToolCall", callId: "small", tool: "files" },
      { kind: "ToolResult", callId: "large", text: "ok" },
      { kind: "ToolResult", callId: "small", text: "ok" },
      { kind: "UserMessage", text: "Continue." },
    ] satisfies NewItem[])
      await f.sessions.append(f.input.lease, item);
    await refresh(f);
    const history = await f.compaction.compactRecent(f.input);
    assert.ok(estimateHistoryTokens(history) <= 300);
    assert.ok(!history.some((e) => e.kind === "ToolResult"));
    assert.equal(history.at(-1)!.kind, "UserMessage");
    await f.sessions.append(f.input.lease, { kind: "UserMessage", text: "oversized ".repeat(1000) });
    await refresh(f);
    const emptyTail = await f.compaction.compactRecent(f.input);
    assert.equal(emptyTail.length, 1);
    assert.deepEqual(forModelContext((await f.sessions.getContextWindow(f.input.session.id)).items), emptyTail);
  } finally {
    await f.sessions.releaseLease(f.input.lease);
  }
});

test("recent recovery drops an oversized request inside a completed turn", async () => {
  const f = await fixture();
  try {
    await f.sessions.append(f.input.lease, { kind: "UserMessage", text: "discarded oversized request ".repeat(1000) });
    const last = await f.sessions.append(f.input.lease, { kind: "AgentMessage", text: "The action is complete." });
    await refresh(f);
    const history = await f.compaction.compactRecent(f.input);
    assert.ok(countTokens(JSON.stringify(reconstructMessagesFromHistory(history))) < 500);
    assert.doesNotMatch(JSON.stringify(history), /discarded oversized request/);
    assert.equal(history.at(-1)!.seq, last.seq);
  } finally {
    await f.sessions.releaseLease(f.input.lease);
  }
});

const scope = "personal:goal@example.com" as ScopeId;

test("compaction leaves the session goal on its row and writes no goal entries", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread("goal", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  const goal = {
    ...createGoalRecord({ objective: "verify the result", floor: { minMs: 32_400_000 } }),
    tokensUsed: 1234,
  };
  await sessions.setGoal(lease, goal);
  for (let i = 0; i < 10; i++) {
    await sessions.append(lease, { kind: "UserMessage", text: `message ${i} `.repeat(100) });
  }
  const compaction = createCompaction({
    sessions,
    maxContextTokens: 400,
    harness: { models: { compactHistory: async () => "Earlier work." }, turns: {} },
    jobs: inlineJobs(),
  } as unknown as OrchestratorDeps);
  try {
    for (let round = 0; round < 2; round++) {
      const rebuilt = await compaction.compactContextIfNeeded({
        session,
        lease,
        visibleHistory: forModelContext((await sessions.getContextWindow(session.id)).items),
        scopeId: scope,
        orgScopeId: "org:test",
        actorId: "test",
      });
      assert.ok(rebuilt.some((item) => item.kind === "ContextCompaction"));
      await sessions.append(lease, { kind: "UserMessage", text: "more work ".repeat(1000) });
    }
  } finally {
    await sessions.releaseLease(lease);
  }
  const goalEntries = (await sessions.getItems(session.id)).filter((item) => item.body.kind === "goal");
  assert.equal(goalEntries.length, 0, "compaction does not copy goals into the log");
  assert.deepEqual((await sessions.goals([session.id])).get(session.id), goal);
});

test("background compaction cannot revive an older goal over one closed while it summarized", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread("goal-race", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  const goal = createGoalRecord({ objective: "verify the result" });
  await sessions.setGoal(lease, goal);
  for (let i = 0; i < 10; i++) {
    await sessions.append(lease, { kind: "UserMessage", text: `message ${i} `.repeat(100) });
  }
  await sessions.releaseLease(lease);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  const compaction = createCompaction({
    sessions,
    maxContextTokens: 400,
    harness: {
      models: {
        compactHistory: async () => {
          started.resolve();
          return finish.promise;
        },
      },
      turns: {},
    },
    jobs: inlineJobs(),
    advisoryLock: testAdvisoryLock(),
  } as unknown as OrchestratorDeps);
  compaction.scheduleBackgroundCompaction({
    sessionId: session.id,
    afterSeq: 0,
    scopeId: scope,
    orgScopeId: "org:test",
    actorId: "test",
  });
  await started.promise;
  const closing = (await sessions.acquireLease(session.id)).lease;
  assert.ok(closing);
  const closed = { ...goal, status: "complete" as const, updatedAt: goal.updatedAt + 1 };
  await sessions.setGoal(closing, closed);
  await sessions.releaseLease(closing);
  finish.resolve("Earlier work.");
  const deadline = Date.now() + 3000;
  while (!(await sessions.getItems(session.id)).some((item) => item.kind === "ContextCompaction")) {
    assert.ok(Date.now() < deadline, "background compaction did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual((await sessions.goals([session.id])).get(session.id), closed);
});

test("background compaction scheduled by a process that dies before running it still runs on the next one", async () => {
  const url = testDatabaseUrl();
  const sessions = createPostgresSessionStore(url);
  const session = await sessions.getOrCreateByThread("restart", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  for (let i = 0; i < 10; i++) {
    await sessions.append(lease, { kind: "UserMessage", text: `message ${i} `.repeat(100) });
  }
  await sessions.releaseLease(lease);
  const build = (compactHistory: () => Promise<string>) => {
    const jobs = createJobWorker(url);
    const compaction = createCompaction({
      sessions,
      maxContextTokens: 400,
      harness: { models: { compactHistory }, turns: {} },
      jobs,
      advisoryLock: testAdvisoryLock(),
    } as unknown as OrchestratorDeps);
    return { jobs, compaction };
  };
  const dying = build(() => new Promise<string>(() => {}));
  dying.compaction.scheduleBackgroundCompaction({
    sessionId: session.id,
    afterSeq: 9,
    scopeId: scope,
    orgScopeId: "org:test",
    actorId: "test",
  });
  const next = build(async () => "Earlier work.");
  await next.jobs.start();
  try {
    const deadline = Date.now() + 15_000;
    while (!(await sessions.getItems(session.id)).some((item) => item.kind === "ContextCompaction")) {
      assert.ok(Date.now() < deadline, "the scheduled compaction never ran after the restart");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await next.jobs.stop();
  }
});

test("two background compactions for one session make one summarizer call", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread("double-bill", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  for (let i = 0; i < 10; i++) {
    await sessions.append(lease, { kind: "UserMessage", text: `message ${i} `.repeat(100) });
  }
  await sessions.releaseLease(lease);
  const started = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  let calls = 0;
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  const runs: Promise<unknown>[] = [];
  const compaction = createCompaction({
    sessions,
    maxContextTokens: 400,
    harness: {
      models: {
        compactHistory: async () => {
          if (++calls === 1) started.resolve();
          else second.resolve();
          return finish.promise;
        },
      },
      turns: {},
    },
    jobs: {
      handle: (name: string, run: (params: unknown) => Promise<unknown>) => handlers.set(name, run),
      spawn: async (name: string, params: unknown) => {
        runs.push(handlers.get(name)!(structuredClone(params)));
      },
    },
    advisoryLock: testAdvisoryLock(),
  } as unknown as OrchestratorDeps);
  const job = { sessionId: session.id, scopeId: scope, orgScopeId: "org:test", actorId: "test" };
  compaction.scheduleBackgroundCompaction({ ...job, afterSeq: 8 });
  await started.promise;
  compaction.scheduleBackgroundCompaction({ ...job, afterSeq: 9 });
  await Promise.race([runs[1], second.promise]);
  finish.resolve("Earlier work.");
  await Promise.all(runs);
  compaction.scheduleBackgroundCompaction({ ...job, afterSeq: 10 });
  await Promise.all(runs);
  assert.equal(calls, 1);
  const summaries = (await sessions.getItems(session.id)).filter((item) => item.kind === "ContextCompaction");
  assert.equal(summaries.length, 1);
});
