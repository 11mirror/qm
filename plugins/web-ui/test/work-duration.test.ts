import { item } from "./support/item-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { goalWorked, workSeconds, workedLabel } from "../src/work-duration.ts";
import type { Item } from "../src/items.ts";
import { itemsToMessages, type AssistantWork } from "../src/transcript-messages.ts";
import type { WorkBlock } from "../src/core-bridge.ts";

const MIN = 60_000;
const goal = {
  objective: "grind 20m",
  status: "active",
  floor: { minMs: 20 * MIN },
  createdAt: 2 * MIN,
  updatedAt: 2 * MIN,
};
const turn = (
  startedAt: number,
  finishedAt: number,
  extra: Record<string, unknown> = {},
  activity: unknown[] = [],
) => ({
  role: "assistant",
  work: { status: "complete", startedAt, finishedAt, activity },
  ...extra,
});
const strip = { objective: goal.objective, status: "active" as const, createdAt: goal.createdAt };
const created = [item("ToolResult", { createdAt: 2 * MIN, tool: "goal", body: { action: "create", goal } })];

test("worked time counts only running turns: idle and paused intervals are excluded", () => {
  const messages = [
    turn(0, MIN),
    turn(MIN, 10 * MIN, {}, created),
    turn(10 * MIN, 12 * MIN, { stopReason: "aborted" }),
    turn(40 * MIN, 45 * MIN),
  ];
  assert.deepEqual(goalWorked(messages.slice(0, 2), strip), { workedMs: 8 * MIN, paused: false });
  assert.deepEqual(goalWorked(messages.slice(0, 3), strip), { workedMs: 10 * MIN, paused: true });
});

test("a resumed goal adds the new turn but not the gap before it", () => {
  const messages = [turn(MIN, 10 * MIN, {}, created), turn(30 * MIN, 35 * MIN), turn(90 * MIN, 91 * MIN)];
  assert.deepEqual(goalWorked(messages, strip), { workedMs: 14 * MIN, paused: false });
});

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Parameters<typeof itemsToMessages>[1];

test("waiting for an approval decision does not count as active work", () => {
  const items = [
    item("ToolCall", { seq: 1, createdAt: 101_000, body: { command: "help" } }),
    item("ToolResult", { seq: 2, createdAt: 108_000, body: { blocked: "needs_approval" } }),
  ];
  const activity: WorkBlock["activity"] = items.map((entry) => ({ item: entry }));
  assert.equal(workSeconds({ status: "working", startedAt: 100_000, activity }), 8);
  assert.equal(workSeconds({ status: "complete", startedAt: 100_000, finishedAt: 700_000, activity }), 8);
  const history = itemsToMessages([
    ...items,
    item("ElicitationResponse", {
      seq: 3,
      createdAt: 700_000,
      elicitId: "req",
      approved: false,
      body: { command: "help" },
    }),
  ]);
  assert.equal(workSeconds((history[0] as AssistantWork).work!), 7);
  const resumed = [
    ...activity,
    { item: item("AgentMessage", { seq: 4, createdAt: 710_000, variant: "narration", text: "continuing" }) },
  ];
  assert.equal(workSeconds({ status: "complete", startedAt: 700_000, finishedAt: 715_000, activity: resumed }), 15);
});

for (const kind of ["Elicitation", "ToolResult", "ToolCall"] as const) {
  test(`${kind} timing preserves initial thinking without counting the approval wait`, () => {
    const items: Item[] = [
      item("ToolCall", { seq: 1, createdAt: 112_000, body: { command: "help" } }),
      item(kind, {
        seq: 2,
        createdAt: 113_000,
        ...(kind === "Elicitation" ? { elicitId: "req" } : {}),
        body: { blocked: "needs_approval", workStartedAt: 100_000, workFinishedAt: 113_000 },
      }),
    ];
    const activity: WorkBlock["activity"] = items.map((entry) => ({ item: entry }));
    const live = workSeconds({ status: "complete", startedAt: 100_000, activity });
    for (const decided of [false, true]) {
      const history: Item[] = [...items];
      if (decided)
        history.push(
          item("ElicitationResponse", {
            seq: 3,
            createdAt: 700_000,
            elicitId: "req",
            approved: false,
            body: { command: "help" },
          }),
        );
      const work = (itemsToMessages(history)[0] as AssistantWork).work!;
      assert.equal(workSeconds(work), live);
      assert.equal(workSeconds(work), 13);
    }
  });
}

test("work duration survives a transcript refresh — persisted turn timing wins over activity inference", () => {
  const runStartedAt = 100_000;
  const runFinishedAt = 113_000;

  const items: Item[] = [
    item("UserMessage", { createdAt: 99_000, seq: 1, text: "hi" }),
    item("ToolCall", { createdAt: 112_000, seq: 2, tool: "execute", body: { command: "ls" } }),
    item("ToolResult", { createdAt: 112_000, seq: 3, tool: "execute", text: "a", body: { code: 0 } }),
    item("AgentMessage", {
      createdAt: 112_100,
      seq: 4,
      text: "done",
      body: { workStartedAt: runStartedAt, workFinishedAt: runFinishedAt },
    }),
  ];

  const liveWork: WorkBlock = {
    status: "complete",
    startedAt: runStartedAt,
    finishedAt: runFinishedAt,
    activity: [],
  };
  const liveLabel = workedLabel("Worked", workSeconds(liveWork));
  assert.equal(liveLabel, "Worked for 13s");

  const msgs = itemsToMessages(items, MODEL);
  const rebuilt = (msgs[1] as AssistantWork).work;
  assert.ok(rebuilt, "the assistant reply carries a work block after refresh");
  assert.equal(rebuilt.startedAt, runStartedAt, "persisted turn start round-trips");
  assert.equal(rebuilt.finishedAt, runFinishedAt, "persisted turn finish round-trips");
  const refreshedLabel = workedLabel("Worked", workSeconds(rebuilt));
  assert.equal(refreshedLabel, liveLabel, "the duration label is unchanged after refresh");
});

test("fold expansion does not change the duration — the label derives only from the work block, deterministically", () => {
  const work: WorkBlock = {
    status: "complete",
    startedAt: 100_000,
    finishedAt: 113_000,
    activity: [
      { item: item("ToolCall", { seq: 2, createdAt: 112_000, tool: "execute" }) },
      { item: item("ToolResult", { seq: 3, createdAt: 112_000, tool: "execute" }) },
    ],
  };

  const before = workedLabel("Worked", workSeconds(work));
  const after = workedLabel("Worked", workSeconds(work));
  assert.equal(before, "Worked for 13s");
  assert.equal(after, before, "re-rendering (fold toggle) yields the identical label");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 3_600_000;
    assert.equal(workedLabel("Worked", workSeconds(work)), before);
  } finally {
    Date.now = realNow;
  }
});

test("historical transcripts without persisted timing keep the activity-inference fallback", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "hi" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "ls" } }),
    item("ToolResult", { createdAt: 120, seq: 3, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 130, seq: 4, text: "done" }),
  ];
  const work = (itemsToMessages(items, MODEL)[1] as AssistantWork).work;
  assert.equal(work?.startedAt, 110);
  assert.equal(work?.finishedAt, 130);
});

test("live and completed work use compact minute and second labels", () => {
  for (const prefix of ["Working", "Worked"]) {
    for (const [seconds, duration] of [
      [7, "7s"],
      [60, "1m"],
      [65, "1m 5s"],
      [365, "6m 5s"],
    ] as const)
      assert.equal(workedLabel(prefix, seconds), `${prefix} for ${duration}`);
  }
});

test("work duration ends at final-answer start while the run stays active", () => {
  const work: WorkBlock = {
    status: "working",
    startedAt: 100_000,
    activity: [{ marker: "text_start", seq: 3, createdAt: 108_000, phase: "final_answer", streamOffset: 11 }],
  };
  assert.equal(workSeconds(work), 8);
  assert.equal(work.status, "working");
});
