import { item } from "./support/item-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./support/deep-link-boot-fixture.ts";
import type { CoreSession } from "../src/core-bridge.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

test("fork feedback survives delayed success, failure, and navigation", async () => {
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    canContinue: true,
    type: "dm",
    createdAt: Date.now(),
    title: "Source conversation",
  };
  const items = [item("UserMessage", { seq: 0, createdAt: Date.now(), text: "Fork this message" })];
  const h = await harness({ path: "/s/source", session: source, listSessions: [source], items });
  let finish: (response: Response) => void = () => {};
  const anchorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLAnchorElement");
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    Object.defineProperty(globalThis, "HTMLAnchorElement", { configurable: true, value: window.HTMLAnchorElement });
    const baseFetch = globalThis.fetch;
    for (const outcome of ["success", "failure", "navigate"] as const) {
      await h.openSession(source);
      await until(() => document.querySelector(".msg-fork") !== null);
      const response = new Promise<Response>((resolve) => (finish = resolve));
      let requests = 0;
      globalThis.fetch = (input, init) => {
        if (String(input).endsWith("/api/sessions/source/fork")) {
          requests++;
          return response;
        }
        return baseFetch(input, init);
      };
      const button = document.querySelector<HTMLButtonElement>(".msg-fork")!;
      button.click();
      assert.equal(button.disabled, true);
      assert.equal(button.getAttribute("aria-busy"), "true");
      button.dispatchEvent(new window.MouseEvent("mouseenter"));
      assert.equal(document.querySelector("[role=tooltip]")?.textContent, "Forking...");
      button.dispatchEvent(new window.MouseEvent("mouseleave"));
      assert.match(document.querySelector(".session[aria-busy=true]")?.textContent ?? "", /Forking/);
      button.click();
      await until(() => requests === 1);
      await h.refreshSessions();
      assert.match(document.querySelector(".session[aria-busy=true]")?.textContent ?? "", /Forking/);
      const pending = h.sessionsState.list.find((session) => !session.id)!;
      await h.openSession(pending as CoreSession);
      assert.equal(h.visibleConversation().state.sessionId, source.id);
      const conv = h.visibleConversation();
      if (outcome === "navigate") conv.newChat();
      const newThread = conv.state.threadRef;
      const fork: CoreSession = {
        ...source,
        id: "fork",
        threadRef: "web:tester:fork",
        title: "Source conversation (fork)",
        forkedFrom: { sessionId: source.id, title: source.title },
        forkBoundarySeq: 0,
      };
      const refreshes = h.requests.filter((path) => path.startsWith("/api/sessions?")).length;
      finish(
        outcome === "failure"
          ? Response.json({ error: "Could not copy history" }, { status: 500 })
          : Response.json({ session: fork, items }),
      );
      await until(() => !document.querySelector(".session[aria-busy=true]"));
      assert.equal(requests, 1);
      assert.equal(
        h.sessionsState.list.some((session) => !session.id),
        false,
      );
      if (outcome === "failure") {
        assert.equal(conv.state.sessionId, source.id);
        assert.equal(document.querySelector<HTMLButtonElement>(".msg-fork")?.disabled, false);
        assert.match(h.mainText(), /Could not copy history/);
      } else {
        assert.equal(h.sessionsState.list.filter((session) => session.id === fork.id).length, 1);
        assert.equal(h.requests.filter((path) => path.startsWith("/api/sessions?")).length, refreshes);
        if (outcome === "navigate") assert.equal(conv.state.threadRef, newThread);
        else assert.equal(conv.state.sessionId, fork.id);
      }
    }
  } finally {
    finish(Response.json({ error: "test ended" }, { status: 500 }));
    await h.close();
    if (anchorDescriptor) Object.defineProperty(globalThis, "HTMLAnchorElement", anchorDescriptor);
    else Reflect.deleteProperty(globalThis, "HTMLAnchorElement");
  }
});

const text = (el: Element | null | undefined): string => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

for (const layout of ["one pane", "two panes"] as const) {
  test(`forking in ${layout} moves the pane, tab, sidebar and URL to the fork`, async () => {
    const source: CoreSession = {
      id: "source",
      threadRef: "web:tester:source",
      scopeId: "personal:tester",
      canContinue: true,
      type: "dm",
      createdAt: Date.now() - 1000,
      title: "Source conversation",
    };
    const fork: CoreSession = {
      ...source,
      id: "fork",
      threadRef: "web:tester:fork",
      createdAt: Date.now(),
      title: "Source conversation (fork)",
      forkedFrom: { sessionId: source.id, title: source.title },
      forkBoundarySeq: 0,
    };
    const items = [item("UserMessage", { seq: 0, createdAt: Date.now(), text: "Fork this message" })];
    const listSessions: CoreSession[] = [source];
    const h = await harness({
      path: "/s/source",
      session: source,
      listSessions,
      items,
      savedCanvas: layout === "two panes",
      api: (path) => {
        if (path.endsWith("/api/sessions/source/fork")) {
          listSessions.unshift(fork);
          return Response.json({ session: fork, items });
        }
        if (path.startsWith("/api/sessions/fork")) return Response.json({ session: fork, items });
        return undefined;
      },
    });
    const anchorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLAnchorElement");
    try {
      h.releaseSessions();
      await h.boot();
      await h.sessionsReady();
      Object.defineProperty(globalThis, "HTMLAnchorElement", { configurable: true, value: window.HTMLAnchorElement });
      await h.openSession(source);
      await until(() => document.querySelector(".msg-fork") !== null);
      const pane = document.querySelector(".msg-fork")!.closest(".dv-groupview")!;
      assert.match(text(pane.querySelector(".split-pane-title-text")), /^Source conversation$/);

      document.querySelector<HTMLButtonElement>(".msg-fork")!.click();
      await until(() => text(pane.querySelector(".split-pane-title-text")) === "Source conversation (fork)");
      await h.refreshSessions();

      assert.match(text(pane), /Forked from Source conversation/);
      const active = [...document.querySelectorAll(".session-row.active")].map(text);
      assert.equal(active.length, 1, `active rows: ${JSON.stringify(active)}`);
      assert.match(active[0]!, /Source conversation \(fork\)/);
      if (layout === "one pane") assert.equal(window.location.pathname, "/s/fork");
      const saved = JSON.parse(window.localStorage.getItem("web-ui:split-canvas:v1") ?? "{}") as {
        layout?: { panels?: Record<string, { params?: { sessionId?: string } }> };
      };
      const sessionIds = Object.values(saved.layout?.panels ?? {}).map((panel) => panel.params?.sessionId);
      assert.ok(sessionIds.includes("fork"), `saved layout keeps ${JSON.stringify(sessionIds)}`);
      assert.ok(!sessionIds.includes("source"), `saved layout keeps ${JSON.stringify(sessionIds)}`);
    } finally {
      await h.close();
      if (anchorDescriptor) Object.defineProperty(globalThis, "HTMLAnchorElement", anchorDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLAnchorElement");
    }
  });
}
