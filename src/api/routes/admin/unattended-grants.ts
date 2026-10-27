import { adminOperations } from "../../../tools/admin.ts";
import { orgAdmin } from "./common.ts";
import { type ApiCtx, ok, type Route, type RouteResult } from "../route.ts";

export function unattendedGrantListing(routes: ReadonlyArray<Route<ApiCtx>>) {
  return routes.flatMap((route) => {
    if (!("path" in route) || !route.admin?.unattended) return [];
    const action = Object.entries(adminOperations).find(
      ([, op]) => op.method === route.method && `/v1/admin${op.path}` === route.path,
    )?.[0];
    const { grant, summary } = route.admin.unattended;
    return [{ grant, method: route.method, path: route.path, summary, ...(action ? { action } : {}) }];
  });
}

export async function listUnattendedGrants(ctx: ApiCtx, routes: ReadonlyArray<Route<ApiCtx>>): Promise<RouteResult> {
  if (!(await orgAdmin(ctx, "unattended-grants"))) return;
  return ok({ grants: unattendedGrantListing(routes) });
}
