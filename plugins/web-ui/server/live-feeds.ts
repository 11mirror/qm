import { swallow } from "../../chassis/src/errors.ts";
import { type ServerResponse } from "node:http";

import { coreFetch, fetchCoreGet, tryParse } from "./core-relay.ts";

export const eventClients = new Map<string, Set<ServerResponse>>();

const ownerOfWebThread = (threadRef: string) => /^web:([^:]+):/.exec(threadRef)?.[1];

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

function sseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendTo(users: Iterable<string>, event: string, data: unknown = {}): void {
  for (const user of users) for (const res of eventClients.get(user) ?? []) sseEvent(res, event, data);
}

export const SSE_HEARTBEAT_MS = 15_000;

const STATE_FEED_RECONNECT_MS = Number(process.env.STATE_FEED_RECONNECT_MS ?? 3_000);

interface SessionStateFrame {
  threadRef?: string;
  state?: string;
  participants?: string[];
  [k: string]: unknown;
}

function forwardSessionState(frame: SessionStateFrame): void {
  const threadRef = typeof frame.threadRef === "string" ? frame.threadRef : "";
  if (!threadRef) return;
  const targets = new Set<string>(
    Array.isArray(frame.participants) ? frame.participants.filter((p): p is string => typeof p === "string") : [],
  );
  if (targets.size === 0) {
    const owner = ownerOfWebThread(threadRef);
    if (owner) targets.add(owner);
  }
  const { participants: _participants, ...visible } = frame;
  sendTo(targets, "session_state", visible);
}

async function consumeCoreFeed(
  path: string,
  eventName: string,
  onEvent: (data: unknown) => void,
  onReconnect?: () => void,
): Promise<void> {
  let dropped = false;
  for (;;) {
    try {
      const r = await fetchCoreGet(path, {}, {});
      if (r.status === 200 && r.body) {
        if (dropped) {
          dropped = false;
          onReconnect?.();
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const lines = frame.split("\n");
            if (lines.some((l) => l === `event: ${eventName}_resync`)) {
              onReconnect?.();
              continue;
            }
            if (!lines.some((l) => l === `event: ${eventName}`)) continue;
            const data = lines.find((l) => l.startsWith("data: "))?.slice("data: ".length);
            if (!data) continue;
            try {
              onEvent(JSON.parse(data));
            } catch (error) {
              swallow(`web-ui: ${eventName} feed dropped a malformed frame`, error);
            }
          }
        }
        console.warn(`[web-ui] ${eventName} feed ended; reconnecting`);
      } else console.warn(`[web-ui] ${eventName} feed returned HTTP ${r.status}; reconnecting`);
      dropped = true;
    } catch (error) {
      swallow(`web-ui: ${eventName} feed dropped (reconnecting)`, error);
      dropped = true;
    }
    await new Promise((resolve) => setTimeout(resolve, STATE_FEED_RECONNECT_MS));
  }
}

export function runStateFeed(): Promise<void> {
  return consumeCoreFeed(
    "/v1/session-state/events",
    "session_state",
    (data) => forwardSessionState(data as SessionStateFrame),
    () => sendTo(eventClients.keys(), "session_state_resync"),
  );
}

export function runInboxFeed(): Promise<void> {
  return consumeCoreFeed(
    "/v1/cron-items/events",
    "inbox_item",
    (data) => void forwardInboxItem(data as { cronId?: string; itemId?: string; op?: string }),
    resyncInbox,
  );
}

const resyncInbox = () => sendTo(eventClients.keys(), "inbox_resync");

async function forwardInboxItem(ev: { cronId?: string; itemId?: string; op?: string }): Promise<void> {
  if (!ev.cronId || !ev.itemId || !eventClients.size) return;
  const r = await coreFetch(
    "POST",
    "/v1/inbox/viewers",
    JSON.stringify({ cronId: ev.cronId, candidates: [...eventClients.keys()] }),
  ).catch(() => null);
  if (r?.status === 404) return;
  const viewers = r?.status === 200 ? tryParse<{ viewers?: string[] }>(r.text)?.viewers : undefined;
  if (!viewers) return resyncInbox();
  sendTo(viewers, "inbox_item", { cronId: ev.cronId, itemId: ev.itemId, op: ev.op ?? "" });
}
