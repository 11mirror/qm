import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreSession } from "../src/core-bridge.ts";
import { harness, SESSION, type Harness } from "./support/deep-link-boot-fixture.ts";
import { twoPaneCanvas } from "./support/split-canvas-fixture.ts";
import { JSDOM, type DOMWindow } from "jsdom";
import { createServer } from "vite";
import { appShellHtml } from "../../../src/deploy/app-shell.ts";

test("a share link paints its conversation from the transcript, without waiting for the session list", async () => {
  const h = await harness({ path: "/s/sess-deep" });
  try {
    await h.boot();
    assert.equal(h.sessionsState.loaded, false, "the sidebar list must still be in flight");
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id, "the linked chat is already mounted");
    assert.deepEqual(
      h.sessionsState.list.map((s) => s.id),
      [SESSION.id],
      "the row the transcript carried seeds the list, so the header has its title",
    );
    assert.match(h.mainText(), /Deep linked chat/);
    assert.equal(
      h.requests.filter((p) => p.startsWith("/api/sessions?")).length,
      1,
      "boot must not stampede the expensive list route",
    );
    assert.equal(
      h.requests.filter((p) => p === `/api/sessions/${SESSION.id}?tailTurns=25`).length,
      1,
      "the pane reuses the prefetched transcript",
    );
    const transcript = h.requests.indexOf(`/api/sessions/${SESSION.id}?tailTurns=25`);
    assert.ok(transcript >= 0, "the transcript is fetched with the tail window");
    assert.ok(transcript < h.requests.indexOf("/me"), "and is in flight before /me is even asked");
    const approvals = h.requests.indexOf(`/api/sessions/${SESSION.id}/approvals`);
    assert.ok(approvals >= 0, "the pending approvals the mount needs are fetched too");
    assert.ok(approvals < h.requests.indexOf("/me"), "…in the same first round trip, not a serial one after it");
    assert.ok(
      h.requests.indexOf("/api/runtime-config") < h.requests.indexOf("/me"),
      "runtime-config rides the same round trip rather than queueing behind /me",
    );
  } finally {
    await h.close();
  }
});

test("a share link whose transcript 404s falls back to the session list", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 404 });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.sessionsState.loaded, true, "the fallback waits for the list");
    assert.equal(h.visibleConversation().state.sessionId, null, "no conversation is mounted");
    assert.match(h.mainText(), /Conversation not found/);
    assert.match(h.mainText(), /404/);
    assert.match(h.mainText(), /Back to chats/);
    assert.equal(location.pathname, "/s/sess-deep");
    assert.equal(document.querySelector("textarea"), null);
    assert.equal(document.activeElement?.id, "conversation-error-title");
  } finally {
    await h.close();
  }
});

test("a share link whose transcript fetch flakes still opens from the session list", async () => {
  const h = await harness({
    path: "/s/sess-deep",
    transcriptStatus: 503,
    transcriptFailures: 1,
    listSessions: [SESSION],
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("a session list that wins the race keeps its own decorated rows", async () => {
  const listed = { ...SESSION, working: true };
  const other = {
    id: "sess-other",
    threadRef: "web:tester:other",
    scopeId: "personal:tester",
    title: "Other",
    canContinue: true,
  };
  const h = await harness({ path: "/s/sess-deep", holdTranscript: true, listSessions: [other, listed] });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    h.releaseTranscript();
    await booted;
    assert.deepEqual(
      h.sessionsState.list.map((s) => s.id),
      [other.id, SESSION.id],
      "the list the server sent keeps its order — the transcript's copy must not jump the queue",
    );
    assert.equal(
      (h.sessionsState.list.find((s) => s.id === SESSION.id) as { working?: boolean }).working,
      true,
      "…nor strip the decorations only the list route computes",
    );
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("a list that omits the open conversation does not drop its row", async () => {
  const other = {
    id: "sess-other",
    threadRef: "web:tester:other",
    scopeId: "personal:tester",
    title: "Other",
    canContinue: true,
  };
  const h = await harness({ path: "/s/sess-deep", listSessions: [other] });
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
    assert.ok(
      h.sessionsState.list.some((s) => s.id === SESSION.id),
      "the conversation the user is reading must keep its sidebar row",
    );
  } finally {
    await h.close();
  }
});

test("a list landing mid-open still keeps the row of the conversation being opened", async () => {
  const other = {
    id: "sess-other",
    threadRef: "web:tester:other",
    scopeId: "personal:tester",
    title: "Other",
    canContinue: true,
  };
  const h = await harness({ path: "/", holdTranscript: true, listSessions: [other] });
  try {
    void h.boot();
    h.sessionsState.list = [SESSION, ...h.sessionsState.list];
    const opened = h.openSession(SESSION as CoreSession);
    while (!h.sessionsState.openingKey) await new Promise((resolve) => setTimeout(resolve, 0));
    h.releaseSessions();
    await h.sessionsReady();
    h.releaseTranscript();
    await opened;
    assert.ok(
      h.sessionsState.list.some((s) => s.id === SESSION.id),
      "the row must survive a refresh that lands between the open starting and the mount finishing",
    );
  } finally {
    await h.close();
  }
});

test("a bare entry still mints a new chat once the list lands", async () => {
  const h = await harness({ path: "/" });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.sessionsState.loaded, true);
    assert.equal(h.appState.currentView, "chats");
    assert.equal(h.visibleConversation().state.sessionId, null);
    assert.ok(h.visibleConversation().state.threadRef, "a fresh chat is mounted");
  } finally {
    await h.close();
  }
});

test("an explicit view opens without the sidebar list or remote canvas", async () => {
  const h = await harness({ path: "/crons", holdRemoteSplit: true });
  const booted = h.boot();
  try {
    for (let i = 0; i < 100 && h.appState.currentView !== "crons"; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.appState.currentView, "crons");
    assert.equal(h.sessionsState.loaded, false);
    assert.equal(h.requests.filter((p) => p.startsWith(`/api/sessions/${SESSION.id}`)).length, 0);
  } finally {
    h.releaseRemoteSplit();
    h.releaseSessions();
    await booted;
    await h.close();
  }
});

test("the sidebar request overlaps runtime settings and paints if it finishes first", async () => {
  const h = await harness({ path: "/settings", holdRuntimeConfig: true, listSessions: [SESSION] });
  const booted = h.boot();
  try {
    for (let i = 0; i < 100 && !h.requests.some((p) => p.startsWith("/api/sessions?")); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(
      h.requests.some((p) => p.startsWith("/api/sessions?")),
      "the list must start while runtime settings are pending",
    );
    h.releaseSessions();
    await h.sessionsReady();
    h.releaseRuntimeConfig();
    await booted;
    assert.equal(h.appState.currentView, "settings");
    assert.ok(document.querySelector(`[data-session-id="${SESSION.id}"]`));
  } finally {
    h.releaseRuntimeConfig();
    h.releaseSessions();
    await booted;
    await h.close();
  }
});

test("returning from Settings waits for the saved remote canvas before creating a pane", async () => {
  const h = await harness({
    path: "/settings",
    holdRemoteSplit: true,
    listSessions: [SESSION],
    remoteCanvas: twoPaneCanvas({ sessionId: SESSION.id, threadRef: SESSION.threadRef }, {}),
  });
  try {
    await h.boot();
    assert.equal(h.appState.currentView, "settings");
    h.releaseSessions();
    await h.sessionsReady();
    h.switchView("chats");
    assert.equal(document.querySelectorAll(".split-pane-content").length, 0);
    assert.equal(localStorage.getItem("web-ui:split-canvas:v1"), null);
    h.releaseRemoteSplit();
    for (let i = 0; i < 100 && document.querySelectorAll(".split-pane-content").length !== 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(document.querySelectorAll(".split-pane-content").length, 2);
    assert.equal(h.appState.currentView, "chats");
    await waitForText(h, /Deep linked chat/);
  } finally {
    await h.close();
  }
});

test("a delayed legacy canvas waits for its session lookup and respects later navigation", async () => {
  const h = await harness({
    path: "/settings",
    holdRemoteSplit: true,
    listSessions: [SESSION],
    remoteCanvas: twoPaneCanvas({ threadRef: SESSION.threadRef }, {}),
  });
  try {
    await h.boot();
    h.switchView("chats");
    assert.equal(document.querySelector(".settings-page"), null);
    h.switchView("settings");
    assert.ok(document.querySelector(".settings-page"));
    h.switchView("chats");
    assert.equal(document.querySelector(".settings-page"), null);
    assert.match(h.mainText(), /Loading conversations/);
    h.releaseRemoteSplit();
    for (let i = 0; i < 100 && !localStorage.getItem("web-ui:split-canvas:v1"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(localStorage.getItem("web-ui:split-canvas:v1"));
    assert.equal(document.querySelectorAll(".split-pane-content").length, 0);
    h.switchView("settings");
    h.releaseSessions();
    await h.sessionsReady();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.appState.currentView, "settings");
    assert.ok(document.querySelector(".settings-page"));
    assert.equal(document.querySelectorAll(".split-pane-content").length, 0);
    h.switchView("chats");
    assert.equal(document.querySelectorAll(".split-pane-content").length, 2);
    await waitForText(h, /Deep linked chat/);
  } finally {
    await h.close();
  }
});

test("a server failure shows a retry page rather than a missing conversation", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 503 });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.match(h.mainText(), /Couldn't load conversation/);
    assert.match(h.mainText(), /Try again/);
    assert.doesNotMatch(h.mainText(), /404/);
    assert.equal(location.pathname, "/s/sess-deep");
  } finally {
    await h.close();
  }
});

test("a missing share link keeps its error page instead of restoring the saved canvas", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 404, savedCanvas: true });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(h.mainText(), /Conversation not found/);
    assert.equal(location.pathname, "/s/sess-deep");
    assert.equal(document.querySelector(".dockview-theme-light"), null);
    assert.equal(document.querySelector("textarea"), null);
  } finally {
    await h.close();
  }
});

async function waitForText(h: Harness, text: RegExp): Promise<void> {
  for (let i = 0; i < 100 && !text.test(h.mainText()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(h.mainText(), text);
}

test("a failed connection refresh removes previously verified badges", async () => {
  const h = await harness({ path: "/settings" });
  try {
    h.setConnections([{ id: "ca_test", toolkit: "gmail" }]);
    await h.boot();
    await waitForText(h, /Gmail connected/);
    h.setConnections([], 503);
    window.dispatchEvent(new Event("focus"));
    await waitForText(h, /Could not check connected apps/);
    assert.doesNotMatch(h.mainText(), /Gmail connected/);
  } finally {
    await h.close();
  }
});

test("a message link loads older history and highlights the addressed row", async () => {
  const h = await harness({ path: "/s/sess-deep?seq=10", messageLink: true });
  try {
    await h.boot();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(h.requests.some((p) => p.includes("beforeSeq=80")));
    assert.ok(document.querySelector('[data-entry-seqs="10"]'));
    assert.equal(document.querySelector(".linked-message")?.getAttribute("data-entry-seqs"), "10");
    assert.equal(document.querySelector(".linked-message")?.getAttribute("data-scrolled"), "true");
  } finally {
    await h.close();
  }
});

test("opting into a new chat skips the saved multiview layout on a bare visit", async () => {
  const { harness } = await import("./support/deep-link-boot-fixture.ts");
  const h = await harness({ path: "/", savedCanvas: true, openNewChat: true });
  try {
    const saved = localStorage.getItem("web-ui:split-canvas:v1");
    h.releaseSessions();
    await h.boot();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(localStorage.getItem("web-ui:split-canvas:v1"), saved, "the saved layout survives for a later opt-in");
    assert.equal(document.querySelectorAll(".split-pane-content").length, 0);
    assert.doesNotMatch(h.visibleConversation().state.threadRef ?? "", /old-a|old-b/);
    assert.doesNotMatch(h.mainText(), /old-a|old-b/);
  } finally {
    await h.close();
  }
});

test("by default the saved multiview layout reopens", async () => {
  const { harness } = await import("./support/deep-link-boot-fixture.ts");
  const h = await harness({ path: "/", savedCanvas: true });
  try {
    h.releaseSessions();
    await h.boot();
    for (let i = 0; i < 200 && document.querySelectorAll(".split-pane-content").length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(document.querySelectorAll(".split-pane-content").length, 2);
  } finally {
    await h.close();
  }
});

for (const path of ["/new?q=summarize%20my%20inbox", "/?q=summarize%20my%20inbox"]) {
  test(`${path} opens a new chat with the prompt drafted but not sent`, async () => {
    const h = await harness({ path });
    try {
      const booted = h.boot();
      h.releaseSessions();
      await booted;
      assert.equal(h.visibleConversation().composer.state.draft, "summarize my inbox");
      assert.equal(h.visibleConversation().state.sessionId, null, "nothing was sent");
      assert.equal(location.pathname + location.search, "/", "the prompt leaves the address bar");
    } finally {
      await h.close();
    }
  });
}

const keys = ["--background", "--foreground", "--secondary", "--muted-foreground", "--border", "--brand-accent"];

test("the app bar accepts the chat palette only from its portal iframe, even while closed", () => {
  const dom = new JSDOM(appShellHtml({ slug: "demo", portalUrl: "https://portal.example.com", path: "/app" }), {
    url: "https://demo.apps.example.com",
    runScripts: "outside-only",
  });
  const win = dom.window;
  win.eval(
    "window.CSS = { supports: (_, value) => /^#[0-9a-f]{6}$/.test(value) }; window.fetch = async () => ({ ok: false });",
  );
  win.eval(win.document.querySelector("script")!.textContent!);
  const chat = win.document.querySelector<HTMLIFrameElement>("#chat")!;
  const root = win.document.documentElement;
  const colors = Object.fromEntries(keys.map((key) => [key, "#123456"]));
  const send = (origin: string, source: unknown, palette = colors, dark = true) =>
    win.dispatchEvent(
      new win.MessageEvent("message", {
        origin,
        source: source as Window,
        data: { type: "qm:theme", dark, colors: palette },
      }),
    );
  assert.match(chat.src, /app-edit\?slug=demo&embed=1&themeOnly=1$/);
  assert.equal(win.document.querySelector("#panel")!.classList.contains("open"), false);
  send("https://attacker.example.com", chat.contentWindow);
  send("https://portal.example.com", win.document.querySelector<HTMLIFrameElement>("#app")!.contentWindow);
  assert.equal(root.style.getPropertyValue("--background"), "");
  send("https://portal.example.com", chat.contentWindow);
  for (const key of keys) assert.equal(root.style.getPropertyValue(key), "#123456");
  assert.equal(root.style.colorScheme, "dark");
  send("https://portal.example.com", chat.contentWindow, { ...colors, "--border": "bad" });
  assert.equal(root.style.getPropertyValue("--border"), "#123456");
  send("https://portal.example.com", chat.contentWindow, colors, false);
  assert.equal(root.style.colorScheme, "light");
  win.document.querySelector<HTMLButtonElement>("#chat-toggle")!.click();
  assert.match(chat.src, /app-edit\?slug=demo&embed=1$/);
  win.document.querySelector<HTMLButtonElement>("#chat-toggle")!.click();
  assert.match(chat.src, /app-edit\?slug=demo&embed=1$/);
  dom.window.close();
});

test("embedded chat publishes active colors and tracks theme changes from other tabs", async (t) => {
  const dom = new JSDOM("<iframe></iframe>", { url: "https://portal.example.com", runScripts: "outside-only" });
  const frame = dom.window.document.querySelector("iframe")!.contentWindow as unknown as DOMWindow;
  const messages: Array<{ data: { dark: boolean; colors: Record<string, string> }; origin: string }> = [];
  dom.window.postMessage = (data, origin) => messages.push({ data, origin: origin as string });
  frame.document.body.innerHTML = '<div id="app"></div>';
  frame.matchMedia = () =>
    ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: frame,
    document: frame.document,
    location: frame.location,
    history: frame.history,
    localStorage: frame.localStorage,
    sessionStorage: frame.sessionStorage,
    navigator: frame.navigator,
    HTMLElement: frame.HTMLElement,
    Element: frame.Element,
    Node: frame.Node,
    customElements: frame.customElements,
    getComputedStyle: frame.getComputedStyle.bind(frame),
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  t.after(async () => {
    await vite.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  });
  await vite.ssrLoadModule("/src/shell.ts");
  const style = frame.document.createElement("style");
  style.textContent = `:root { ${keys.map((key) => `${key}: #abcdef;`).join(" ")} }`;
  frame.document.head.appendChild(style);
  frame.dispatchEvent(
    new frame.MessageEvent("message", {
      source: dom.window as unknown as Window,
      origin: "https://demo.apps.example.com",
      data: { type: "qm:theme-request" },
    }),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].origin, "https://demo.apps.example.com");
  assert.equal(messages[0].data.colors["--background"], "#abcdef");
  assert.equal(messages[0].data.dark, false);
  frame.localStorage.setItem("theme", "dark");
  frame.dispatchEvent(new frame.StorageEvent("storage", { key: "theme" }));
  assert.equal(messages.at(-1)!.data.dark, true);
  frame.localStorage.clear();
  frame.dispatchEvent(new frame.StorageEvent("storage", { key: null }));
  assert.equal(messages.at(-1)!.data.dark, false);
});

test("theme-only startup stops before authenticated chat boot", async () => {
  const themeOnly = await harness({ path: "/?slug=demo&embed=1&themeOnly=1" });
  try {
    await themeOnly.boot();
    assert.deepEqual(themeOnly.requests, []);
  } finally {
    await themeOnly.close();
  }
  const chat = await harness({ path: "/?slug=demo&embed=1" });
  try {
    chat.releaseSessions();
    await chat.boot();
    assert.ok(chat.requests.includes("/me"));
  } finally {
    await chat.close();
  }
});
