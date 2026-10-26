import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";
import type { CoreSession } from "../src/core-bridge.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

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
