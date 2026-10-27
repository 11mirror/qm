import type { Item } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import { activitySeq } from "../src/items.ts";
import { buildTimeline } from "../src/timeline.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  continuableMessages,
  currentEarlierCount,
  itemsToMessages,
  forkOriginDetails,
  inheritedRefreshItems,
  inheritedTranscript,
  loadInheritedTranscript,
  type AssistantWork,
} from "../src/transcript-messages.ts";

test("approval decisions remain visible history events instead of unresolved tool rows", () => {
  const messages = itemsToMessages([
    item("UserMessage", { seq: 1, createdAt: 1, text: "show help" }),
    item("ToolResult", { seq: 2, createdAt: 2, tool: "execute", body: { blocked: "needs_approval" } }),
    item("AgentMessage", { seq: 3, createdAt: 3, text: "" }),
    item("ElicitationResponse", {
      seq: 4,
      createdAt: 4,
      elicitId: "req",
      approved: false,
      body: { command: "rm -r --help" },
    }),
    item("ElicitationResponse", {
      seq: 5,
      createdAt: 5,
      elicitId: "req",
      approved: true,
      body: { command: "rm -r --help", scope: "once" },
    }),
  ]);
  assert.deepEqual(messages.slice(-2), [
    {
      role: "approval-decision",
      command: "rm -r --help",
      approved: false,
      requestId: "req",
      timestamp: 4,
      entrySeq: 4,
    },
    {
      role: "approval-decision",
      command: "rm -r --help",
      approved: true,
      requestId: "req",
      scope: "once",
      timestamp: 5,
      entrySeq: 5,
    },
  ]);
});

test("steering keeps the active turn together through hydration and tool completion", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 1, seq: 1, text: "start" }),
    item("AgentMessage", {
      createdAt: 2,
      seq: 2,
      variant: "narration",
      text: "Working",
      body: { phase: "commentary" },
    }),
    item("ToolCall", { createdAt: 3, seq: 3, tool: "execute", callId: "one", body: { command: "sleep 40" } }),
    item("SteeringMessage", { createdAt: 4, seq: 4, text: "change direction" }),
    item("SteeringMessage", { createdAt: 5, seq: 5, text: "finish briefly" }),
  ];
  const active = itemsToMessages(items);
  assert.deepEqual(
    active.map((message) => message.role),
    ["user", "user", "user", "assistant"],
  );
  const resumed = continuableMessages(active);
  assert.deepEqual(
    resumed.messages.map((message) => message.role),
    ["user", "user", "user"],
  );
  assert.equal(resumed.popped.length, 1);
  assert.deepEqual((resumed.popped[0] as AssistantWork).work?.activity.map(activitySeq), [2, 3, 4, 5]);
  const finished = itemsToMessages([
    ...items,
    item("ToolResult", { createdAt: 6, seq: 6, tool: "execute", callId: "one", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 7, seq: 7, text: "Done" }),
  ]);
  assert.deepEqual(
    finished.map((message) => message.role),
    ["user", "user", "user", "assistant"],
  );
  const work = (finished.at(-1) as AssistantWork).work!;
  assert.deepEqual(work.activity.map(activitySeq), [2, 3, 4, 5, 6]);
  assert.deepEqual(
    buildTimeline(work).map((item) => item.kind),
    ["text", "tool", "steer", "steer"],
  );
  const tools = buildTimeline(work).filter((item) => item.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.row.call?.seq, 3);
  assert.equal(tools[0]!.row.result?.seq, 6);
});

test("steering preserves an in-flight post and does not promote its closing narration", () => {
  const messages = itemsToMessages([
    item("UserMessage", { createdAt: 1, seq: 1, text: "start" }),
    item("ToolCall", { createdAt: 2, seq: 2, tool: "web", callId: "one", body: { action: "post", text: "Delivered" } }),
    item("SteeringMessage", { createdAt: 3, seq: 3, text: "finish briefly" }),
    item("ToolResult", { createdAt: 4, seq: 4, tool: "web", callId: "one", body: { action: "post", ok: true } }),
    item("SteeringMessage", { createdAt: 5, seq: 5, text: "no more posts" }),
    item("AgentMessage", { createdAt: 6, seq: 6, variant: "narration", text: "Finished posting" }),
    item("AgentMessage", { createdAt: 7, seq: 7, text: "" }),
  ]);
  const replies = messages.filter((message) => message.role === "assistant") as AssistantWork[];
  assert.equal(replies.length, 2);
  assert.deepEqual(
    replies.map((message) => message.content),
    [[{ type: "text", text: "Delivered" }], [{ type: "text", text: "" }]],
  );
  assert.deepEqual(replies[1]!.work?.activity.map(activitySeq), [5, 6]);
});

test("fork provenance separates inherited items at the boundary", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 1, seq: 1, text: "old" }),
    item("AgentMessage", { createdAt: 2, seq: 2, text: "copied" }),
    item("UserMessage", { createdAt: 3, seq: 3, text: "new" }),
  ];
  const collapsed = inheritedTranscript(
    { forkedFrom: { sessionId: "source", title: "Original" }, forkBoundarySeq: 2 },
    items,
  );
  assert.deepEqual(
    collapsed.inherited.map((entry) => entry.seq),
    [1, 2],
  );
  assert.deepEqual(
    collapsed.current.map((entry) => entry.seq),
    [3],
  );
  assert.deepEqual(inheritedTranscript({}, items), { inherited: [], current: items });
});

test("inherited transcript requires complete provenance", () => {
  const sequenced = item("UserMessage", { createdAt: 1, seq: 2, text: "old" });
  assert.deepEqual(inheritedTranscript({ forkedFrom: { sessionId: "source" } }, [sequenced]), {
    inherited: [],
    current: [sequenced],
  });
  assert.deepEqual(inheritedTranscript({ forkBoundarySeq: 2 }, [sequenced]), {
    inherited: [],
    current: [sequenced],
  });
});

test("inherited expansion pages backward to the start and preserves transcript order", async () => {
  const session = { id: "fork", forkedFrom: { sessionId: "source" }, forkBoundarySeq: 50 };
  const first = item("UserMessage", { createdAt: 1, seq: 1, text: "first" }) as Item;
  const middle = item("AgentMessage", { createdAt: 2, seq: 25, text: "middle" }) as Item;
  const last = item("UserMessage", { createdAt: 3, seq: 50, text: "last" }) as Item;
  const calls: unknown[] = [];
  const fetcher = async (id: string, window?: { tailTurns?: number; beforeSeq?: number }) => {
    calls.push({ id, window });
    return window?.beforeSeq === 51 ? { items: [middle, last], earlierItems: 1 } : { items: [first], earlierItems: 0 };
  };
  assert.deepEqual(await loadInheritedTranscript(session, [], fetcher), [first, middle, last]);
  assert.deepEqual(calls, [
    { id: "fork", window: { beforeSeq: 51, tailTurns: 25 } },
    { id: "fork", window: { beforeSeq: 25, tailTurns: 25 } },
  ]);
  calls.length = 0;
  assert.deepEqual(await loadInheritedTranscript(session, [last], fetcher), [last]);
  assert.deepEqual(calls, []);
});

test("inherited expansion reaches entry seq 0 (0-based sequences)", async () => {
  const session = { id: "fork", forkedFrom: { sessionId: "source" }, forkBoundarySeq: 2 };
  const pages: Record<number, { items: Item[]; earlierItems: number }> = {
    3: {
      items: [item("AgentMessage", { createdAt: 3, seq: 2, text: "two" }) as Item],
      earlierItems: 2,
    },
    2: {
      items: [item("UserMessage", { createdAt: 2, seq: 1, text: "one" }) as Item],
      earlierItems: 1,
    },
    1: {
      items: [item("UserMessage", { createdAt: 1, seq: 0, text: "zero" }) as Item],
      earlierItems: 0,
    },
  };
  const calls: number[] = [];
  const fetcher = async (_id: string, window?: { beforeSeq?: number }) => {
    calls.push(window?.beforeSeq ?? -1);
    return pages[window?.beforeSeq ?? -1]!;
  };
  const inherited = await loadInheritedTranscript(session, [], fetcher as never);
  assert.deepEqual(calls, [3, 2, 1]);
  assert.deepEqual(
    inherited.map((entry) => entry.seq),
    [0, 1, 2],
  );
});

test("currentEarlierCount hides inherited items from the earlier-messages count", () => {
  const fork = { forkedFrom: { sessionId: "source" }, forkBoundarySeq: 4 };
  assert.equal(currentEarlierCount(fork, 12), 7);
  assert.equal(currentEarlierCount(fork, 5), 0);
  assert.equal(currentEarlierCount(fork, 3), 0);
  assert.equal(currentEarlierCount({}, 12), 12);
  assert.equal(currentEarlierCount({ forkedFrom: { sessionId: "source" } }, 12), 12);
});

test("a stale show load never lands on the next fork; reset revives the control", async () => {
  const dom = new JSDOM("<!doctype html><main></main>");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.window.Event });
  const { createForkOriginController } = await import("../src/fork-origin.ts");
  const state = { inheritedMessages: [] as Item[], inheritedLoaded: false, inheritedExpanded: false };
  const pending: Array<(items: Item[]) => void> = [];
  const controller = createForkOriginController<Item>({
    state,
    load: () => new Promise((resolve) => pending.push(resolve)),
    navigate: async () => {},
    current: () => true,
    redraw: () => {},
    setError: () => {},
  });
  const firstToggle = controller.toggle();
  assert.equal(pending.length, 1);
  controller.reset(); // switched to another fork mid-load
  const secondToggle = controller.toggle(); // new fork's control is live immediately
  assert.equal(pending.length, 2, "reset frees the in-flight guard");
  pending[0]!([item("UserMessage", { createdAt: 1, seq: 0, text: "fork A history" }) as Item]);
  await firstToggle;
  assert.equal(state.inheritedLoaded, false, "stale load is discarded");
  assert.equal(state.inheritedMessages.length, 0, "stale load is discarded");
  pending[1]!([item("UserMessage", { createdAt: 2, seq: 0, text: "fork B history" }) as Item]);
  await secondToggle;
  assert.equal(state.inheritedLoaded, true);
  assert.equal(state.inheritedExpanded, true);
  assert.equal(state.inheritedMessages[0]!.text, "fork B history");
});

test("a failed show load surfaces an error instead of dying silently", async () => {
  const { createForkOriginController } = await import("../src/fork-origin.ts");
  const state = { inheritedMessages: [] as Item[], inheritedLoaded: false, inheritedExpanded: false };
  let error = "";
  let redraws = 0;
  const controller = createForkOriginController<Item>({
    state,
    load: () => Promise.reject(new Error("boom")),
    navigate: async () => {},
    current: () => true,
    redraw: () => {
      redraws++;
    },
    setError: (value) => {
      error = value;
    },
  });
  await controller.toggle();
  assert.equal(error, "Couldn't load the original conversation's history.");
  assert.ok(redraws >= 1);
  assert.equal(state.inheritedExpanded, false, "a failed load never expands");
  assert.equal(state.inheritedLoaded, false);
  // the control recovers: a later successful load works
  const ok = createForkOriginController<Item>({
    state,
    load: async () => [item("UserMessage", { createdAt: 1, seq: 0, text: "old" }) as Item],
    navigate: async () => {},
    current: () => true,
    redraw: () => {},
    setError: () => {},
  });
  await ok.toggle();
  assert.equal(state.inheritedLoaded, true);
  assert.equal(state.inheritedExpanded, true);
});

test("a successful show clears a prior error; an in-flight load survives non-reset redraws", async () => {
  const { createForkOriginController } = await import("../src/fork-origin.ts");
  const state = { inheritedMessages: [] as Item[], inheritedLoaded: false, inheritedExpanded: false };
  let error = "sticky old failure";
  let resolveLoad: ((items: Item[]) => void) | null = null;
  const controller = createForkOriginController<Item>({
    state,
    load: () => new Promise((resolve) => (resolveLoad = resolve)),
    navigate: async () => {},
    current: () => true,
    redraw: () => {},
    setError: (value) => {
      error = value;
    },
  });
  const toggling = controller.toggle();
  assert.equal(error, "", "starting a new attempt clears the stale error");
  // a same-session remount does NOT reset the controller, so the load lands
  resolveLoad!([item("UserMessage", { createdAt: 1, seq: 0, text: "old" }) as Item]);
  await toggling;
  assert.equal(state.inheritedLoaded, true);
  assert.equal(state.inheritedExpanded, true);
  assert.equal(error, "", "no error after a successful show");
});

test("fork origin remains visible when a deep-link tail contains only post-fork items", () => {
  const session = { forkedFrom: { sessionId: "source", title: "Original" }, forkBoundarySeq: 10 };
  const postForkTail = Array.from({ length: 25 }, (_, index) =>
    item("UserMessage", { text: String(index), createdAt: index, seq: 11 + index }),
  );
  assert.equal(inheritedTranscript(session, postForkTail).inherited.length, 0);
  assert.deepEqual(forkOriginDetails(session, 0), { sessionId: "source", title: "Original" });
  assert.deepEqual(forkOriginDetails(session, 3), {
    sessionId: "source",
    title: "Original",
    messageCount: 3,
  });
});

test("fork origin DOM navigates, reports access failure once, pages, toggles, survives refresh, and resets", async () => {
  const dom = new JSDOM('<!doctype html><main id="chat"></main>');
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.window.Event });
  const [{ render }, { createForkOriginController, forkOriginView }] = await Promise.all([
    import("lit"),
    import("../src/fork-origin.ts"),
  ]);
  const host = dom.window.document.querySelector<HTMLElement>("#chat")!;
  const session = {
    id: "fork",
    forkedFrom: { sessionId: "source", title: "Original" },
    forkBoundarySeq: 2,
  };
  const state = { inheritedMessages: [] as Item[], inheritedLoaded: false, inheritedExpanded: false };
  let error = "";
  let navigationFails = false;
  let navigations = 0;
  const calls: number[] = [];
  const fetcher = async (_id: string, window?: { beforeSeq?: number }) => {
    calls.push(window?.beforeSeq ?? 0);
    return window?.beforeSeq === 3
      ? {
          items: [item("AgentMessage", { text: "old two", createdAt: 2, seq: 2 })],
          earlierItems: 1,
        }
      : {
          items: [item("UserMessage", { text: "old one", createdAt: 1, seq: 1 })],
          earlierItems: 0,
        };
  };
  const controller = createForkOriginController({
    state,
    load: () => loadInheritedTranscript(session, [], fetcher as never),
    navigate: async () => {
      navigations++;
      if (navigationFails) throw new Error("denied");
    },
    current: () => true,
    redraw: () => draw(),
    setError: (value) => {
      error = value;
    },
  });
  const draw = () => {
    for (const node of host.querySelectorAll("article")) node.remove();
    const origin = forkOriginDetails(session, state.inheritedLoaded ? state.inheritedMessages.length : 0);
    render(
      origin
        ? forkOriginView({
            ...origin,
            expanded: state.inheritedExpanded,
            navigate: () => void controller.navigate(),
            toggle: () => void controller.toggle(),
          })
        : null,
      host,
    );
    const existing = host.querySelector(".composer-error");
    existing?.remove();
    if (error) {
      const node = dom.window.document.createElement("div");
      node.className = "composer-error";
      node.textContent = error;
      host.append(node);
    }
    if (state.inheritedExpanded)
      for (const entry of state.inheritedMessages) {
        const node = dom.window.document.createElement("article");
        node.textContent = entry.text;
        host.append(node);
      }
  };
  draw();
  assert.match(host.textContent ?? "", /Forked from Original/);
  assert.doesNotMatch(host.textContent ?? "", /messages/);
  host.querySelector<HTMLButtonElement>(".fork-origin-badge")!.click();
  assert.equal(navigations, 1);
  navigationFails = true;
  host.querySelector<HTMLButtonElement>(".fork-origin-badge")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(host.textContent?.match(/You no longer have access to the original conversation\./g)?.length, 1);
  controller.reset();
  draw();
  assert.doesNotMatch(host.textContent ?? "", /no longer have access/);
  host.querySelector<HTMLButtonElement>(".fork-origin-toggle")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [3, 2]);
  assert.match(host.textContent ?? "", /old one/);
  assert.match(host.textContent ?? "", /old two/);
  assert.match(host.textContent ?? "", /2 messages/);
  host.querySelector<HTMLButtonElement>(".fork-origin-toggle")!.click();
  assert.doesNotMatch(host.textContent ?? "", /old one/);
  const refresh = inheritedRefreshItems(
    session,
    [item("AgentMessage", { createdAt: 3, seq: 3, text: "new reply" })],
    state.inheritedLoaded,
  );
  assert.equal(refresh, null);
  host.querySelector<HTMLButtonElement>(".fork-origin-toggle")!.click();
  assert.match(host.textContent ?? "", /old one/);
  assert.equal(host.textContent?.match(/old one/g)?.length, 1);
  const noOrigin = forkOriginDetails({}, 0);
  render(noOrigin ? forkOriginView({ ...noOrigin, expanded: false, navigate() {}, toggle() {} }) : null, host);
  assert.equal(host.querySelector(".fork-origin-badge"), null);
  dom.window.close();
});
