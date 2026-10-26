import { sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

const PATH = "/slack/events";

async function receiveSlackEvents(ctx: BaseCtx): Promise<void> {
  const handle = ctx.deps.slackEvents?.(ctx.pathname.slice(PATH.length + 1));
  if (!handle) return sendJson(ctx.res, 404, { error: "not_found" });
  await handle(ctx.req, ctx.res);
}

export const slackEventRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  {
    match: (method, pathname) => method === "POST" && (pathname === PATH || pathname.startsWith(`${PATH}/`)),
    auth: "public",
    handle: receiveSlackEvents,
  },
];
