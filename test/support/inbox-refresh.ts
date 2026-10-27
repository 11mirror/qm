import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createInboxSourceRefresh as createRefresh } from "../../src/inbox/source-refresh.ts";
import { createInboxLedger } from "../../src/inbox/ledger.ts";
import { testMap } from "./test-database.ts";

export async function fixture(source = "gmail", meta: Record<string, unknown> = { threadId: "t1" }) {
  const items = createInboxLedger(testMap());
  await items.ingest([
    {
      cronId: "inbox",
      dedupeKey: "ask",
      source,
      sourceAt: 1000,
      sourcePayload: { source, [source]: meta, context: [{ author: "Elsewhere", text: "UNRELATED CHANNEL TAIL" }] },
      proposal: { by: "human", data: { body: "Keep my edit" } },
    },
  ]);
  return { items, item: (await items.byCron("inbox"))[0]! };
}

export let slackHandler: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  assert.fail("no Slack reads");

export const slackServer = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    const method = (req.url ?? "").replace(/^\/api\//, "");
    void slackHandler(`https://slack.test/api/${method}?${body}`)
      .then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      })
      .catch(() => res.writeHead(500).end());
  });
});

export function slackUrl(handler: (url: string, init?: RequestInit) => Promise<Response>): string {
  slackHandler = handler;
  const address = slackServer.address();
  if (!address || typeof address === "string") throw new Error("slack test server is not listening");
  return `http://127.0.0.1:${address.port}/api/`;
}

export const featureFlags = { enabled: async () => true };

export const createInboxSourceRefresh = (
  deps: Omit<Parameters<typeof createRefresh>[0], "record"> & {
    record?: Parameters<typeof createRefresh>[0]["record"];
  },
) => createRefresh({ record: async () => undefined, ...deps });

export const tokens = { connectorAccessToken: async () => "synthetic-token" };

export const json = (body: unknown) => Response.json(body);

export const ALEX = "https://avatars.slack-edge.com/alex.png";

export function directoryOf(
  people: Record<string, { displayName: string; avatarUrl?: string }>,
  onLookup?: (id: string) => unknown,
) {
  return {
    getBySlackId: async (id: string) => {
      await onLookup?.(id);
      const person = people[id];
      return person ? { principalId: `${id}@x.com`, slackId: id, type: "internal" as const, ...person } : null;
    },
  };
}

export const directory = directoryOf({ U1: { displayName: "Alex", avatarUrl: ALEX }, U2: { displayName: "Taylor" } });

export function slackFetch(
  calls: string[],
  options: { direct?: boolean; partial?: boolean; own?: boolean } = {},
): typeof fetch {
  return async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    if (u.pathname.endsWith("conversations.info"))
      return json({ ok: true, channel: { is_mpim: options.direct === true } });
    if (u.pathname.endsWith("users.info"))
      return json({
        ok: true,
        user: { profile: { display_name: u.searchParams.get("user") === "U1" ? "Alex" : "Taylor" } },
      });
    if (u.pathname.endsWith("auth.test")) return json({ ok: true, user_id: "U2" });
    return json({
      ok: true,
      has_more: options.partial ?? false,
      messages: [
        { ts: "2.0", thread_ts: "1.0", user: options.own ? "U2" : "U1", text: "Thread reply" },
        { ts: "1.0", user: "U1", text: "Original mention" },
        ...(options.direct ? [] : [{ ts: "99.0", thread_ts: "88.0", user: "U2", text: "UNRELATED OTHER THREAD" }]),
      ],
    });
  };
}
