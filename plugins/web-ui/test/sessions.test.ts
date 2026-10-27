import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { browserEnv } from "./support/browser-env.ts";
import type { CoreSession } from "../src/core-bridge.ts";
import { harness } from "./support/deep-link-boot-fixture.ts";

test("session refresh bursts share one trailing read and observe its fresh list", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const sessionA = {
    id: "sess-a",
    threadRef: "web:alex:aaa",
    scopeId: "personal:alex",
    title: "Review sample workspace",
  };
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.startsWith("/api/sessions?")) return new Promise<Response>((resolve) => pending.push(resolve));
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState, sessionsReady, refreshSessions } = await vite.ssrLoadModule("/src/sessions.ts");
    appState.me = { user: "alex", org: "acme" };
    const boot = refreshSessions({ silent: true });
    const pane1 = (async () => {
      const refreshed = await refreshSessions({ silent: true });
      return { refreshed, found: sessionsState.list.some((s: { id: string }) => s.id === sessionA.id) };
    })();
    const pane2 = refreshSessions({ silent: true });

    let ready = false;
    const readiness = sessionsReady().then(() => {
      ready = true;
    });

    assert.equal(pending.length, 1, "a burst must not run overlapping session reads");
    pending[0]!(Response.json({ sessions: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pending.length, 2, "one trailing read observes changes newer than the first snapshot");
    assert.equal(ready, false, "sessionsReady() must wait for the fresh read");
    pending[1]!(Response.json({ sessions: [sessionA] }));
    assert.equal(await pane2, true, "the winning refresh reports success");
    assert.equal(await boot, true, "a superseded refresh resolves with the winner's outcome");
    const p1 = await pane1;
    assert.equal(p1.refreshed, true);
    assert.equal(p1.found, true, "a superseded awaiter sees the session — no empty read-only stub");
    await readiness;
    assert.ok(sessionsState.list.some((s: { id: string }) => s.id === sessionA.id));
  } finally {
    await vite.close();
  }
});

test("a failed lone refresh still settles sessionsReady and reports the error path", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error("network down");
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { sessionsReady, refreshSessions } = await vite.ssrLoadModule("/src/sessions.ts");
    assert.equal(await refreshSessions({ silent: true }), false);
    await sessionsReady();
  } finally {
    await vite.close();
  }
});

function jsdomGlobals(): JSDOM {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return dom;
}

test("opening a conversation joins the first list load and leaves a current list to the delivery stream", async () => {
  const dom = jsdomGlobals();
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.startsWith("/api/sessions?")) return new Promise<Response>((resolve) => pending.push(resolve));
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, refreshSessionsOnOpen, sessionsReady } = await vite.ssrLoadModule("/src/sessions.ts");
    const first = refreshSessions({ showLoading: true });
    refreshSessionsOnOpen();
    refreshSessionsOnOpen();
    assert.equal(pending.length, 1, "the first list load answers every conversation opened while it runs");

    pending[0]!(Response.json({ sessions: [] }));
    assert.equal(await first, true);
    await sessionsReady();

    refreshSessionsOnOpen();
    refreshSessionsOnOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      pending.length,
      1,
      "once it has landed, opening a conversation leaves the list to the delivery stream",
    );
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("a failed list load does not lock out the next conversation open", async () => {
  const dom = jsdomGlobals();
  let hits = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    hits++;
    throw new Error("network down");
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, refreshSessionsOnOpen, sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    assert.equal(await refreshSessions({ showLoading: true }), false);
    assert.equal(sessionsState.loaded, false);
    refreshSessionsOnOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hits, 2, "nothing is in flight to defer to — the open must retry");
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("after a background refresh fails, the next open refetches the loaded list", async () => {
  const dom = jsdomGlobals();
  const sessions = [{ id: "a", threadRef: "web:alex:a", scopeId: "personal:alex", title: "Before" }];
  let failing = false;
  let hits = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    hits++;
    if (failing) throw new Error("network down");
    return Response.json({ sessions });
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, refreshSessionsOnOpen, sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    assert.equal(await refreshSessions({ showLoading: true }), true);
    failing = true;
    assert.equal(await refreshSessions({ silent: true }), false);
    failing = false;
    sessions[0]!.title = "After";
    refreshSessionsOnOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hits, 3, "an open repairs a list whose last refresh failed");
    assert.equal(sessionsState.list[0]?.title, "After");
    refreshSessionsOnOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hits, 3, "and leaves it alone once it is current again");
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("an open that joined a refresh whose answer was discarded asks again itself", async () => {
  const dom = jsdomGlobals();
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.startsWith("/api/sessions?")) return new Promise<Response>((resolve) => pending.push(resolve));
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, refreshSessionsOnOpen, sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const stale = refreshSessions({ silent: true, patchEpoch: -1 });
    refreshSessionsOnOpen();
    refreshSessionsOnOpen();
    assert.equal(pending.length, 1, "both opens join the refresh already running");

    pending[0]!(Response.json({ sessions: [{ id: "b", threadRef: "web:alex:b", scopeId: "personal:alex" }] }));
    assert.equal(await stale, false, "a patch landing mid-flight makes a refresh discard its answer");
    assert.equal(sessionsState.list.length, 0, "so the list it fetched never reaches the sidebar");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(pending.length, 2, "the opens that joined it ask again — once between them, not once each");
    pending[1]!(Response.json({ sessions: [{ id: "b", threadRef: "web:alex:b", scopeId: "personal:alex" }] }));
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("an open that joined a refresh that simply failed does not double the load", async () => {
  const dom = jsdomGlobals();
  let hits = 0;
  let fail = (): void => {};
  const failed = new Promise<void>((resolve) => (fail = resolve));
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    hits++;
    await failed;
    throw new Error("network down");
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, refreshSessionsOnOpen } = await vite.ssrLoadModule("/src/sessions.ts");
    const doomed = refreshSessions({ silent: true });
    refreshSessionsOnOpen();
    refreshSessionsOnOpen();
    fail();
    assert.equal(await doomed, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hits, 1, "a refresh that failed is not worth asking three more times while the server is down");
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("queued refreshes recover a failed read and retain the latest patch epoch", async () => {
  const dom = jsdomGlobals();
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/contexts") return Response.json({ contexts: [] });
    return new Promise<Response>((resolve) => pending.push(resolve));
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const first = refreshSessions({ silent: true });
    const outdated = refreshSessions({ silent: true, patchEpoch: -1 });
    const current = refreshSessions({ silent: true });
    assert.equal(pending.length, 1);
    pending[0]!(Response.json({ error: "unavailable" }, { status: 503 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pending.length, 2);
    const session = { id: "s", threadRef: "web:alex:s", scopeId: "personal:alex", title: "Current" };
    pending[1]!(Response.json({ sessions: [session] }));
    assert.deepEqual(await Promise.all([first, outdated, current]), [true, true, true]);
    assert.equal(sessionsState.list[0]?.title, "Current");

    const started = refreshSessions({ silent: true });
    const stale = refreshSessions({ silent: true, patchEpoch: -1 });
    pending[2]!(Response.json({ sessions: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending[3]!(Response.json({ sessions: [{ ...session, title: "Stale" }] }));
    assert.deepEqual(await Promise.all([started, stale]), [false, false]);
    assert.equal(sessionsState.list[0]?.title, "Current", "a queued obsolete patch recovery cannot overwrite state");
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("a stalled refresh can be replaced without old requests trapping later refreshes", async (t) => {
  const dom = jsdomGlobals();
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/contexts") return Response.json({ contexts: [] });
    return new Promise<Response>((resolve) => pending.push(resolve));
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const stalled = refreshSessions({ silent: true });
    const queued = refreshSessions({ silent: true });
    now += 10_001;
    const replacement = refreshSessions({ silent: true });
    assert.equal(pending.length, 2, "a stalled request must not hold every caller indefinitely");
    const session = { id: "s", threadRef: "web:alex:s", scopeId: "personal:alex", title: "Replacement" };
    pending[1]!(Response.json({ sessions: [session] }));
    assert.equal(await replacement, true);
    const fresh = refreshSessions({ silent: true });
    assert.equal(pending.length, 3, "the stalled request cannot make a finished replacement look active");
    pending[2]!(Response.json({ sessions: [{ ...session, title: "Fresh" }] }));
    assert.equal(await fresh, true);
    pending[0]!(Response.json({ sessions: [] }));
    assert.deepEqual(await Promise.all([stalled, queued]), [true, true]);
    assert.equal(sessionsState.list[0]?.title, "Fresh");
    assert.equal(pending.length, 3, "the abandoned queued refresh must not run after its replacement");
  } finally {
    await vite.close();
    dom.window.close();
  }
});

for (const stored of [null, "1", "0", "unavailable"] as const) {
  test(`sidebar surface preference: ${stored ?? "fresh browser"}`, async () => {
    const sessions = [
      {
        id: "web",
        threadRef: "web:tester:one",
        scopeId: "personal:tester",
        surface: "web",
        title: "Web chat",
        canContinue: true,
        createdAt: 3,
      },
      {
        id: "slack",
        threadRef: "ch:C_TEAM:1700000000.000100",
        scopeId: "channel:C_TEAM",
        surface: "slack",
        title: "Team chat",
        createdAt: 2,
      },
      {
        id: "group",
        threadRef: "grp:C_PRIVATE:1700000000.000200",
        scopeId: "channel:C_PRIVATE",
        surface: "slack",
        title: "Private channel thread",
        createdAt: 1.5,
      },
      {
        id: "cron-run",
        threadRef: "cron:c1:fire:abc",
        scopeId: "personal:tester",
        surface: "cron",
        createdAt: 5,
      },
      {
        id: "webhook-run",
        threadRef: "agent:main:webhook:w1",
        scopeId: "personal:tester",
        surface: "webhook",
        createdAt: 4,
      },
      { id: "child", threadRef: "web:tester:child", scopeId: "personal:tester", parentSessionId: "web", createdAt: 1 },
      {
        id: "archived",
        threadRef: "ch:C_TEAM:1699999999.000100",
        scopeId: "channel:C_TEAM",
        archived: true,
        createdAt: 0,
      },
    ];
    const env = await browserEnv({
      fetch: async (input) => {
        if (String(input).startsWith("/api/sessions?")) return Response.json({ sessions });
        if (String(input) === "/api/contexts") return Response.json({ contexts: [] });
        throw new Error(`Unexpected request: ${input}`);
      },
    });
    try {
      if (stored === "unavailable") {
        const getItem = localStorage.getItem.bind(localStorage);
        env.dom.window.Storage.prototype.getItem = (key: string) => {
          if (key === "web-ui:web-only") throw new Error("Storage unavailable");
          return getItem(key);
        };
      } else if (stored !== null) localStorage.setItem("web-ui:web-only", stored);
      const shell = await env.vite.ssrLoadModule("/src/shell.ts");
      const sidebar = await env.vite.ssrLoadModule("/src/sessions.ts");
      shell.appState.me = { user: "tester", org: "test", permissions: [] };
      shell.mountShell();
      await sidebar.refreshSessions();
      const rowIds = () =>
        [...document.querySelectorAll<HTMLElement>("#sidebar-body .session-row")].map((row) => row.dataset.sessionId);
      const slackRow = () => document.querySelector('[data-session-id="slack"]');
      const groupRow = () => document.querySelector('[data-session-id="group"]');
      assert.deepEqual(rowIds(), stored === "1" ? ["web"] : ["web", "slack", "group"]);
      if (stored !== "1") {
        assert.ok(slackRow()?.querySelector(".slack-mark"));
        assert.ok(groupRow()?.querySelector(".slack-mark"));
        assert.match(slackRow()?.querySelector(".session")?.getAttribute("aria-label") ?? "", /slack/);
      }
      assert.equal(document.querySelector('[data-view="inbox"]'), null);
      assert.equal(document.querySelector('[data-view="calendar"]'), null);
      sidebar.setWebOnly(true);
      await sidebar.refreshSessions();
      assert.deepEqual(rowIds(), ["web"]);
      sidebar.revealSessionSurface(sessions.find((s) => s.id === "cron-run"));
      assert.equal(sidebar.sessionsState.webOnly, true);
      sidebar.setWebOnly(false);
      await sidebar.refreshSessions();
      assert.deepEqual(rowIds(), ["web", "slack", "group"]);
      assert.ok(slackRow()?.querySelector(".slack-mark"));
      assert.equal(slackRow()?.querySelector(".ro-lock"), null);
      assert.doesNotMatch(slackRow()?.querySelector(".session")?.getAttribute("aria-label") ?? "", /read-only/);
      if (stored !== "unavailable") assert.equal(localStorage.getItem("web-ui:web-only"), "0");
    } finally {
      await env.close();
    }
  });
}

function sessions(count: number): CoreSession[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `chat-${i}`,
    threadRef: `web:tester:${i}`,
    scopeId: "personal:tester",
    type: "dm",
    title: `Chat ${i}`,
    createdAt: 1_000_000 - i,
  }));
}

function button(root: Element, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(found, `missing button: ${label}`);
  return found;
}

test("the sidebar pages chats from the server and keeps pinned, open and selected chats and archived expansion", async () => {
  const list = sessions(230);
  list[148]!.pinned = true;
  list[149]!.pinned = true;
  for (const item of list.slice(150)) item.archived = true;
  const opened = list[147]!;
  const h = await harness({
    path: `/s/${opened.id}`,
    session: opened,
    listSessions: list,
    contexts: [
      { scopeId: "personal:tester", kind: "personal", name: "Personal", sessionCount: 230, lastActivityAt: null },
    ],
  });
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    const sidebar = document.querySelector("#sidebar-body")!;
    assert.equal(sidebar.querySelectorAll(".session-row").length, 53);
    for (const id of [opened.id, "chat-148", "chat-149"]) assert.ok(sidebar.querySelector(`[data-session-id="${id}"]`));
    const projectToggle = sidebar.querySelector<HTMLButtonElement>(".recent-project-toggle")!;
    projectToggle.click();
    assert.equal(sidebar.querySelectorAll(".recent-project-children .session-row").length, 0);
    projectToggle.click();
    button(sidebar, "Show more conversations").click();
    const loading = button(sidebar, "Show more conversations");
    assert.ok(loading.disabled && loading.getAttribute("aria-busy") === "true");
    assert.ok(loading.querySelector(".thinking-sheen"));
    await until(
      () => sidebar.querySelectorAll(".session-row").length === 103,
      () => sidebar.querySelectorAll(".session-row").length,
    );
    for (const [id, shift] of [
      ["chat-90", false],
      ["chat-92", true],
    ] as const)
      sidebar.querySelector(`[data-session-id="${id}"] .session`)!.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: " ",
          ctrlKey: !shift,
          shiftKey: shift,
          bubbles: true,
          cancelable: true,
        }),
      );
    const selected = () =>
      [...sidebar.querySelectorAll<HTMLElement>(".session-row.selected")].map((row) => row.dataset.sessionId);
    assert.deepEqual(selected(), ["chat-90", "chat-91", "chat-92"]);
    h.sessionsState.list = [
      ...sessions(120).map((item) => ({
        ...item,
        id: `new-${item.id}`,
        threadRef: `new-${item.threadRef}`,
        createdAt: item.createdAt + 10_000,
      })),
      ...h.sessionsState.list,
    ];
    h.renderList();
    assert.deepEqual(
      selected(),
      ["chat-90", "chat-91", "chat-92"],
      "newer rows must not discard the current selection",
    );
    const archivedToggle = button(sidebar, "Archived");
    archivedToggle.click();
    await until(
      () => sidebar.querySelectorAll(".archived-children .session-row").length === 50,
      () => sidebar.querySelectorAll(".archived-children .session-row").length,
    );
    button(sidebar, "Show more archived conversations").click();
    await until(
      () => sidebar.querySelectorAll(".archived-children .session-row").length === 80,
      () => sidebar.querySelectorAll(".archived-children .session-row").length,
    );
    assert.equal(sidebar.querySelector(".archived-count"), null);
    button(sidebar, "Archived").click();
    assert.equal(sidebar.querySelectorAll(".archived-children .session-row").length, 0);
  } finally {
    await h.close();
  }
});

test("chat browsing pages rows from the server and searches the complete history", async () => {
  const list = sessions(125);
  list[124]!.title = "Older matching conversation";
  const h = await harness({ path: "/settings", listSessions: list });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    h.appState.currentView = "chats";
    void h.renderChatsPage();
    const main = document.querySelector("#main")!;
    await until(() => main.querySelectorAll(".chat-row").length === 50);
    button(main, "Show more conversations").click();
    await until(() => main.querySelectorAll(".chat-row").length === 100);
    const input = main.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = "Older matching";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await until(() => main.querySelectorAll(".chat-row").length === 1);
    assert.match(main.querySelector(".chat-row")?.textContent ?? "", /Older matching conversation/);
    input.value = "";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await until(() => main.querySelectorAll(".chat-row").length === 50);
  } finally {
    await h.close();
  }
});

async function until(check: () => boolean, describe: () => unknown = () => ""): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), `condition never held ${String(describe())}`);
}
