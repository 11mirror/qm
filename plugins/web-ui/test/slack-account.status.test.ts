import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./support/deep-link-boot-fixture.ts";

test("a failed Slack link check says so and does not start authorization", async () => {
  const h = await harness({ path: "/" });
  const previousFetch = globalThis.fetch;
  const posts: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/composio/slack") return Response.json({ error: "boom" }, { status: 500 });
    if (init?.method === "POST" && String(input).includes("slack")) posts.push(String(input));
    return previousFetch(input, init);
  };
  try {
    h.releaseSessions();
    await h.boot();
    const element = Object.assign(document.createElement("qm-slack-account"), { user: "tester" });
    document.body.append(element);
    for (let i = 0; i < 100 && !/Could not check/.test(element.textContent ?? ""); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(element.textContent ?? "", /Could not check whether your Slack account is linked/);
    element.querySelector<HTMLButtonElement>(".slack-connect")!.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(posts, []);
    assert.match(element.textContent ?? "", /Could not check whether your Slack account is linked/);
  } finally {
    globalThis.fetch = previousFetch;
    await h.close();
  }
});
