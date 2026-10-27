import { test } from "node:test";
import assert from "node:assert/strict";
import { asUser, startWebUiRelay } from "../../../support/web-ui-relay.ts";

const { built, webBase } = await startWebUiRelay((built) => ({ memory: built.memory }));

type Facts = { facts: Array<{ id: string; text: string }> };

test("a signed-in user lists, edits and forgets their own facts; identity is the cookie", async () => {
  const empty = await fetch(`${webBase}/api/memory`, asUser("alice"));
  assert.equal(empty.status, 200);
  assert.deepEqual(((await empty.json()) as Facts).facts, []);

  await built.memory.capture("personal:alice", ["Calls me Al", "Lives in Oakland"], Date.UTC(2026, 0, 2));
  const [al, oakland] = ((await (await fetch(`${webBase}/api/memory`, asUser("alice"))).json()) as Facts).facts;

  const edit = await fetch(
    `${webBase}/api/memory`,
    asUser("alice", { method: "PATCH", body: JSON.stringify({ facts: [{ id: al!.id, text: "Calls me Ally" }] }) }),
  );
  assert.equal(edit.status, 200);
  const forget = await fetch(
    `${webBase}/api/memory`,
    asUser("alice", { method: "DELETE", body: JSON.stringify({ ids: [oakland!.id] }) }),
  );
  assert.deepEqual(
    ((await forget.json()) as Facts).facts.map((fact) => fact.text),
    ["Calls me Ally"],
  );

  const spoofed = await fetch(
    `${webBase}/api/memory`,
    asUser("bob", {
      method: "PATCH",
      body: JSON.stringify({ principalId: "alice", facts: [{ id: al!.id, text: "bob was here" }] }),
    }),
  );
  assert.equal(spoofed.status, 404, "bob's notebook has no such fact; a spoofed principalId is ignored");
  assert.equal(await built.memory.read("personal:alice"), "- (2026-01-02) Calls me Ally");
});

test("memory routes require a signed-in principal", async () => {
  assert.equal((await fetch(`${webBase}/api/memory`)).status, 401);
  assert.equal(
    (
      await fetch(`${webBase}/api/memory`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["1"] }),
      })
    ).status,
    401,
  );
});
