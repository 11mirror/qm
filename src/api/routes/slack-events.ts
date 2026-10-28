import { type BaseCtx, reply, type Route, type RouteResult } from "./route.ts";

const PATHS = ["/slack/events", "/slack/interactions"];

const accountOf = (pathname: string): string | undefined => {
  for (const path of PATHS) {
    if (pathname === path) return "";
    if (pathname.startsWith(`${path}/`)) return pathname.slice(path.length + 1);
  }
  return undefined;
};

async function receiveSlackEvents(ctx: BaseCtx): Promise<RouteResult> {
  const served = await ctx.deps.slackEvents?.(accountOf(ctx.pathname) ?? "", ctx.req, ctx.res);
  if (!served) return reply(404, { error: "not_found" });
}

export const slackEventRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  {
    match: (method, pathname) => method === "POST" && accountOf(pathname) !== undefined,
    auth: "public",
    handle: receiveSlackEvents,
  },
];
