import { readRawBody } from "../http.ts";
import { type BaseCtx, reply, type Route, type RouteResult } from "./route.ts";

async function surfaceEvents(ctx: BaseCtx): Promise<RouteResult> {
  const { req, deps, params, url } = ctx;
  if (!deps.chatSurfaces) {
    req.resume();
    return reply(404, { error: "not_found" });
  }
  const out = await deps.chatSurfaces.receive(params.surface!, {
    headers: req.headers,
    pathWithQuery: url.pathname + url.search,
    rawBody: await readRawBody(req),
  });
  return reply(out.status, out.body);
}

export const chatSurfaceRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/surfaces/:surface/events", auth: "public", handle: surfaceEvents },
];
