import assert from "node:assert/strict";
import { test } from "node:test";
import { INBOX_SYNC_TASK_VERSION, renderSourceInboxTask } from "../../../src/inbox/sync-task.ts";
import { createInboxSourceRefresh } from "../../../src/inbox/source-refresh.ts";
import { sleep } from "../../../src/util/async.ts";
import { world, call, PORTAL, ITEM, inboxCron, plainCron, seed } from "../../support/cron-items-app.ts";

test("sync-cron is created once, refreshes stale task text, and disables on request", async () => {
  const w = world();
  const created = await call(w, { method: "POST", path: "/v1/inbox/sync-cron", body: {} });
  assert.equal(created.status, 200);
  const syncCron = (created.body as { syncCron: { id: string } }).syncCron;
  const stored = (await w.crons.get(syncCron.id))!;
  assert.equal(stored.ownerScopeId, "personal:josh");
  assert.equal(stored.owner, "josh");
  assert.equal((stored.destination as { target: string }).target, "josh");
  assert.deepEqual(stored.inbox, { source: "gmail" });
  const current = renderSourceInboxTask("gmail");
  assert.equal(stored.action, current);
  await w.crons.update(syncCron.id, {
    action: current.replace(
      `Inbox sync v${INBOX_SYNC_TASK_VERSION}.`,
      `Inbox sync v${INBOX_SYNC_TASK_VERSION}. Older wording.`,
    ),
  });
  await w.crons.setEnabled(syncCron.id, false);
  const refreshed = await call(w, { method: "POST", path: "/v1/inbox/sync-cron", body: {} });
  const after = (refreshed.body as { syncCron: { id: string; enabled: boolean } }).syncCron;
  assert.equal(after.id, syncCron.id);
  assert.equal((await w.crons.get(syncCron.id))!.action, current);
  assert.equal(after.enabled, true);
  assert.equal((await w.crons.list()).length, 2);
  const disabled = await call(w, { method: "POST", path: "/v1/inbox/sync-cron", body: { enabled: false } });
  assert.equal((disabled.body as { syncCron: { enabled: boolean } }).syncCron.enabled, false);
});

test("an inbox's scan watermark is stored on its cron and only moves forward", async () => {
  const w = world();
  const cron = await inboxCron(w);
  const path = `/v1/crons/${cron.id}/items`;
  const scannedThrough = async () =>
    ((await call(w, { method: "GET", path })).body as { scannedThrough?: number }).scannedThrough;
  assert.equal(await scannedThrough(), undefined);
  assert.equal((await call(w, { method: "POST", path, body: { scannedThrough: 5_000 } })).status, 200);
  assert.equal(await scannedThrough(), 5_000);
  await call(w, { method: "POST", path, body: { scannedThrough: 3_000 } });
  assert.equal(await scannedThrough(), 5_000);
  await call(w, { method: "POST", path, body: { items: [ITEM], scannedThrough: 9_000 } });
  assert.equal(await scannedThrough(), 9_000);
  assert.equal((await call(w, { method: "POST", path, body: { scannedThrough: "soon" } })).status, 400);
  assert.equal((await call(w, { method: "POST", path, body: {} })).status, 400);
});

test("a send carrying the draft it saw is refused when the agent redrafted in between", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const seenAt = (await w.items.get(item.id))!.proposal!.at;
  await sleep(2);
  await w.items.setProposal(item.id, { data: { body: "newer agent draft" }, by: "agent" });
  const stale = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: { body: "what I saw" }, expectedProposalAt: seenAt } },
  });
  assert.equal(stale.status, 409);
  assert.equal((stale.body as { error: string }).error, "draft_changed");
  assert.equal(w.sent.length, 0, "nothing reached Slack");
  const fresh = (await w.items.get(item.id))!.proposal!;
  assert.equal(fresh.by, "agent", "the stale edit did not overwrite the newer draft");
  const ok = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: { body: "newer agent draft" }, expectedProposalAt: fresh.at } },
  });
  assert.equal(ok.status, 200);
});

test("sending the agent's draft unchanged keeps it attributed to the agent", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const held = (await w.items.get(item.id))!;
  const sent = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: held.proposal!.data, expectedProposalAt: held.proposal!.at } },
  });
  assert.equal(sent.status, 200);
  assert.equal((await w.items.get(item.id))!.proposal!.by, "agent");
});

test("an edit carrying the draft it was based on is refused when the agent redrafted in between", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const basedOn = (await w.items.get(item.id))!.proposal!.at;
  await sleep(2);
  await w.items.setProposal(item.id, { data: { body: "newer agent draft" }, by: "agent" });
  const stale = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "edit", args: { proposal: { body: "typed over the old one" }, expectedProposalAt: basedOn } },
  });
  assert.equal(stale.status, 409);
  assert.equal((stale.body as { error: string }).error, "draft_changed");
  assert.deepEqual((await w.items.get(item.id))!.proposal!.data, { body: "newer agent draft" });
});

test("a person's own typed mention stays live, while a capability caller's is disarmed", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const human = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action?principalId=josh`,
    body: { kind: "send", args: { proposal: { body: "Heads up <!channel>" } } },
    capability: PORTAL,
  });
  assert.equal(human.status, 200, JSON.stringify(human.body));
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Heads up <!channel>");
  const second = await seed(w, {
    ...ITEM,
    sourceKey: "t2",
    slack: { channelId: "C1", ts: "9.9", isDirectMessage: false },
  });
  const agent = await call(w, {
    method: "POST",
    path: `/v1/crons/${second.cron.id}/items/${second.item.id}/action`,
    body: { kind: "send", args: { body: "Heads up <!channel>" } },
  });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Heads up @\u200bchannel");
});

test("a capability caller's edit is stored as the agent's draft, so its mentions stay in the disarm set", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const edited = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "edit", args: { proposal: { body: "Everyone <!here> please look" } } },
  });
  assert.equal(edited.status, 200);
  const stored = (await w.items.get(item.id))!;
  assert.equal(stored.proposal!.by, "agent");
  assert.deepEqual(stored.agentMentionKeys, ["!here"]);
  const sent = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action?principalId=josh`,
    body: { kind: "send" },
    capability: PORTAL,
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Everyone @\u200bhere please look");
});

test("concurrent source sends share a durable decision claim", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const send = () =>
    call(w, { method: "POST", path: `/v1/crons/${cron.id}/items/${item.id}/action`, body: { kind: "send" } });
  const outcomes = await Promise.all([send(), send()]);
  assert.deepEqual(outcomes.map((out) => out.status).sort(), [200, 409]);
  assert.equal(w.sent.length, 1);
  assert.equal((await w.items.get(item.id))!.decisionToken, undefined);
});

test("a conversational send refuses a stale draft before starting an agent turn", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/followup`,
    body: { message: "Send it", expectedProposalAt: item.proposal!.at - 1 },
  });
  assert.equal(out.status, 409);
  assert.equal((out.body as { error: string }).error, "draft_changed");
  assert.deepEqual(w.followUps, []);
  assert.deepEqual(w.sent, []);
  const accepted = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/followup`,
    body: { message: "Send it", expectedProposalAt: item.proposal!.at },
  });
  assert.equal(accepted.status, 200);
  assert.equal(w.followUps.length, 1);
});

test("inbox list refreshes open Gmail items before returning, but not another owner's inbox", async () => {
  const w = world();
  const cron = await inboxCron(w, "gmail");
  const refreshes: string[] = [];
  const queued: unknown[] = [];
  w.sourceRefresh = createInboxSourceRefresh({
    featureFlags: { enabled: async () => true },
    items: w.items,
    record: async (_item, event) => {
      queued.push(event);
    },
    tokens: { connectorAccessToken: async () => "synthetic" },
    directory: { getBySlackId: async () => null },
    fetchImpl: async (url) => {
      refreshes.push(String(url));
      return Response.json({ messages: [{ internalDate: "2000", labelIds: ["SENT"], snippet: "Already replied" }] });
    },
  });
  await w.items.ingest([
    {
      cronId: cron.id,
      dedupeKey: "gmail",
      source: "gmail",
      sourceAt: 1000,
      sourcePayload: { gmail: { threadId: "thread" } },
      proposal: { by: "agent", data: { body: "Draft" } },
    },
  ]);
  const denied = await call(w, {
    method: "GET",
    path: `/v1/crons/${cron.id}/items?principalId=outsider`,
    capability: null,
  });
  assert.equal(denied.status, 404);
  assert.equal(refreshes.length, 0);
  const result = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items` });
  assert.equal(result.status, 200);
  assert.deepEqual(queued, [{ author: "owner", at: 2000, text: "Already replied" }]);
  assert.equal(refreshes.length, 1);
});

test("Slack thread keys reuse a legacy item's identity and edits", async () => {
  const w = world();
  const cron = await inboxCron(w);
  await w.items.ingest([
    {
      cronId: cron.id,
      dedupeKey: "D1",
      source: "slack",
      sourceAt: 2000,
      sourcePayload: { slack: { channelId: "D1", ts: "1.0", threadTs: "1.0" } },
      proposal: { by: "human", data: { body: "Keep this edit" } },
    },
  ]);
  const [original] = await w.items.byCron(cron.id);
  const ingest = () =>
    call(w, {
      method: "POST",
      path: `/v1/crons/${cron.id}/items`,
      body: {
        items: [
          {
            ...ITEM,
            sourceKey: "D1:1.0",
            receivedAt: 2000,
            slack: { channelId: "D1", ts: "2.0", threadTs: "1.0", isDirectMessage: true },
            draft: { body: "Agent replacement" },
          },
        ],
      },
    });
  assert.equal((await ingest()).status, 200);
  assert.equal((await w.items.byCron(cron.id)).length, 1);
  assert.equal((await w.items.get(original!.id))!.proposal!.data.body, "Keep this edit");
});

test("ordinary item reads only hydrate Slack with the refresh flag", async () => {
  const w = world();
  const cron = await inboxCron(w);
  await w.items.ingest([{ cronId: cron.id, dedupeKey: "slack", source: "slack", sourcePayload: {} }]);
  const [item] = await w.items.byCron(cron.id);
  let refreshes = 0;
  w.sourceRefresh = async () => {
    refreshes++;
  };
  await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items/${item!.id}` });
  assert.equal(refreshes, 0);
  await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items/${item!.id}?refreshSource=1` });
  assert.equal(refreshes, 1);
});

test("a new Slack thread cannot overwrite an unrelated unthreaded DM card", async () => {
  const w = world();
  const cron = await inboxCron(w);
  await w.items.ingest([
    {
      cronId: cron.id,
      dedupeKey: "D1",
      source: "slack",
      sourceAt: 2000,
      sourcePayload: { slack: { channelId: "D1", ts: "2.0", isDirectMessage: true } },
      proposal: { by: "human", data: { body: "Keep this edit" } },
    },
  ]);
  const [original] = await w.items.byCron(cron.id);
  const result = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: {
      items: [
        {
          ...ITEM,
          sourceKey: "D1:1.0",
          receivedAt: 3000,
          slack: { channelId: "D1", ts: "3.0", threadTs: "1.0", isDirectMessage: true },
          draft: { body: "Other ask" },
        },
      ],
    },
  });
  assert.equal(result.status, 200);
  assert.equal((await w.items.byCron(cron.id)).length, 2);
  assert.equal((await w.items.get(original!.id))!.proposal!.data.body, "Keep this edit");
});

test("followup accepts only typed runtime and staged attachment fields", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const path = `/v1/crons/${cron.id}/items/${item.id}/followup`;
  let received: unknown;
  w.chat!.followUp = async (_cron, held, _message, _actor, options) => {
    received = options;
    return held;
  };
  const options = {
    model: "gpt-5.6-terra",
    thinkingLevel: "high",
    fastMode: true,
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 20, blobId: "opaque-upload" }],
  };
  const out = await call(w, {
    method: "POST",
    path,
    body: {
      message: "",
      ...options,
      model: ` ${options.model} `,
      thinkingLevel: " high ",
      attachments: [{ ...options.attachments[0], path: "/ignored" }],
      scopeId: "personal:other",
    },
  });
  assert.equal(out.status, 200);
  assert.deepEqual(received, options);
  for (const invalid of [
    { model: 5 },
    { model: " " },
    { thinkingLevel: " " },
    { fastMode: null },
    { attachments: null },
    { attachments: [null] },
    { attachments: [{ ...options.attachments[0], name: "" }] },
    { attachments: [{ ...options.attachments[0], blobId: "" }] },
    { attachments: [{ ...options.attachments[0], sizeBytes: 1.5 }] },
    { attachments: [{ ...options.attachments[0], sizeBytes: 1_000_000_001 }] },
    { thinkingLevel: "unsupported" },
    { fastMode: "true" },
    { attachments: [{ path: "/etc/passwd" }] },
    { attachments: [{ ...options.attachments[0], sizeBytes: -1 }] },
    { attachments: Array(11).fill(options.attachments[0]) },
  ]) {
    received = undefined;
    const bad = await call(w, { method: "POST", path, body: { message: "hello", ...invalid } });
    assert.equal(bad.status, 400, JSON.stringify(invalid));
    assert.equal(received, undefined);
  }
});

test("email classification is scoped to the owner's flagged personal inbox", async () => {
  for (const inboxSource of [undefined, "gmail", "slack"]) {
    for (const enabled of [false, true]) {
      for (const source of ["gmail", "slack"]) {
        if (inboxSource && inboxSource !== source) continue;
        const w = world();
        const cron = await plainCron(w, inboxSource ? { source: inboxSource } : {});
        const classified = enabled && source === "gmail" && inboxSource === "gmail";
        const flagEnabled = async (flag: string, scope: string) => {
          assert.equal(flag, "inbox_loops");
          assert.equal(scope, "personal:josh");
          return enabled;
        };
        for (const automated of [true, false]) {
          const receivedAt = automated ? 1234 : 2345;
          const item =
            source === "slack"
              ? ITEM
              : {
                  ...ITEM,
                  source: "gmail",
                  sourceKey: "thread-1",
                  gmail: { threadId: "thread-1" },
                };
          const response = await call(w, {
            method: "POST",
            path: `/v1/crons/${cron.id}/items`,
            flagEnabled,
            body: { items: [{ ...item, receivedAt, automated, probablyResolved: false }] },
          });
          assert.equal(response.status, 200);
          const [stored] = await w.items.byCron(cron.id);
          assert.equal(stored!.sourcePayload!.automated, classified ? automated : undefined);
          assert.equal(stored!.sourcePayload!.probablyResolved, classified ? false : undefined);
          assert.equal(stored!.status, "ready");
          assert.equal(stored!.proposal!.data.body, ITEM.draft.body);
          const [summary] = await w.items.summaries([cron.id]);
          assert.equal(summary!.inboxPreview!.automated, undefined);
        }
      }
    }
  }
});

test("a company inbox cannot opt into personal inbox classification", async () => {
  const w = world();
  const cron = await plainCron(w, { source: "gmail" }, "company:org");
  const response = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    flagEnabled: async () => {
      assert.fail("company inbox must not read a personal flag");
    },
    body: {
      items: [
        {
          ...ITEM,
          source: "gmail",
          sourceKey: "mail",
          gmail: { threadId: "mail" },
          automated: true,
          probablyResolved: false,
        },
      ],
    },
  });
  assert.equal(response.status, 200);
  const [item] = await w.items.byCron(cron.id);
  assert.equal(item!.sourcePayload!.automated, undefined);
  assert.equal(item!.sourcePayload!.probablyResolved, undefined);
});

test("an owner cannot trigger Slack avatar enrichment through item detail when Inbox is disabled", async () => {
  const w = world();
  const cron = await inboxCron(w);
  await w.items.ingest([
    {
      cronId: cron.id,
      dedupeKey: "D1",
      source: "slack",
      sourceAt: 1000,
      sourcePayload: { slack: { channelId: "D1", ts: "1.0", userId: "U1" } },
    },
  ]);
  const [item] = await w.items.byCron(cron.id);
  const before = structuredClone(item);
  const enabled = async (flag: string, scope: string) => {
    assert.equal(flag, "inbox_loops");
    assert.equal(scope, "personal:josh");
    return false;
  };
  w.sourceRefresh = createInboxSourceRefresh({
    items: w.items,
    record: async () => undefined,
    featureFlags: { enabled },
    tokens: { connectorAccessToken: async () => assert.fail("disabled Inbox must not read credentials") },
    directory: { getBySlackId: async () => assert.fail("disabled Inbox must not read the directory") },
    fetchImpl: async () => assert.fail("disabled Inbox must not call Slack"),
  });
  const result = await call(w, {
    method: "GET",
    path: `/v1/crons/${cron.id}/items/${item!.id}?refreshSource=1`,
    flagEnabled: enabled,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await w.items.get(item!.id), before);
});

test("each inbox sync task carries only its own source's guidance", () => {
  const gmail = renderSourceInboxTask("gmail");
  const slack = renderSourceInboxTask("slack");
  assert.ok(gmail.includes("rfcMessageId") && !gmail.includes("conversations.replies"));
  assert.ok(slack.includes("conversations.replies") && !slack.includes("rfcMessageId"));
});
