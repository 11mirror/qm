import { readRawBody, sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

async function surfaceEvents(ctx: BaseCtx): Promise<void> {
  const { req, res, deps, params, url } = ctx;
  if (!deps.chatSurfaces) {
    req.resume();
    return sendJson(res, 404, { error: "not_found" });
  }
  const out = await deps.chatSurfaces.receive(params.surface!, {
    headers: req.headers,
    pathWithQuery: url.pathname + url.search,
    rawBody: await readRawBody(req),
  });
  return sendJson(res, out.status, out.body);
}

export const chatSurfaceRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/surfaces/:surface/events", auth: "public", handle: surfaceEvents },
];
