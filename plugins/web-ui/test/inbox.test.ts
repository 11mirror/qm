import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createInboxFixture, inboxRuntime, until } from "./inbox-composer-fixture.ts";

const entries = [
  {
    id: "mail",
    cronId: "c",
    source: "gmail",
    state: "held",
    thread: [],
    sourcePayload: { title: "Launch plan", from: "Ann" },
  },
  {
    id: "chat",
    cronId: "c",
    source: "slack",
    state: "held",
    thread: [],
    sourcePayload: { snippet: "Hiring", slack: { channel: "C1", ts: "1" } },
  },
];

async function inboxWith(t: TestContext, item: (url: URL) => Response) {
  const { vite, host, close } = await createInboxFixture({ dom: { url: "http://localhost/web-ui/" } });
  t.after(close);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(String(input), "http://localhost");
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/api/inbox") && url.searchParams.has("itemId")) return item(url);
    if (url.pathname.endsWith("/api/inbox"))
      return Response.json({
        filter: "human",
        selected: [{ id: "c", name: "Mixed", count: 2 }],
        available: [],
        total: 2,
        nextCursor: null,
        items: url.searchParams.get("view") ? [] : entries,
      });
    if (url.pathname.includes("/api/crons/")) return item(url);
    if (url.pathname.includes("runtime-config")) return Response.json(inboxRuntime);
    return Response.json({});
  });
  localStorage.setItem("web-ui:inbox-assistant-hidden", "1");
  await vite.ssrLoadModule("/src/shell.ts");
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  appState.me = { user: "taylor@example.com", org: "test", permissions: ["inbox"] };
  const inbox = {
    ...(await vite.ssrLoadModule("/src/inbox.ts")),
    ...(await vite.ssrLoadModule("/src/inbox-model.ts")),
  };
  t.after(inbox.resetInboxState);
  return { host, inbox, appState, requests };
}

const rowFor = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(".inbox-item-row")].find((row) => row.textContent?.includes(text))!;

test("a failed item load keeps the item listed and says why", async (t) => {
  const { host, inbox } = await inboxWith(t, () => Response.json({ message: "Upstream timeout" }, { status: 502 }));
  const pane = inbox.mountInboxPane({ host, viewId: "all", density: () => "full", onDensityChange() {} });
  t.after(() => pane.dispose());
  await until(() => inbox.inboxState.loaded && !inbox.inboxState.loading);
  rowFor(host, "Launch plan").click();
  await until(() => Boolean(host.querySelector(".inbox-notice")));
  assert.match(host.querySelector(".inbox-notice")!.textContent!, /Upstream timeout/);
  assert.ok(rowFor(host, "Launch plan"));
  assert.equal(rowFor(host, "Launch plan").getAttribute("aria-expanded"), "false");
});

test("a failed Slack source refresh shows on the item instead of reloading the inbox", async (t) => {
  const { host, inbox, requests } = await inboxWith(t, (url) =>
    url.searchParams.has("refreshSource")
      ? Response.json({ message: "Slack rate limited" }, { status: 503 })
      : Response.json({ item: entries[1] }),
  );
  const pane = inbox.mountInboxPane({ host, viewId: "all", density: () => "full", onDensityChange() {} });
  t.after(() => pane.dispose());
  await until(() => inbox.inboxState.loaded && !inbox.inboxState.loading);
  const feeds = requests.filter((path) => path.includes("/api/inbox")).length;
  rowFor(host, "Hiring").click();
  await until(() => /Couldn't refresh this item: Slack rate limited/.test(host.textContent ?? ""));
  assert.equal(requests.filter((path) => path.includes("/api/inbox")).length, feeds);
});

test("a deep link that fails to load reports the error instead of opening Sent", async (t) => {
  const { host, inbox, appState, requests } = await inboxWith(t, () =>
    Response.json({ message: "Database unavailable" }, { status: 500 }),
  );
  appState.mainEl = host;
  appState.currentView = "inbox";
  inbox.routeInboxHistory("missing-item");
  await inbox.renderInbox();
  await until(() => /Couldn't open this item: Database unavailable/.test(host.textContent ?? ""));
  assert.ok(!requests.some((path) => path.includes("/api/inbox/sent")));
});
