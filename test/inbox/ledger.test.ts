import assert from "node:assert/strict";
import { test, mock } from "node:test";
import {
  agentDraftOf,
  createInboxLedger,
  inboxItemId,
  type IngestEntryInput,
  inboxConversationKeyMigration,
  INBOX_ITEM_SOURCE_MIGRATION,
} from "../../src/inbox/ledger.ts";
import { ledgerItemView, ledgerState, sortLedgerItems } from "../../src/inbox/view.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import type { TriggerOutcome, TriggerSpec } from "../../src/triggers/run-trigger.ts";
import type { Cron } from "../../src/types.ts";

const CRON = "cron-1";

function entry(over: Partial<IngestEntryInput> = {}): IngestEntryInput {
  return {
    cronId: CRON,
    dedupeKey: "gmail:thread-1",
    source: "gmail",
    summary: "can you look at this?",
    sourcePayload: { source: "gmail", title: "Budget", from: "Ada", snippet: "can you look at this?" },
    sourceAt: 1_000,
    ...over,
  };
}

async function ingested(over: Partial<IngestEntryInput> = {}) {
  const ledger = createInboxLedger(testDatabaseUrl());
  await ledger.ingest([entry(over)]);
  const [item] = await ledger.byCron(CRON);
  return { ledger, item: item! };
}

test("ingest creates pending items and holds the ones that arrive with a proposal", async () => {
  const ledger = createInboxLedger(testDatabaseUrl());
  const outcome = await ledger.ingest([
    entry(),
    entry({ dedupeKey: "gmail:thread-2", proposal: { data: { body: "on it" }, by: "agent" } }),
  ]);
  assert.deepEqual(outcome, { created: 2, updated: 0, skipped: 0 });
  const items = await ledger.byCron(CRON);
  assert.equal(items.length, 2);
  const [pending, held] = [
    items.find((i) => i.sourceKey === "gmail:thread-1")!,
    items.find((i) => i.sourceKey === "gmail:thread-2")!,
  ];
  assert.equal(ledgerState(pending), "pending");
  assert.equal(ledgerState(held), "held");
  assert.equal(held.proposal?.by, "agent");
  assert.ok(held.proposal?.at);
});

test("the ledger id is the dedupe key scoped to its loop", async () => {
  const ledger = createInboxLedger(testDatabaseUrl());
  await ledger.ingest([entry(), entry({ cronId: "loop-2" })]);
  assert.equal((await ledger.byCron(CRON)).length, 1);
  assert.equal((await ledger.byCron("loop-2")).length, 1);
  assert.notEqual(inboxItemId(CRON, "k"), inboxItemId("loop-2", "k"));
});

test("re-ingesting the same source event with nothing new is skipped", async () => {
  const ledger = createInboxLedger(testDatabaseUrl());
  await ledger.ingest([entry()]);
  assert.deepEqual(await ledger.ingest([entry()]), { created: 0, updated: 0, skipped: 1 });
});

test("a newer source event refreshes the payload and the proposal", async () => {
  const ledger = createInboxLedger(testDatabaseUrl());
  await ledger.ingest([entry({ proposal: { data: { body: "first" }, by: "agent" } })]);
  const outcome = await ledger.ingest([
    entry({
      sourceAt: 2_000,
      sourcePayload: { source: "gmail", title: "Budget", from: "Ada", snippet: "bumping this" },
      proposal: { data: { body: "second" }, by: "agent" },
    }),
  ]);
  assert.deepEqual(outcome, { created: 0, updated: 1, skipped: 0 });
  const [item] = await ledger.byCron(CRON);
  assert.equal(item?.sourceAt, 2_000);
  assert.equal(item?.sourcePayload?.snippet, "bumping this");
  assert.deepEqual(item?.proposal?.data, { body: "second" });
});

test("a proposal the person edited survives a sync that brings no newer message", async () => {
  const { ledger, item: before } = await ingested({ proposal: { data: { body: "agent draft" }, by: "agent" } });
  await ledger.setProposal(before.id, { data: { body: "my own words" }, by: "human" });
  await ledger.ingest([entry({ proposal: { data: { body: "agent rewrite" }, by: "agent" } })]);
  const [after] = await ledger.byCron(CRON);
  assert.deepEqual(after?.proposal?.data, { body: "my own words" });
  assert.equal(after?.proposal?.by, "human");
});

test("a newer message overrides even an edited proposal", async () => {
  const { ledger, item: before } = await ingested({ proposal: { data: { body: "agent draft" }, by: "agent" } });
  await ledger.setProposal(before.id, { data: { body: "my own words" }, by: "human" });
  await ledger.ingest([entry({ sourceAt: 5_000, proposal: { data: { body: "fresh draft" }, by: "agent" } })]);
  const [after] = await ledger.byCron(CRON);
  assert.deepEqual(after?.proposal?.data, { body: "fresh draft" });
});

test("actioned items are never resurrected by a stale sync", async () => {
  const { ledger, item } = await ingested();
  await ledger.recordAction(item.id, { kind: "send", outcome: "actioned", result: "sent" });
  assert.deepEqual(await ledger.ingest([entry()]), { created: 0, updated: 0, skipped: 1 });
  const [after] = await ledger.byCron(CRON);
  assert.equal(ledgerState(after!), "actioned");
  assert.equal(after?.actionResult, "sent");
});

test("a newer message revives a dismissed item", async () => {
  const { ledger, item } = await ingested();
  await ledger.recordAction(item.id, { kind: "dismiss", outcome: "dismissed" });
  assert.equal(ledgerState((await ledger.get(item.id))!), "dismissed");
  await ledger.ingest([entry({ sourceAt: 9_000, proposal: { data: { body: "reply" }, by: "agent" } })]);
  const revived = await ledger.get(item.id);
  assert.equal(ledgerState(revived!), "held");
  assert.equal(revived?.actedAt, undefined);
});

test("an actioned item cannot be actioned or edited again", async () => {
  const { ledger, item } = await ingested();
  await ledger.recordAction(item.id, { kind: "send", outcome: "actioned" });
  assert.equal(await ledger.recordAction(item.id, { kind: "send", outcome: "actioned" }), null);
  assert.equal(await ledger.setProposal(item.id, { data: { body: "late" }, by: "human" }), null);
  assert.equal(await ledger.reopen(item.id), null);
});

test("reopen brings a dismissed item back to held when it holds a proposal", async () => {
  const { ledger, item } = await ingested({ proposal: { data: { body: "reply" }, by: "agent" } });
  await ledger.recordAction(item.id, { kind: "dismiss", outcome: "dismissed" });
  const reopened = await ledger.reopen(item.id);
  assert.equal(ledgerState(reopened!), "held");
});

test("the thread keeps every chat turn", async () => {
  const { ledger, item } = await ingested();
  await ledger.appendThread(item.id, [{ role: "human", text: "make it shorter", actorId: "josh" }]);
  const after = await ledger.appendThread(item.id, [{ role: "agent", text: "done" }]);
  assert.deepEqual(
    after?.thread?.map((m) => [m.role, m.text]),
    [
      ["human", "make it shorter"],
      ["agent", "done"],
    ],
  );
  assert.ok(after?.thread?.every((m) => m.id && m.at));
  for (let i = 0; i < 210; i++) await ledger.appendThread(item.id, [{ role: "agent", text: `turn ${i}` }]);
  const kept = await ledger.get(item.id);
  assert.equal(kept?.thread?.length, 212);
  assert.equal(kept?.thread?.at(-1)?.text, "turn 209");
});

test("setProposal promotes a pending item to held", async () => {
  const { ledger, item } = await ingested();
  const held = await ledger.setProposal(item.id, { data: { body: "draft" }, by: "agent", sessionId: "s1" });
  assert.equal(ledgerState(held!), "held");
  assert.equal(held?.proposal?.sessionId, "s1");
});

test("annotate merges into the source payload, leaving the item's state and proposal alone", async () => {
  const { ledger, item } = await ingested({ proposal: { data: { body: "on it" }, by: "agent" } });
  const annotated = await ledger.annotate(item.id, { reactions: ["eyes"] });
  assert.equal(ledgerState(annotated!), "held");
  assert.deepEqual(annotated?.proposal?.data, { body: "on it" });
  assert.deepEqual(annotated?.sourcePayload, {
    source: "gmail",
    title: "Budget",
    from: "Ada",
    snippet: "can you look at this?",
    reactions: ["eyes"],
  });
  assert.equal(await ledger.annotate("no-such-item", { reactions: [] }), null);
});

test("a newer source event replaces the payload the annotation lived in", async () => {
  const { ledger, item } = await ingested();
  await ledger.annotate(item.id, { reactions: ["eyes"] });
  await ledger.ingest([entry({ sourceAt: 2_000 })]);
  assert.equal((await ledger.get(item.id))?.sourcePayload?.reactions, undefined);
});

test("prune drops resolved items past retention and over the cap, never open ones", async () => {
  const ledger = createInboxLedger(testDatabaseUrl());
  await ledger.ingest([
    entry({ dedupeKey: "a" }),
    entry({ dedupeKey: "b" }),
    entry({ dedupeKey: "c" }),
    entry({ dedupeKey: "d" }),
  ]);
  const items = await ledger.byCron(CRON);
  const byKey = new Map(items.map((i) => [i.sourceKey, i]));
  await ledger.recordAction(byKey.get("b")!.id, { kind: "send", outcome: "actioned" });
  await ledger.recordAction(byKey.get("c")!.id, { kind: "dismiss", outcome: "dismissed" });
  await ledger.recordAction(byKey.get("d")!.id, { kind: "dismiss", outcome: "dismissed" });
  const now = Date.now();
  const dropped = await ledger.prune(CRON, { maxItems: 3, retentionMs: 1, now: now + 10 });
  assert.equal(dropped, 3);
  const left = await ledger.byCron(CRON);
  assert.deepEqual(
    left.map((i) => i.sourceKey),
    ["a"],
  );
});

test("prune keeps resolved items inside retention while under the cap", async () => {
  const ledger = createInboxLedger(testDatabaseUrl());
  await ledger.ingest([entry({ dedupeKey: "a" }), entry({ dedupeKey: "b" })]);
  const items = await ledger.byCron(CRON);
  await ledger.recordAction(items[0]!.id, { kind: "send", outcome: "actioned" });
  assert.equal(await ledger.prune(CRON, { maxItems: 50, retentionMs: 60_000 }), 0);
});

test("open items sort ahead of resolved ones, newest source event first", async () => {
  const ledger = createInboxLedger(testDatabaseUrl());
  await ledger.ingest([
    entry({ dedupeKey: "old", sourceAt: 1 }),
    entry({ dedupeKey: "new", sourceAt: 100 }),
    entry({ dedupeKey: "done", sourceAt: 500 }),
  ]);
  const items = await ledger.byCron(CRON);
  await ledger.recordAction(items.find((i) => i.sourceKey === "done")!.id, { kind: "send", outcome: "actioned" });
  const sorted = sortLedgerItems(await ledger.byCron(CRON));
  assert.deepEqual(
    sorted.map((i) => i.sourceKey),
    ["new", "old", "done"],
  );
});

test("the ledger view exposes the generic shape and never leaks decision tokens", async () => {
  const { item } = await ingested({ proposal: { data: { body: "hi" }, by: "agent" } });
  const view = ledgerItemView(item);
  assert.equal(view.dedupeKey, "gmail:thread-1");
  assert.equal(view.state, "held");
  assert.equal(view.source, "gmail");
  assert.deepEqual(view.sourcePayload, item.sourcePayload);
  assert.deepEqual(view.thread, []);
  assert.equal("decisionToken" in view, false);
});

test("a failed item reads as failed, not dismissed, and keeps its reason", async () => {
  const { ledger, item } = await ingested();
  await ledger.recordAction(item.id, { kind: "fail", outcome: "failed", result: "connector down" });
  const failed = (await ledger.get(item.id))!;
  assert.equal(ledgerState(failed), "failed");
  assert.equal(failed.parkedReason, "connector down");
});

test("a person's edit keeps the agent drafts alongside it, and new agent drafts accumulate", async () => {
  const { ledger, item } = await ingested({ proposal: { data: { body: "agent v1" }, by: "agent" } });
  assert.equal(item.proposal?.by, "agent");
  await ledger.setProposal(item.id, { data: { body: "my words" }, by: "human" });
  let after = (await ledger.get(item.id))!;
  assert.equal(after.proposal?.by, "human");
  assert.deepEqual(
    after.agentDrafts?.map((d) => d.data),
    [{ body: "agent v1" }],
  );
  await ledger.setProposal(item.id, { data: { body: "my words 2" }, by: "human" });
  after = (await ledger.get(item.id))!;
  assert.deepEqual(
    after.agentDrafts?.map((d) => d.data),
    [{ body: "agent v1" }],
    "a second edit adds nothing",
  );
  await ledger.setProposal(item.id, { data: { body: "agent v2" }, by: "agent" });
  after = (await ledger.get(item.id))!;
  assert.deepEqual(
    after.agentDrafts?.map((d) => d.data),
    [{ body: "agent v1" }, { body: "agent v2" }],
  );
  assert.equal(after.proposal?.by, "agent");
  for (let i = 3; i < 20; i++) await ledger.setProposal(item.id, { data: { body: `agent v${i}` }, by: "agent" });
  assert.equal((await ledger.get(item.id))!.agentDrafts?.length, 10, "history is bounded");
});

test("a re-ingested agent draft becomes the draft authorship is judged against, even after a human edit", async () => {
  const { ledger, item } = await ingested({ proposal: { data: { body: "agent v1" }, by: "agent" } });
  await ledger.setProposal(item.id, { data: { body: "my words" }, by: "human" });
  await ledger.ingest([entry({ sourceAt: 2_000, proposal: { data: { body: "agent v2 <!here>" }, by: "agent" } })]);
  const after = (await ledger.get(item.id))!;
  assert.deepEqual(agentDraftOf(after)?.data, { body: "agent v2 <!here>" });
  assert.deepEqual(
    after.agentDrafts?.map((d) => d.data),
    [{ body: "agent v1" }, { body: "agent v2 <!here>" }],
  );
  await ledger.setProposal(item.id, { data: { body: "mine again" }, by: "human" });
  assert.deepEqual(agentDraftOf((await ledger.get(item.id))!)?.data, { body: "agent v2 <!here>" });
});

test("setProposal can be conditioned on the draft version the caller saw", async () => {
  const { ledger, item } = await ingested({ proposal: { data: { body: "agent v1" }, by: "agent" } });
  const seenAt = item.proposal!.at;
  assert.equal(
    await ledger.setProposal(item.id, { data: { body: "late" }, by: "human" }, { expectedAt: seenAt - 1 }),
    null,
  );
  assert.deepEqual((await ledger.get(item.id))!.proposal!.data, { body: "agent v1" }, "a stale write changes nothing");
  assert.ok(await ledger.setProposal(item.id, { data: { body: "on time" }, by: "human" }, { expectedAt: seenAt }));
});

test("an item ingested without a draft still carries an empty agent-draft history", async () => {
  const { item } = await ingested();
  assert.deepEqual(item.agentDrafts, []);
});

test("mention identities the agent ever wrote are kept even after the draft history rolls over", async () => {
  const { ledger, item } = await ingested({ proposal: { data: { body: "team <!here> look" }, by: "agent" } });
  for (let i = 0; i < 12; i++) await ledger.setProposal(item.id, { data: { body: `calm v${i}` }, by: "agent" });
  const after = (await ledger.get(item.id))!;
  assert.equal(after.agentDrafts?.length, 10);
  assert.ok(!after.agentDrafts!.some((d) => JSON.stringify(d.data).includes("<!here>")));
  assert.deepEqual(after.agentMentionKeys, ["!here"]);
});

test("re-ingesting the identical agent draft does not bump its timestamp", async () => {
  const { ledger, item } = await ingested({ proposal: { data: { body: "same" }, by: "agent" } });
  const at = item.proposal!.at;
  await new Promise((r) => setTimeout(r, 3));
  await ledger.ingest([entry({ proposal: { data: { body: "same" }, by: "agent" } })]);
  assert.equal((await ledger.get(item.id))!.proposal!.at, at);
});

test("draft identity ignores key order, as stored JSON does not preserve it", async () => {
  const { ledger, item } = await ingested({
    proposal: { data: { body: "hi", to: ["a@x"], subject: "s" }, by: "agent" },
  });
  const at = item.proposal!.at;
  await new Promise((r) => setTimeout(r, 3));
  await ledger.ingest([entry({ proposal: { data: { subject: "s", to: ["a@x"], body: "hi" }, by: "agent" } })]);
  const after = (await ledger.get(item.id))!;
  assert.equal(after.proposal!.at, at);
  assert.equal(after.agentDrafts!.length, 1);
});

test("continuing a sent reply clears the old draft without losing chat or allowing a second reset", async () => {
  const ledger = createInboxLedger(testDatabaseUrl());
  await ledger.ingest([
    entry({ sourcePayload: { sentChat: true }, proposal: { data: { body: "First reply" }, by: "human" } }),
  ]);
  const item = (await ledger.byCron(CRON))[0]!;
  await ledger.appendThread(item.id, [{ role: "human", text: "Help with this thread" }]);
  await ledger.recordAction(item.id, { kind: "send", outcome: "actioned" });
  assert.equal(await ledger.reopen(item.id), null);
  const reply = await ledger.reopen(item.id, { sentReply: true });
  assert.equal(reply!.proposal!.data.body, "");
  assert.ok(reply!.proposal!.at > item.proposal!.at);
  assert.equal(reply!.thread![0]!.text, "Help with this thread");
  assert.equal(ledgerState(reply!), "held");
  assert.equal(await ledger.reopen(item.id, { sentReply: true }), null);
  assert.equal(
    await ledger.setProposal(
      item.id,
      { data: { body: "Stale resend" }, by: "human" },
      { expectedAt: item.proposal!.at },
    ),
    null,
  );
  await ledger.ingest([entry({ dedupeKey: "ordinary" })]);
  const ordinary = (await ledger.byCron(CRON)).find((item) => item.sourceKey === "ordinary")!;
  await ledger.recordAction(ordinary.id, { kind: "send", outcome: "actioned" });
  assert.equal(await ledger.reopen(ordinary.id, { sentReply: true }), null);
});

test("email classification projection is opt-in, scoped, and never changes stored previews", async () => {
  const ledger = createInboxLedger(testDatabaseUrl());
  await ledger.ingest([
    entry({
      sourcePayload: { automated: true, privateDetail: "hidden" },
      proposal: { by: "agent", data: { body: "Draft" } },
    }),
    entry({ cronId: "unselected", sourcePayload: { automated: true } }),
  ]);
  const stored = structuredClone(await ledger.get(inboxItemId(CRON, "gmail:thread-1")));
  const before = await ledger.summaries([CRON]);
  assert.equal(before.length, 1);
  assert.equal(before[0]!.inboxPreview!.automated, undefined);
  const classified = await ledger.summaries([CRON], { includeInboxMetadata: true });
  assert.equal(classified.length, 1);
  assert.equal(classified[0]!.inboxPreview!.automated, true);
  assert.equal(classified[0]!.inboxPreview!.privateDetail, undefined);
  for (const key of ["sourcePayload", "proposal", "thread", "agentDrafts"]) assert.ok(!(key in classified[0]!));
  assert.deepEqual(await ledger.summaries([CRON]), before);
  assert.deepEqual(await ledger.get(inboxItemId(CRON, "gmail:thread-1")), stored);
});

test("ingest reuses the stored id of a known source key", async () => {
  const url = testDatabaseUrl();
  const ledger = createInboxLedger(url);
  await ledger.ingest([entry()]);
  const original = (await ledger.byCron(CRON))[0]!;
  await createPgPool(url).q(`UPDATE cron_items SET id = 'legacy' WHERE id = $1`, [original.id]);
  const batch = Array.from({ length: 100 }, (_, i) => entry({ dedupeKey: `new:${i}` }));
  const outcome = await ledger.ingest([entry(), ...batch, ...batch]);
  assert.deepEqual(outcome, { created: 100, updated: 0, skipped: 101 });
  assert.equal((await ledger.byCron(CRON)).length, 101);
  assert.ok(await ledger.get("legacy"));
  assert.equal(await ledger.get(original.id), null);
});

test("conditional annotations reject changed source payloads even within the same clock tick", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  const ledger = createInboxLedger(testDatabaseUrl());
  await ledger.ingest([entry()]);
  const [item] = await ledger.byCron(CRON);
  const snapshot = structuredClone(item!.sourcePayload!);
  const first = await ledger.annotate(
    item!.id,
    { participants: [{ id: "U1", name: "Alex" }] },
    { expectedSourcePayload: snapshot },
  );
  assert.ok(first);
  assert.equal(first.updatedAt, item!.updatedAt);
  const stale = await ledger.annotate(item!.id, { participants: [] }, { expectedSourcePayload: snapshot });
  assert.equal(stale, null);
  assert.deepEqual((await ledger.get(item!.id))!.sourcePayload!.participants, [{ id: "U1", name: "Alex" }]);
  const current = structuredClone(first.sourcePayload!);
  assert.ok(
    await ledger.annotate(
      item!.id,
      { participants: [{ id: "U2", name: "Taylor" }] },
      { expectedSourcePayload: current },
    ),
  );
});

test("agent ledger views omit cosmetic Slack data without changing UI data or task images", async () => {
  const ledger = createInboxLedger(testDatabaseUrl());
  const payload = {
    source: "slack",
    slackAvatarsRefreshAt: 12345,
    participants: [{ id: "U1", name: "Alex", avatarUrl: "https://example.com/avatar.png" }],
    context: [
      {
        author: "Alex",
        authorId: "U1",
        avatarUrl: "https://example.com/avatar.png",
        images: ["https://example.com/task.png"],
      },
    ],
    task: { avatarUrl: "keep this task data" },
  };
  await ledger.ingest([entry({ source: "slack", sourcePayload: payload })]);
  const [item] = await ledger.byCron(CRON);
  const agent = ledgerItemView(item!, true);
  assert.deepEqual(agent.sourcePayload, {
    source: "slack",
    participants: [{ id: "U1", name: "Alex" }],
    context: [{ author: "Alex", authorId: "U1", images: ["https://example.com/task.png"] }],
    task: { avatarUrl: "keep this task data" },
  });
  assert.deepEqual(ledgerItemView(item!).sourcePayload, payload);
  assert.deepEqual((await ledger.get(item!.id))!.sourcePayload, payload);
  assert.deepEqual(ledgerItemView({ ...item!, source: "gmail" }, true).sourcePayload, payload);
});

test("ordinary ledger annotations leave previews unchanged and do not project avatar metadata", async () => {
  const { ledger, item } = await ingested();
  const before = structuredClone(item.inboxPreview);
  const updated = await ledger.annotate(item.id, {
    title: "Updated title",
    participants: [{ id: "U1", name: "Alex", avatarUrl: "https://example.com/avatar.png" }],
    slackAvatarsRefreshAt: 12345,
  });
  assert.equal(updated!.sourcePayload!.title, "Updated title");
  assert.deepEqual(updated!.inboxPreview, before);
  const [summary] = await ledger.summaries([CRON]);
  assert.deepEqual(summary!.inboxPreview, before);
  const [inboxSummary] = await ledger.summaries([CRON], { includeInboxMetadata: true });
  assert.equal(inboxSummary!.inboxPreview?.participants, undefined);
  await ledger.ingest([entry({ source: "slack", dedupeKey: "slack", sourcePayload: updated!.sourcePayload })]);
  const ordinary = (await ledger.summaries([CRON])).find((item) => item.source === "slack")!;
  assert.equal(ordinary.inboxPreview?.participants, undefined);
  const projected = (await ledger.summaries([CRON], { includeInboxMetadata: true })).find(
    (item) => item.source === "slack",
  )!;
  assert.deepEqual(projected.inboxPreview?.participants, updated!.sourcePayload!.participants);
  assert.equal(projected.inboxPreview?.slackAvatarsRefreshAt, 12345);
  assert.equal("sourcePayload" in projected, false);
});

test("per-cron reads, prune and delete touch only that cron's items", async () => {
  const ledger = createInboxLedger(testDatabaseUrl());
  await ledger.ingest([entry(), entry({ dedupeKey: "gmail:thread-2" }), entry({ cronId: "cron-2" })]);
  assert.equal((await ledger.byCron(CRON)).length, 2);
  assert.deepEqual((await ledger.byCrons([CRON, "cron-2", "cron-missing"])).map((item) => item.cronId).sort(), [
    CRON,
    CRON,
    "cron-2",
  ]);
  assert.equal(await ledger.prune(CRON, { maxItems: 10, retentionMs: 0 }), 0);
  await ledger.deleteByCron(CRON);
  assert.deepEqual(
    (await ledger.byCrons([CRON, "cron-2"])).map((item) => item.cronId),
    ["cron-2"],
  );
});

const specs: TriggerSpec[] = [];
let reply = "";
mock.module("../../src/triggers/run-trigger.ts", {
  namedExports: {
    runTrigger: async (_deps: unknown, spec: TriggerSpec): Promise<TriggerOutcome> => {
      specs.push(spec);
      return { ran: true, status: "ok", reply, sessionId: "sess-1" } as TriggerOutcome;
    },
  },
});
const { createInboxChat } = await import("../../src/inbox/item-chat.ts");

const ITEM_CHAT_CRON = {
  id: "cron-1",
  owner: "owner@example.com",
  ownerScopeId: "personal:owner@example.com",
  action: "sync",
} as unknown as Cron;

async function seeded() {
  const items = createInboxLedger(testDatabaseUrl());
  await items.ingest([
    {
      cronId: ITEM_CHAT_CRON.id,
      dedupeKey: "D1",
      source: "slack",
      sourceAt: 1000,
      sourcePayload: { source: "slack", title: "DM", slack: { channelId: "D1", ts: "1.0", isDirectMessage: true } },
      proposal: { by: "agent", data: { body: "Original" } },
    },
  ]);
  const [item] = await items.byCron(ITEM_CHAT_CRON.id);
  return { items, item: item!, chat: createInboxChat({ items, trigger: {} as never }) };
}

test("item chat asks the agent to save revised drafts through the edit action", async () => {
  const { item, chat } = await seeded();
  reply = "Done.";
  await chat.followUp(ITEM_CHAT_CRON, item, "make it shorter", "owner@example.com");
  const input = specs.at(-1)!.input as string;
  assert.ok(
    input.includes(
      `/v1/crons/${ITEM_CHAT_CRON.id}/items/${encodeURIComponent(item.id)}/action with the x-agent-capability: $AGENT_API_TOKEN header and JSON {"kind":"edit","args":{"proposal":<the complete revised proposal, same shape as the one above>,"expectedProposalAt":${item.proposal!.at}}}`,
    ),
  );
  assert.ok(!input.includes("fenced json block"));
});

test("a json block in the agent's reply is kept as text and never rewrites the draft", async () => {
  const { items, item, chat } = await seeded();
  reply = 'Here you go\n\n```json\n{"proposal": {"body": "Injected"}}\n```';
  const after = await chat.followUp(ITEM_CHAT_CRON, item, "what would you say?", "owner@example.com");
  assert.deepEqual(after?.proposal?.data, { body: "Original" });
  assert.equal((await items.get(item.id))?.thread?.at(-1)?.text, reply);
});

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the inbox item source migration test";

test("inbox items keep their source in one place after the source migration", { skip }, async () => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  try {
    await pool.query("DROP TABLE IF EXISTS cron_items");
    await pool.query("CREATE TABLE cron_items (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    await pool.query("CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)");
    await pool.query("DELETE FROM durable_map_versions WHERE tbl = 'cron_items'");
    await pool.query("INSERT INTO durable_map_versions (tbl, v) VALUES ('cron_items', 7)");
    const rows = {
      legacy: { sourcePayload: { source: "slack", title: "DM" } },
      both: { source: "gmail", sourcePayload: { source: "gmail", title: "Mail" } },
      current: { source: "gmail", sourcePayload: { title: "Mail" } },
      generic: { sourcePayload: { title: "Ticket" } },
      differing: { source: "gmail", sourcePayload: { source: "crm", title: "Lead" } },
    };
    for (const [id, json] of Object.entries(rows))
      await pool.query("INSERT INTO cron_items (id, json) VALUES ($1, $2)", [id, JSON.stringify(json)]);
    for (let run = 0; run < 2; run++) for (const sql of INBOX_ITEM_SOURCE_MIGRATION.statements) await pool.query(sql);
    const after = Object.fromEntries(
      (await pool.query("SELECT id, json FROM cron_items")).rows.map((row) => [row.id, row.json]),
    );
    assert.deepEqual(after, {
      legacy: { source: "slack", sourcePayload: { title: "DM" } },
      both: { source: "gmail", sourcePayload: { title: "Mail" } },
      current: { source: "gmail", sourcePayload: { title: "Mail" } },
      generic: { sourcePayload: { title: "Ticket" } },
      differing: { source: "gmail", sourcePayload: { source: "crm", title: "Lead" } },
    });
    const [version] = (await pool.query("SELECT v FROM durable_map_versions WHERE tbl = 'cron_items'")).rows;
    assert.equal(Number(version.v), 9);
  } finally {
    await pool.query("DROP TABLE IF EXISTS cron_items");
    await pool.end();
  }
});

test("existing inbox items gain the conversation key their source adapter reads", { skip }, async () => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  try {
    await pool.query("DROP TABLE IF EXISTS cron_items");
    await pool.query("CREATE TABLE cron_items (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    await pool.query("CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)");
    const rows = {
      slack: { source: "slack", sourcePayload: { slack: { channelId: "D123", ts: "1.0" } } },
      gmail: { source: "gmail", sourcePayload: { gmail: { threadId: "t-1" } } },
      missing: { source: "slack", sourcePayload: { title: "no metadata" } },
      generic: { sourcePayload: { slack: { channelId: "C1" } } },
    };
    for (const [id, json] of Object.entries(rows))
      await pool.query("INSERT INTO cron_items (id, json) VALUES ($1, $2)", [id, JSON.stringify(json)]);
    for (let run = 0; run < 2; run++)
      for (const sql of inboxConversationKeyMigration().statements) await pool.query(sql);
    const keys = Object.fromEntries(
      (await pool.query("SELECT id, json->>'conversationKey' AS key FROM cron_items")).rows.map((row) => [
        row.id,
        row.key,
      ]),
    );
    assert.deepEqual(keys, { slack: "D123", gmail: "t-1", missing: null, generic: null });
  } finally {
    await pool.query("DROP TABLE IF EXISTS cron_items");
    await pool.end();
  }
});

test("the person's new message reaches the item chat prompt once", async () => {
  const { item, chat } = await seeded();
  reply = "Sure.";
  await chat.followUp(ITEM_CHAT_CRON, item, "zebra-unique-ask", "owner@example.com");
  const input = specs.at(-1)!.input as string;
  assert.equal(input.split("zebra-unique-ask").length - 1, 1);
});
