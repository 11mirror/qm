import assert from "node:assert/strict";
import { cronItemRoutes } from "../../src/api/routes/cron-items.ts";
import { findRoute, run, type ApiCtx } from "../../src/api/routes/route.ts";
import { createInboxLedger, type InboxLedger } from "../../src/inbox/ledger.ts";
import { ensureInboxCron } from "../../src/inbox/sync-task.ts";
import { type InboxSourceRefresh } from "../../src/inbox/source-refresh.ts";
import type { InboxChat } from "../../src/inbox/item-chat.ts";
import type { Cron } from "../../src/types.ts";
import type { LedgerItemView } from "../../src/inbox/view.ts";
import type { SlackUserClient } from "../../src/inbox/sources/adapter.ts";
import { inboxApp } from "./inbox-app.ts";
import { testDatabaseUrl } from "./test-database.ts";

export function fakeRes() {
  const out = { status: 0, body: undefined as unknown };
  return {
    res: {
      getHeader() {},
      setHeader() {},
      writeHead(status: number) {
        out.status = status;
        return this;
      },
      end(data?: string) {
        out.body = data ? JSON.parse(data) : undefined;
      },
    } as unknown as ApiCtx["res"],
    out,
  };
}

export interface World {
  sourceRefresh?: InboxSourceRefresh;
  items: InboxLedger;
  chat?: InboxChat;
  crons: ReturnType<typeof inboxApp>["crons"];
  app: ReturnType<typeof inboxApp>["app"];
  sent: Array<{ host: string; body: unknown }>;
  slackOk: boolean;
  followUps: Array<{ itemId: string; message: string; actorId: string }>;
  tokens: boolean;
}

export function world(over: { tokens?: boolean; chat?: boolean } = {}): World {
  const { crons, app } = inboxApp();
  const w: World = {
    items: createInboxLedger(testDatabaseUrl()),
    crons,
    app,
    sent: [],
    slackOk: true,
    followUps: [],
    tokens: over.tokens !== false,
  };
  if (over.chat !== false) {
    w.chat = {
      followUp: async (_cron, item, message, actorId) => {
        w.followUps.push({ itemId: item.id, message, actorId });
        await w.items.appendThread(item.id, [{ role: "human", text: message, actorId }]);
        await w.items.appendThread(item.id, [{ role: "agent", text: "shortened it" }]);
        await w.items.setProposal(item.id, { data: { body: "shorter" }, by: "agent" });
        return w.items.get(item.id);
      },
    };
  }
  return w;
}

export function slackClientFor(w: World): (token: string) => SlackUserClient {
  const call = (api: string) => async (args: Record<string, unknown>) => {
    w.sent.push({ host: api, body: args });
    if (!w.slackOk) {
      throw Object.assign(new Error("An API error occurred"), { data: { ok: false, error: "not_in_channel" } });
    }
    return { ok: true };
  };
  return () => ({ chat: { postMessage: call("chat.postMessage") }, reactions: { add: call("reactions.add") } });
}

export async function call(
  w: World,
  over: {
    method: string;
    path: string;
    body?: unknown;
    capability?: Record<string, unknown> | null;
    sessionForThread?: string;
    flagEnabled?: (flag: string, scope: string) => Promise<boolean>;
  },
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`http://x${over.path}`);
  const found = findRoute(cronItemRoutes, over.method, url.pathname);
  assert.ok(found, `${over.method} ${over.path} should match a cron item route`);
  const { res, out } = fakeRes();
  const ctx = {
    res,
    url,
    pathname: url.pathname,
    method: over.method,
    body: over.body ?? null,
    params: found.params,
    capability: over.capability === undefined ? CAP : over.capability,
    deps: {
      featureFlags: { enabled: over.flagEnabled ?? (async () => true) },
      inbox: { items: w.items, record: async () => {}, scans: w.crons, ...(w.chat ? { chat: w.chat } : {}) },
      ...(w.sourceRefresh ? { inboxSourceRefresh: w.sourceRefresh } : {}),
      sessions: {
        getByThread: async (threadRef: string) =>
          over.sessionForThread && threadRef === "thread-9" ? { id: over.sessionForThread } : null,
      },
      inboxSlackClient: slackClientFor(w),
      ...(w.tokens ? { inboxSourceTokens: { connectorAccessToken: async () => "tok" } } : {}),
    },
    app: w.app,
  } as unknown as ApiCtx;
  await run(found.route, found.params, ctx);
  return out;
}

export const CAP = { actorId: "josh", privateScope: true, scopeId: "personal:josh", liveActor: true, exp: 0 };

export const PORTAL = null;

export const ITEM = {
  source: "slack",
  sourceKey: "C1:1.2",
  title: "#launches",
  from: "Ada",
  snippet: "can you review my launch post?",
  receivedAt: 1234,
  draft: { body: "Looking now — back to you within the hour." },
  slack: { channelId: "C1", ts: "1.2", isDirectMessage: false },
};

export async function inboxCron(w: World, source = "slack"): Promise<Cron> {
  return ensureInboxCron(w.crons, "josh", source);
}

export async function plainCron(w: World, inbox: Cron["inbox"], ownerScopeId = "personal:josh"): Promise<Cron> {
  return w.crons.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId,
    schedule: { everyMs: 60 * 60 * 1000 },
    enabled: false,
    title: "Triage",
    action: "triage",
    ...(inbox ? { inbox } : {}),
  });
}

export async function seed(
  w: World,
  item: Record<string, unknown> = ITEM,
): Promise<{ w: World; cron: Cron; item: LedgerItemView }> {
  const cron = await inboxCron(w);
  const out = await call(w, { method: "POST", path: `/v1/crons/${cron.id}/items`, body: { items: [item] } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const listed = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items` });
  const items = (listed.body as { items: LedgerItemView[] }).items;
  return { w, cron, item: items[0]! };
}
