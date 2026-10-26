import assert from "node:assert/strict";
import test from "node:test";
import type { CoreSession } from "../src/core-bridge.ts";
import { harness } from "./deep-link-boot-fixture.ts";

async function until(check: () => boolean, describe: () => unknown = () => ""): Promise<void> {
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
    await until(
      () => document.querySelector(".split-toast")?.textContent === "Couldn't save that change.",
      () => document.querySelector(".split-toast")?.textContent,
    );
    await until(() => Boolean(sidebar.querySelector(`[data-session-id="${other.id}"]`)));
  } finally {
    await h.close();
  }
});
