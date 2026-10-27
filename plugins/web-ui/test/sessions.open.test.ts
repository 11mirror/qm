import { item } from "./support/item-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { CoreSession } from "../src/core-bridge.ts";
import { harness, SESSION } from "./support/deep-link-boot-fixture.ts";
import { getModel } from "@earendil-works/pi-ai";

const items = [item("UserMessage", { seq: 1, createdAt: Date.now(), text: "please run the deploy" })];
const approval = { requestId: "a1", command: "deploy --prod", reason: "requires approval" };
const OTHER = { ...SESSION, id: "sess-other", threadRef: "web:tester:other", title: "Other chat" } as CoreSession;

const cards = (): number => document.querySelectorAll(".approval-btn").length;
const chatText = (): string => document.querySelector(".main")?.textContent ?? "";

function promptly<T>(opening: Promise<T>): Promise<T> {
  const stalled = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("opening the chat waited for its approvals")), 3000),
  );
  return Promise.race([opening, stalled]);
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition did not settle");
}

test("a chat draws its transcript before its approvals arrive, then shows the card", async () => {
  const h = await harness({ path: "/s/sess-deep", items, holdApprovals: true, approvals: () => [approval] });
  try {
    await promptly(h.boot());
    const conv = h.visibleConversation();
    assert.equal(conv.state.sessionId, SESSION.id);
    assert.match(chatText(), /please run the deploy/, "the transcript is drawn while approvals are in flight");
    assert.equal(cards(), 0);
    assert.equal(conv.hasUnresolvedApproval(), false, "nothing blocks the composer until an approval arrives");

    h.releaseApprovals();
    await until(() => cards() > 0);
    assert.match(chatText(), /please run the deploy/);
    assert.deepEqual(
      conv.activePendingApprovals().map((a) => a.requestId),
      ["a1"],
    );
    assert.equal(conv.hasUnresolvedApproval(), true, "a blocking approval locks the composer");
  } finally {
    await h.close();
  }
});

test("a transcript refresh that fails while approvals load doesn't lose the card", async () => {
  const h = await harness({ path: "/s/sess-deep", holdApprovals: true, approvals: () => [approval] });
  try {
    await promptly(h.boot());
    const conv = h.visibleConversation();
    h.setTranscriptStatus(503);
    const refreshes = h.requests.length;
    conv.onDelivery(SESSION.threadRef);
    await until(() => h.requests.slice(refreshes).some((p) => /^\/api\/sessions\/sess-deep($|\?)/.test(p)));
    await new Promise((resolve) => setTimeout(resolve, 20));

    h.releaseApprovals();
    await until(() => cards() > 0);
    assert.deepEqual(
      conv.activePendingApprovals().map((a) => a.requestId),
      ["a1"],
    );
  } finally {
    await h.close();
  }
});

test("approvals arriving mid-refresh wait for it instead of discarding its transcript", async () => {
  let refreshHeld: Promise<void> | null = null;
  let releaseRefresh = (): void => {};
  const reply = item("AgentMessage", { seq: 2, createdAt: Date.now(), text: "deployed to prod" });
  const h = await harness({
    path: "/s/sess-deep",
    holdApprovals: true,
    approvals: () => [approval],
    api: (path) =>
      refreshHeld && path === `/api/sessions/${SESSION.id}`
        ? refreshHeld.then(() => Response.json({ session: SESSION, items: [reply] }))
        : undefined,
  });
  try {
    await promptly(h.boot());
    const conv = h.visibleConversation();
    refreshHeld = new Promise((resolve) => (releaseRefresh = resolve));
    conv.onDelivery(SESSION.threadRef);
    await until(() => h.requests.includes(`/api/sessions/${SESSION.id}`));
    h.releaseApprovals();
    await new Promise((resolve) => setTimeout(resolve, 20));

    releaseRefresh();
    await until(() => cards() > 0);
    assert.ok(
      JSON.stringify(conv.state.agent?.state.messages).includes("deployed to prod"),
      "the refresh's new reply is kept",
    );
    assert.deepEqual(
      conv.activePendingApprovals().map((a) => a.requestId),
      ["a1"],
    );
  } finally {
    await h.close();
  }
});

test("approvals that land after switching chats stay out of the new chat", async () => {
  const h = await harness({
    path: "/",
    holdApprovals: true,
    listSessions: [SESSION, OTHER],
    approvals: (id) => (id === SESSION.id ? [approval] : []),
    api: (path) =>
      path.startsWith(`/api/sessions/${OTHER.id}?`) ? Response.json({ session: OTHER, items: [] }) : undefined,
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    await promptly(h.openSession(SESSION as CoreSession));
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id, "the chat opens without its approvals");
    await promptly(h.openSession(OTHER));
    assert.equal(h.visibleConversation().state.sessionId, OTHER.id);

    h.releaseApprovals();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const conv = h.visibleConversation();
    assert.equal(conv.state.sessionId, OTHER.id);
    assert.equal(cards(), 0);
    assert.deepEqual(conv.activePendingApprovals(), []);
    assert.equal(conv.hasUnresolvedApproval(), false);
  } finally {
    await h.close();
  }
});

async function untilSettled(check: () => boolean, describe: () => unknown = () => ""): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), `condition never held ${String(describe())}`);
}

test("a session change the server refuses is undone with a visible notice", async () => {
  const opened: CoreSession = {
    id: "chat-open",
    threadRef: "web:tester:open",
    scopeId: "personal:tester",
    type: "dm",
    title: "Open chat",
    createdAt: 2_000_000,
  };
  const other: CoreSession = { ...opened, id: "chat-other", threadRef: "web:tester:other", title: "Other chat" };
  const h = await harness({
    path: `/s/${opened.id}`,
    session: opened,
    listSessions: [opened, other],
    api: (path, init) =>
      path === `/api/sessions/${other.id}` && init?.method === "POST"
        ? Response.json({ error: "nope" }, { status: 500 })
        : undefined,
  });
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    const sidebar = document.querySelector("#sidebar-body")!;
    const archive = sidebar.querySelector<HTMLButtonElement>(`[aria-label="Archive ${other.title}"]`);
    assert.ok(archive);
    archive.click();
    await untilSettled(
      () => document.querySelector(".split-toast")?.textContent === "Couldn't save that change.",
      () => document.querySelector(".split-toast")?.textContent,
    );
    await untilSettled(() => Boolean(sidebar.querySelector(`[data-session-id="${other.id}"]`)));
  } finally {
    await h.close();
  }
});

test("a new pane adopts its saved identity and later title while its first turn is streaming", async () => {
  const listSessions: CoreSession[] = [];
  const h = await harness({ path: "/", listSessions });
  let stopStream = (): void => {};
  let turn: Promise<void> | undefined;
  let turnError: unknown;
  try {
    h.releaseSessions();
    await h.boot();
    const conversation = h.visibleConversation();
    const { agent, threadRef } = conversation.state;
    assert.ok(agent);
    assert.ok(threadRef);
    assert.equal(conversation.state.sessionId, null);
    assert.match(document.querySelector(".split-pane-title-text")?.textContent ?? "", /New session/);
    await agent.waitForIdle();
    agent.state.model = getModel("openai", "gpt-4o");
    agent.streamFn = () =>
      new Promise((_resolve, reject) => {
        stopStream = () => reject(new Error("QA stream stopped"));
      });
    turn = agent.prompt("Investigate live title updates").catch((error) => {
      turnError = error;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(agent.state.isStreaming, String(turnError));
    const session: CoreSession = {
      id: "newly-saved-session",
      threadRef,
      scopeId: "personal:tester",
      type: "dm",
      createdAt: Date.now(),
      title: "",
    };
    listSessions.push(session);
    await h.refreshSessions();
    assert.equal(conversation.state.sessionId, session.id);
    assert.equal(conversation.state.rememberedSessionId, session.id);
    assert.equal(location.pathname, `/s/${session.id}`);
    assert.ok(document.querySelector('[aria-label="Share conversation"]'));
    assert.match(localStorage.getItem("web-ui:split-canvas:v1") ?? "", /newly-saved-session/);

    session.title = "Investigate live title updates";
    await h.refreshSessions();
    assert.equal(document.querySelector(".split-pane-title-text")?.textContent, session.title);
    assert.match(document.title, /Investigate live title updates/);
    assert.ok(agent.state.isStreaming, String(turnError));
    assert.equal(conversation.state.agent, agent);
    assert.equal(document.querySelectorAll(".split-pane-content").length, 1);

    session.title = "Renamed during the same turn";
    await h.refreshSessions();
    assert.equal(document.querySelector(".split-pane-title-text")?.textContent, session.title);
    assert.ok(agent.state.isStreaming, String(turnError));
  } finally {
    stopStream();
    await turn;
    await h.close();
  }
});
