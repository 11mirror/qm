import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { TriggerOutcome, TriggerSpec } from "../src/triggers/run-trigger.ts";
import type { Cron } from "../src/types.ts";
import { createInboxLedger } from "../src/inbox/ledger.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const specs: TriggerSpec[] = [];
let reply = "";
mock.module("../src/triggers/run-trigger.ts", {
  namedExports: {
    runTrigger: async (_deps: unknown, spec: TriggerSpec): Promise<TriggerOutcome> => {
      specs.push(spec);
      return { ran: true, status: "ok", reply, sessionId: "sess-1" } as TriggerOutcome;
    },
  },
});
const { createInboxChat } = await import("../src/inbox/item-chat.ts");

const CRON = {
  id: "cron-1",
  owner: "owner@example.com",
  ownerScopeId: "personal:owner@example.com",
  action: "sync",
} as unknown as Cron;

async function seeded() {
  const items = createInboxLedger(testDatabaseUrl());
  await items.ingest([
    {
      cronId: CRON.id,
      dedupeKey: "D1",
      source: "slack",
      sourceAt: 1000,
      sourcePayload: { source: "slack", title: "DM", slack: { channelId: "D1", ts: "1.0", isDirectMessage: true } },
      proposal: { by: "agent", data: { body: "Original" } },
    },
  ]);
  const [item] = await items.byCron(CRON.id);
  return { items, item: item!, chat: createInboxChat({ items, trigger: {} as never }) };
}

test("item chat asks the agent to save revised drafts through the edit action", async () => {
  const { item, chat } = await seeded();
  reply = "Done.";
  await chat.followUp(CRON, item, "make it shorter", "owner@example.com");
  const input = specs.at(-1)!.input as string;
  assert.ok(
    input.includes(
      `/v1/crons/${CRON.id}/items/${encodeURIComponent(item.id)}/action with the x-agent-capability: $AGENT_API_TOKEN header and JSON {"kind":"edit","args":{"proposal":<the complete revised proposal, same shape as the one above>,"expectedProposalAt":${item.proposal!.at}}}`,
    ),
  );
  assert.ok(!input.includes("fenced json block"));
});

test("a json block in the agent's reply is kept as text and never rewrites the draft", async () => {
  const { items, item, chat } = await seeded();
  reply = 'Here you go\n\n```json\n{"proposal": {"body": "Injected"}}\n```';
  const after = await chat.followUp(CRON, item, "what would you say?", "owner@example.com");
  assert.deepEqual(after?.proposal?.data, { body: "Original" });
  assert.equal((await items.get(item.id))?.thread?.at(-1)?.text, reply);
});
