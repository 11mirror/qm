import type { BaseCtx, Route, RouteResult } from "./route.ts";
import type { App } from "../app.ts";
import { canonicalPayload } from "../../../plugins/chassis/src/source-auth-sign.ts";
import { verifyOrReject } from "../http.ts";

const HEARTBEAT_MS = 25_000;

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

export function signedEventStream(
  event: string,
  subscribe: (app: App, send: (data: unknown) => void, onResync: () => void) => () => void,
): (ctx: BaseCtx) => Promise<RouteResult> {
  return async (ctx) => {
    const { req, res, app, secret, auth, url, pathname, method } = ctx;
    const payload = canonicalPayload(method, pathname + url.search, "");
    if (!(await verifyOrReject(req, res, secret, auth, payload, false, ctx.allowUnsignedSourceAuth))) {
      req.resume();
      return;
    }
    res.writeHead(200, SSE_HEADERS);
    res.write(": open\n\n");
    const unsubscribe = subscribe(
      app,
      (data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      () => res.write(`event: ${event}_resync\ndata: {}\n\n`),
    );
    const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    beat.unref?.();
    req.on("close", () => {
      clearInterval(beat);
      unsubscribe();
    });
  };
}

export const sessionStateRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  {
    method: "GET",
    path: "/v1/session-state/events",
    auth: "source",
    handle: signedEventStream("session_state", (app, send, onResync) => app.subscribeSessionStates(send, { onResync })),
  },
];
