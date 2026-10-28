import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { type Item, type NewItem, storedItem, type ItemKind } from "../../src/sessions/items.ts";
import {
  windowedTranscript,
  type Lease,
  type SessionStore,
  TOOL_TEXT_PREVIEW_CHARS,
} from "../../src/sessions/session-store.ts";
import { scopeId } from "../../src/types.ts";
import type { BuiltApp } from "../../src/wiring.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { listenLocal } from "../support/listen-local.ts";
import { dmFor } from "../support/dm-turn.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-view-bounds-"));
  return buildApp(testConfig({ dataDir }));
}

const actor = { externalId: "U1" };
const dm = dmFor(actor);

test("a tailTurns view is bounded yet reports the same earlierItems as the full read", async () => {
  const { app, runtime } = freshApp();
  runtime.start();
  try {
    for (let i = 0; i < 45; i++) await app.turn(dm(`question number ${i}`, "web:U1:bounds"));
    const sid = (await app.turn(dm("final question", "web:U1:bounds"))).sessionId!;
    const full = (await app.getSessionForViewer(sid, "U1"))!;
    const expected = windowedTranscript(
      (await app.getSessionForViewer(sid, "U1", { tailTurns: 9999 }))!.items as Item[],
      { tailTurns: 2 },
    );
    const bounded = (await app.getSessionForViewer(sid, "U1", { tailTurns: 2 }))!;
    assert.deepEqual(
      bounded.items.map((e) => [e.seq, e.kind]),
      expected.items.map((e) => [e.seq, e.kind]),
    );
    const fullCount = full.items.length + (full.earlierItems ?? 0);
    assert.equal(
      bounded.items.length + (bounded.earlierItems ?? 0),
      fullCount,
      "bounded earlierItems accounts for exactly the renderable entries above the window",
    );
  } finally {
    await runtime.stop();
  }
});

async function toolHeavySession(sessions: SessionStore, turns = 1) {
  const scope = scopeId("personal", "U1");
  const session = await sessions.getOrCreateByThread("web:U1:tool-pins", "dm", scope, undefined, "web");
  await sessions.addParticipant(session.id, "U1", undefined, { includeHistory: true });
  const { lease } = await sessions.acquireLease(session.id);
  const held = lease as Lease;
  const emit = (item: NewItem) => sessions.append(held, item);
  let narration: Item | undefined;
  let reply: Item | undefined;
  for (let turn = 0; turn < turns; turn++) {
    const ask = `codex, tidy queue ${turn}`;
    await emit({ kind: "UserMessage", text: ask });
    const turnNarration = await emit({
      kind: "AgentMessage",
      variant: "narration",
      text: turn === 0 ? "queue narration detail" : `narration ${turn}`,
    });
    narration ??= turnNarration;
    await emit({ kind: "ToolCall", tool: "execute", callId: `c${turn}`, body: { command: "tidy" } });
    await emit({ kind: "ToolResult", tool: "execute", callId: `c${turn}`, isError: false, text: "tidied" });
    reply = await emit({ kind: "AgentMessage", text: `Queue ${turn} tidied.` });
  }
  await sessions.releaseLease(held);
  return { session, narration: narration!, reply: reply! };
}

test("transcripts retain tool detail and exact bounded counts", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const { session, narration } = await toolHeavySession(built.sessions, 30);
    const full = (await built.app.getSessionForViewer(session.id, "U1", { tailTurns: 9999 }))!;
    assert.deepEqual(full.items, await built.sessions.getItems(session.id));
    assert.equal(full.items.length, 150);
    const bounded = (await built.app.getSessionForViewer(session.id, "U1", { tailTurns: 1 }))!;
    assert.deepEqual(bounded.items, full.items.slice(-5));
    assert.equal(bounded.earlierItems, 145);
    const pinned = await built.app.pinConversationItem("web:U1:tool-pins", "U1", { entrySeq: narration.seq });
    assert.ok("pin" in pinned && pinned.pin);
    assert.equal(pinned.pin.preview, "queue narration detail");
  } finally {
    await built.runtime.stop();
  }
});

test("earlier pages bound entry reads, widen for dense turns, and match full-read windows", async () => {
  const built = freshApp();
  try {
    const { session } = await toolHeavySession(built.sessions, 100);
    const canonical = built.sessions.getItems.bind(built.sessions);
    const calls: Array<{ limit?: number; beforeSeq?: number } | undefined> = [];
    built.sessions.getItems = async (id, opts) => {
      calls.push(opts);
      return canonical(id, opts);
    };
    for (const beforeSeq of [1, 50, 251, 499, 900]) {
      const full = (await built.app.getSessionForViewer(session.id, "U1"))!;
      calls.length = 0;
      const window = { beforeSeq, tailTurns: 2 };
      const expected = windowedTranscript(full.items as Item[], window);
      for (const page of [
        await built.app.getSessionForViewer(session.id, "U1", window),
        await built.app.getSession(session.id, window),
      ]) {
        assert.deepEqual(page!.items, expected.items);
        assert.equal(page!.earlierItems ?? 0, expected.earlier);
      }
      assert.ok(calls.every((opts) => opts?.beforeSeq === beforeSeq && opts.limit === 80));
    }
    const { lease } = await built.sessions.acquireLease(session.id);
    for (let i = 0; i < 180; i++)
      await built.sessions.append(lease!, { kind: "AgentMessage", variant: "narration", text: `detail ${i}` });
    await built.sessions.releaseLease(lease!);
    calls.length = 0;
    const page = await built.app.getSession(session.id, { beforeSeq: 680, tailTurns: 1 });
    assert.equal(page!.items[0]!.seq, 495);
    assert.deepEqual(
      calls.map((opts) => opts?.limit),
      [40, 80, 160, 320],
    );
  } finally {
    await built.runtime.stop();
  }
});

test("earlier pages respect viewer tenure boundaries", async () => {
  const built = freshApp();
  try {
    const { session } = await toolHeavySession(built.sessions, 30);
    await built.sessions.addParticipant(session.id, "late");
    const { lease } = await built.sessions.acquireLease(session.id);
    for (let i = 0; i < 10; i++) {
      await built.sessions.append(lease!, { kind: "UserMessage", text: `late question ${i}` });
      await built.sessions.append(lease!, { kind: "AgentMessage", text: `late reply ${i}` });
    }
    await built.sessions.releaseLease(lease!);
    for (const viewer of ["late", "U1", "stranger"]) {
      const full = await built.app.getSessionForViewer(session.id, viewer);
      for (const beforeSeq of [100, 155, 170]) {
        const page = await built.app.getSessionForViewer(session.id, viewer, { beforeSeq, tailTurns: 2 });
        if (!full) {
          assert.equal(page, null);
          continue;
        }
        const expected = windowedTranscript(full.items as Item[], { beforeSeq, tailTurns: 2 });
        assert.deepEqual(page!.items, expected.items);
        assert.equal(page!.earlierItems ?? 0, expected.earlier);
      }
    }
  } finally {
    await built.runtime.stop();
  }
});

test("incremental transcript reads bound entry storage and preserve windows and pins", async () => {
  const built = freshApp();
  try {
    const { session, narration } = await toolHeavySession(built.sessions, 100);
    await built.app.pinConversationItem(session.threadRef, "U1", { entrySeq: narration.seq });
    const canonical = built.sessions.getItems.bind(built.sessions);
    const calls: Array<{ sinceSeq?: number; beforeSeq?: number } | undefined> = [];
    let loadedRows = 0;
    built.sessions.getItems = async (id, opts) => {
      calls.push(opts);
      const rows = await canonical(id, opts);
      loadedRows += rows.length;
      return rows;
    };
    const page = (await built.app.getSession(session.id, { sinceSeq: 490 }))!;
    assert.equal(page.items.length, 10);
    assert.equal(page.earlierItems, 490);
    assert.equal(loadedRows, 10);
    assert.ok(calls.every((opts) => opts?.sinceSeq === 490));
    const viewerPage = (await built.app.getSessionForViewer(session.id, "U1", { sinceSeq: 490 }))!;
    assert.deepEqual(viewerPage.items, page.items);
    assert.equal(viewerPage.earlierItems, 490);
    await built.sessions.addParticipant(session.id, "late");
    const { lease } = await built.sessions.acquireLease(session.id);
    for (let i = 0; i < 10; i++) {
      await built.sessions.append(lease!, { kind: "UserMessage", text: `new question ${i}` });
      await built.sessions.append(lease!, { kind: "AgentMessage", text: `new reply ${i}` });
    }
    await built.sessions.removeParticipant(session.id, "U1");
    await built.sessions.append(lease!, { kind: "UserMessage", text: "after departure" });
    await built.sessions.releaseLease(lease!);
    for (const viewer of [undefined, "U1", "late", "stranger"]) {
      const read = (window?: { sinceSeq?: number; beforeSeq?: number }) =>
        viewer === undefined
          ? built.app.getSession(session.id, window)
          : built.app.getSessionForViewer(session.id, viewer, window);
      const full = await read();
      for (const window of [
        { sinceSeq: 490 },
        { sinceSeq: 500, beforeSeq: 515 },
        { sinceSeq: 515, beforeSeq: 500 },
        { sinceSeq: 900 },
      ]) {
        calls.length = 0;
        const page = await read(window);
        if (!full) {
          assert.equal(page, null);
          continue;
        }
        const expected = windowedTranscript(full.items as Item[], window);
        assert.deepEqual(page!.items, expected.items);
        assert.equal(page!.earlierItems ?? 0, expected.earlier);
        assert.deepEqual(page!.pins, full.pins);
        if (viewer === undefined) assert.ok(calls.some((opts) => opts?.sinceSeq === window.sinceSeq));
      }
    }
  } finally {
    await built.runtime.stop();
  }
});

function entry(seq: number, kind: ItemKind): Item {
  const callId = kind === "ToolCall" || kind === "ToolResult" ? `c${seq}` : undefined;
  return storedItem({ kind, text: `e${seq}`, callId } as NewItem, { sessionId: "s1", seq, createdAt: seq });
}

const LOG: Item[] = [
  entry(0, "UserMessage"),
  entry(1, "ToolCall"),
  entry(2, "ToolResult"),
  entry(3, "AgentMessage"),
  entry(4, "UserMessage"),
  entry(5, "AgentMessage"),
  entry(6, "UserMessage"),
  entry(7, "ToolCall"),
  entry(8, "AgentMessage"),
];

test("windowedTranscript: tailTurns cuts on a turn boundary (a user entry), never mid-turn", () => {
  const one = windowedTranscript(LOG, { tailTurns: 1 });
  assert.deepEqual(
    one.items.map((e) => e.seq),
    [6, 7, 8],
    "the last turn starts at its user entry",
  );
  assert.equal(one.earlier, 6);

  const two = windowedTranscript(LOG, { tailTurns: 2 });
  assert.deepEqual(
    two.items.map((e) => e.seq),
    [4, 5, 6, 7, 8],
  );
  assert.equal(two.earlier, 4);
});

test("windowedTranscript: asking for more turns than exist returns everything", () => {
  const all = windowedTranscript(LOG, { tailTurns: 99 });
  assert.equal(all.items.length, LOG.length);
  assert.equal(all.earlier, 0);
});

test("windowedTranscript: no window returns everything", () => {
  const all = windowedTranscript(LOG);
  assert.equal(all.items.length, LOG.length);
  assert.equal(all.earlier, 0);
});

test("windowedTranscript: sinceSeq re-reads from an anchor, counting what it skipped", () => {
  const w = windowedTranscript(LOG, { sinceSeq: 4 });
  assert.deepEqual(
    w.items.map((e) => e.seq),
    [4, 5, 6, 7, 8],
  );
  assert.equal(w.earlier, 4);

  const none = windowedTranscript(LOG, { sinceSeq: 0 });
  assert.equal(none.items.length, LOG.length);
  assert.equal(none.earlier, 0);

  const past = windowedTranscript(LOG, { sinceSeq: 999 });
  assert.equal(past.items.length, 0, "an anchor past the end yields an empty window");
  assert.equal(past.earlier, LOG.length);
});

test("windowedTranscript: beforeSeq pages history backward on turn boundaries", () => {
  const page = windowedTranscript(LOG, { beforeSeq: 6, tailTurns: 1 });
  assert.deepEqual(
    page.items.map((e) => e.seq),
    [4, 5],
    "the turn immediately before the anchor",
  );
  assert.equal(page.earlier, 4, "what remains before THIS page, not before the original tail");

  const next = windowedTranscript(LOG, { beforeSeq: 4, tailTurns: 1 });
  assert.deepEqual(
    next.items.map((e) => e.seq),
    [0, 1, 2, 3],
  );
  assert.equal(next.earlier, 0, "the log is exhausted — the button disappears");
});

test("windowedTranscript: beforeSeq alone truncates; wider-than-history pages return everything left", () => {
  const prefix = windowedTranscript(LOG, { beforeSeq: 4 });
  assert.deepEqual(
    prefix.items.map((e) => e.seq),
    [0, 1, 2, 3],
  );
  assert.equal(prefix.earlier, 0);

  const wide = windowedTranscript(LOG, { beforeSeq: 6, tailTurns: 99 });
  assert.deepEqual(
    wide.items.map((e) => e.seq),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(wide.earlier, 0);

  const past = windowedTranscript(LOG, { beforeSeq: 999, tailTurns: 1 });
  assert.deepEqual(
    past.items.map((e) => e.seq),
    [6, 7, 8],
    "an anchor past the end behaves like a plain tail read",
  );
});

function fat(seq: number, type: ItemKind, chars: number): Item {
  return { ...entry(seq, type), body: { tool: "execute", output: "x".repeat(chars) } };
}

test("windowedTranscript: a fat tool payload is previewed, and the entry says so", () => {
  const log = [
    entry(0, "UserMessage"),
    fat(1, "ToolCall", 50_000),
    fat(2, "ToolResult", 50_000),
    entry(3, "AgentMessage"),
  ];
  const w = windowedTranscript(log, { tailTurns: 1 });
  assert.equal(w.items.length, 4);
  for (const e of w.items.filter((x) => x.kind === "ToolCall" || x.kind === "ToolResult")) {
    assert.equal((e.body as { output: string }).output.length, TOOL_TEXT_PREVIEW_CHARS);
    assert.equal(e.truncated, true);
  }
  assert.equal(w.items[0]!.truncated, undefined, "a small entry is shipped whole and unmarked");
});

test("windowedTranscript: conversation text is never truncated — only tool payloads are", () => {
  const said = "y".repeat(50_000);
  const log = [
    { ...entry(0, "UserMessage"), text: said },
    { ...entry(1, "AgentMessage"), text: said },
    { ...entry(2, "Reasoning"), text: said },
  ];
  for (const e of windowedTranscript(log).items) {
    assert.equal(e.text!.length, said.length);
    assert.equal(e.truncated, undefined);
  }
});

function start(): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  const base = listenLocal(server);
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("GET /v1/sessions/:id honors tailTurns/sinceSeq and reports earlierItems", async () => {
  const srv = start();
  try {
    const actor = { externalId: "U1" };
    const threadRef = "web:U1:window-test";
    let sessionId = "";
    for (const text of ["first turn", "second turn", "third turn"]) {
      const r = await fetch(`${srv.base}/v1/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: { kind: "direct" },
          surface: "test",
          actor,
          conversation: { kind: "dm", threadRef },
          text,
        }),
      });
      const body = (await r.json()) as { status: string; sessionId?: string };
      assert.equal(body.status, "ok");
      sessionId = body.sessionId!;
    }

    const full = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1`);
    assert.equal(full.status, 200);
    const fullBody = (await full.json()) as { items: Item[]; earlierItems?: number };
    assert.equal(fullBody.earlierItems, undefined, "an unwindowed read never reports earlierItems");
    const userSeqs = fullBody.items.filter((e) => e.kind === "UserMessage").map((e) => e.seq);
    assert.equal(userSeqs.length, 3);

    const tail = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&tailTurns=1`);
    assert.equal(tail.status, 200);
    const tailBody = (await tail.json()) as { items: Item[]; earlierItems?: number };
    assert.equal(tailBody.items[0]!.seq, userSeqs[2], "the window opens on the last turn's user entry");
    assert.equal(tailBody.earlierItems, userSeqs[2], "everything before the anchor is counted, not shipped");
    assert.equal(tailBody.items.length + tailBody.earlierItems!, fullBody.items.length);

    const since = await fetch(
      `${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&sinceSeq=${userSeqs[1]}`,
    );
    const sinceBody = (await since.json()) as { items: Item[]; earlierItems?: number };
    assert.equal(sinceBody.items[0]!.seq, userSeqs[1], "sinceSeq re-reads from the same boundary");

    const wide = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&tailTurns=999`);
    const wideBody = (await wide.json()) as { items: Item[]; earlierItems?: number };
    assert.equal(wideBody.items.length, fullBody.items.length);
    assert.equal(wideBody.earlierItems, undefined);

    const before = await fetch(
      `${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&beforeSeq=${userSeqs[2]}&tailTurns=1`,
    );
    assert.equal(before.status, 200);
    const beforeBody = (await before.json()) as { items: Item[]; earlierItems?: number };
    assert.equal(beforeBody.items[0]!.seq, userSeqs[1], "the page opens on the previous turn's user entry");
    assert.ok(
      beforeBody.items.every((e) => e.seq < userSeqs[2]!),
      "nothing at or past the anchor is re-shipped",
    );
    assert.equal(beforeBody.earlierItems, userSeqs[1], "what remains before this page");

    const seq = fullBody.items[0]!.seq;
    const one = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}/items/${seq}?viewer=U1`);
    assert.equal(one.status, 200);
    const oneBody = (await one.json()) as { item: Item };
    const { truncated, ...shown } = fullBody.items[0] as Item & { truncated?: true };
    assert.equal(truncated, true, "the view marks a user entry whose model-only context it left out");
    assert.equal((shown.body as { environment?: unknown }).environment, undefined);
    assert.equal((shown.body as { memoryRecall?: unknown }).memoryRecall, undefined);
    assert.equal(typeof (oneBody.item.body as { environment?: unknown }).environment, "string");
    assert.deepEqual(
      {
        ...oneBody.item,
        body: { ...oneBody.item.body, environment: undefined, environmentSnapshot: undefined },
      },
      { ...shown, body: { ...shown.body, environment: undefined, environmentSnapshot: undefined } },
      "the whole entry, exactly as stored, is one fetch away",
    );

    const missing = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}/items/99999?viewer=U1`);
    assert.equal(missing.status, 404, "a seq that isn't in this session");
    const stranger = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}/items/${seq}?viewer=U2`);
    assert.equal(stranger.status, 404, "a viewer who cannot see the session cannot see its entries");
    const noViewer = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}/items/${seq}`);
    assert.equal(noViewer.status, 400, "viewer is required");

    const bad = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&tailTurns=0`);
    assert.equal(bad.status, 400, "tailTurns must be a positive integer");
    const badSince = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&sinceSeq=-1`);
    assert.equal(badSince.status, 400, "sinceSeq must be non-negative");
    const badBefore = await fetch(`${srv.base}/v1/sessions/${encodeURIComponent(sessionId)}?viewer=U1&beforeSeq=0`);
    assert.equal(badBefore.status, 400, "beforeSeq must be a positive integer");
  } finally {
    await srv.close();
  }
});

test("windowedTranscript: an unwindowed read is still whole — fork cutoffs count on it", () => {
  const log = [entry(0, "UserMessage")];
  for (let seq = 1; seq <= 400; seq++) log.push(fat(seq, "ToolResult", TOOL_TEXT_PREVIEW_CHARS * 3));
  const all = windowedTranscript(log);
  assert.equal(all.items.length, log.length, "no window asked for, nothing dropped");
  assert.equal(all.earlier, 0);
  assert.equal(all.items[1]!.truncated, true, "though fat payloads are still previewed");
});

test("windowedTranscript: the text a post tool call puts in the conversation is never previewed", () => {
  const said = "z".repeat(50_000);
  const log = [
    entry(0, "UserMessage"),
    { ...entry(1, "ToolCall"), tool: "reach", callId: "c1", body: { action: "post", text: said } },
    { ...entry(2, "ToolResult"), tool: "reach", callId: "c1", body: { ok: true } },
  ];
  const posted = windowedTranscript(log, { tailTurns: 1 }).items[1]!;
  assert.equal((posted.body as { text: string }).text.length, said.length, "the agent's reply is conversation text");
  assert.equal(posted.truncated, undefined);
});

test("windowedTranscript: a deeply nested payload cannot smuggle bytes past the preview", () => {
  const deep = (depth: number, leaf: unknown): unknown => (depth === 0 ? leaf : { nest: deep(depth - 1, leaf) });
  const log = [entry(0, "UserMessage")];
  for (let seq = 1; seq <= 6; seq++) {
    log.push({ ...entry(seq, "ToolResult"), body: { tool: "execute", out: deep(12, "q".repeat(300_000)) } });
  }
  const w = windowedTranscript(log, { tailTurns: 1 });
  const shipped = JSON.stringify(w.items).length;
  assert.ok(
    shipped < 7 * 2 * TOOL_TEXT_PREVIEW_CHARS,
    `a nested subtree must be charged its real size, shipped ${shipped}`,
  );
});

test("windowedTranscript: a sinceSeq re-read is never trimmed — it refreshes what the client already holds", () => {
  const log = [entry(0, "UserMessage")];
  for (let seq = 1; seq <= 400; seq++) log.push(fat(seq, "ToolResult", TOOL_TEXT_PREVIEW_CHARS * 3));
  const w = windowedTranscript(log, { sinceSeq: 1 });
  assert.equal(w.items.length, log.length - 1, "a refresh that shrinks the window makes read messages vanish");
  assert.equal(w.earlier, 1);
});

test("a user entry carrying huge model-only context no longer hides the turns before it", () => {
  const context = "c".repeat(300_000);
  const log: Item[] = [];
  for (let turn = 0; turn < 4; turn++) {
    log.push({
      ...entry(turn * 2, "UserMessage"),
      text: `ask ${turn}`,
      body: {
        environment: context,
        environmentSnapshot: { hashes: { Skills: "abc" }, sessionId: "s" },
        memoryRecall: { body: context },
      },
    });
    log.push(entry(turn * 2 + 1, "AgentMessage"));
  }
  const w = windowedTranscript(log, { tailTurns: 25 });
  assert.equal(w.earlier, 0, "every turn is shipped; nothing is pushed behind the earlier button");
  assert.deepEqual(
    w.items.map((e) => e.seq),
    log.map((e) => e.seq),
  );
  for (const user of w.items.filter((e) => e.kind === "UserMessage")) {
    assert.deepEqual(user.body, {}, "model-only context stays out of the view");
    assert.equal(user.truncated, true, "the full entry is one lazy fetch away");
  }
  assert.ok(JSON.stringify(w.items).length < 10_000);
});

test("thinking entries keep their text but not the provider's signature", () => {
  const log = [
    entry(0, "UserMessage"),
    { ...entry(1, "Reasoning"), text: "weighing it", body: { thinkingSignature: "s".repeat(50_000) } },
  ];
  const thought = windowedTranscript(log, { tailTurns: 1 }).items[1]!;
  assert.equal(thought.text, "weighing it");
  assert.deepEqual(thought.body, {});
  assert.equal(thought.truncated, true);
});

test("paging is by turns alone, however large the turns are", () => {
  const log: Item[] = [];
  const said = (n: number): Item => ({ ...entry(n, "AgentMessage"), text: "s".repeat(50_000) });
  for (let turn = 0; turn < 40; turn++) {
    log.push(entry(turn * 2, "UserMessage"));
    log.push(said(turn * 2 + 1));
  }
  const w = windowedTranscript(log, { tailTurns: 25 });
  assert.equal(w.items.filter((e) => e.kind === "UserMessage").length, 25);
  assert.equal(w.earlier, 30);
});
