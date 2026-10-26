import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture, until } from "./inbox-composer-fixture.ts";

class FakeEventSource {
  static last: FakeEventSource | undefined;
  listeners = new Map<string, Array<(event: { data: string }) => void>>();
  onopen: (() => void) | null = null;
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, fn: (event: { data: string }) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  emit(name: string, data: unknown): void {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) });
  }
  close(): void {}
}

test("an inbox item event refetches that item and the counts, not every view", async (t) => {
  const { vite, host, close } = await createInboxFixture({ dom: { url: "http://localhost/web-ui/" } });
  t.after(close);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.assign(globalThis, { EventSource: FakeEventSource });
  t.after(() => Object.assign(globalThis, { EventSource: undefined }));
  let title = "Launch plan";
  let open = 2;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/api/inbox")) {
      requests.push(`feed:${url.searchParams.get("view") ?? "open"}:${url.searchParams.get("cronId") ?? "all"}`);
      const handled = url.searchParams.get("view") === "handled";
      return Response.json({
        filter: "human",
        selected: [{ id: "slack-cron", name: "Slack", source: "slack", count: open }],
        available: [],
        total: open,
        nextCursor: null,
        items: handled
          ? []
          : [
              {
                id: "a",
                cronId: "slack-cron",
                source: "slack",
                state: "held",
                sourcePayload: { snippet: "Launch plan" },
              },
              { id: "b", cronId: "slack-cron", source: "slack", state: "held", sourcePayload: { snippet: "Hiring" } },
            ],
      });
    }
    if (url.pathname.includes("/api/crons/")) {
      requests.push(`item:${url.pathname.split("/").at(-1)}`);
      return Response.json({
        item: { id: "a", cronId: "slack-cron", source: "slack", state: "held", sourcePayload: { snippet: title } },
      });
    }
    return Response.json({});
  });
  await vite.ssrLoadModule("/src/shell.ts");
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  appState.me = { user: "alice", org: "test", permissions: ["inbox"] };
  const { ensureDeliveryStream } = await vite.ssrLoadModule("/src/conversations.ts");
  const inbox = await vite.ssrLoadModule("/src/inbox.ts");
  t.after(inbox.resetInboxState);
  ensureDeliveryStream();
  const pane = inbox.mountInboxPane({ host, viewId: "all", density: () => "full", onDensityChange() {} });
  t.after(() => pane.dispose());
  await until(() => inbox.inboxState.loaded && !inbox.inboxState.loading);
  assert.deepEqual(requests, ["feed:open:all", "feed:handled:all"]);
  const titles = () => [...host.querySelectorAll(".inbox-item-snippet")].map((item) => item.textContent?.trim());
  assert.deepEqual(titles(), ["Launch plan", "Hiring"]);

  requests.length = 0;
  title = "Launch plan v2";
  open = 3;
  FakeEventSource.last!.emit("inbox_item", { cronId: "slack-cron", itemId: "a", op: "thread" });
  await until(() => requests.length === 2 && !inbox.inboxState.loading);
  assert.deepEqual(requests.sort(), ["feed:open:all", "item:a"]);
  assert.deepEqual(titles(), ["Launch plan v2", "Hiring"]);
  assert.equal(inbox.inboxState.total, 3);

  pane.dispose();
  host.remove();
  requests.length = 0;
  await inbox.refreshInbox({ silent: true });
  assert.deepEqual(requests, ["feed:open:all"]);
});
