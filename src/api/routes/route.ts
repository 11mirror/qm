import type { UNATTENDED_ADMIN_GRANTS } from "../control-service.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { compilePath, findRoute, type RouteShape } from "../../../plugins/chassis/src/router.ts";

export { compilePath, findRoute };
import type { App } from "../app.ts";
import type { ConfiguredDeps, ServerDeps } from "../deps.ts";
import type { SourceAuth } from "../../auth/source-auth.ts";
import type { CapabilityClaims } from "../../auth/capability-token.ts";
import type { PortalIdentity } from "../../auth/portal-identity.ts";

export interface BaseCtx {
  req: IncomingMessage;
  res: ServerResponse;
  app: App;
  deps: ServerDeps;
  secret: string | undefined;
  auth: SourceAuth | null;
  allowUnsignedSourceAuth: boolean;
  url: URL;
  pathname: string;
  method: string;
  params: Record<string, string>;
  capability?: CapabilityClaims | null;
}

export type ConfiguredCtx = ApiCtx & { deps: ConfiguredDeps };

export const isConfigured = (ctx: ApiCtx): ctx is ConfiguredCtx => ctx.deps.config !== undefined;

export interface ApiCtx extends BaseCtx {
  body: unknown;
  capability: CapabilityClaims | null;
  actor?: PortalIdentity | null;
}

export type RouteAuth = "either" | "source" | "public" | { aud: string };

export type RouteActor = "person" | "system" | `${"query" | "body"}.${string}`;

export interface AdminAccess {
  agent?: "anyone" | { portalOnly: string };
  privateRead?: "always" | "unless-org-scope";
  unattended?: { grant: (typeof UNATTENDED_ADMIN_GRANTS)[number]; summary: string };
}

export type Route<C extends BaseCtx = ApiCtx> = {
  handle: (ctx: C) => void | Promise<void>;
  auth: RouteAuth;
  actor?: RouteActor;
  admin?: AdminAccess;
  allowedInStrict?: true;
  maxBodyBytes?: number;
} & ({ method: string; path: string } | { match: (method: string, pathname: string) => boolean });

export function withActor<C extends BaseCtx>(actor: RouteActor, routes: Route<C>[]): Route<C>[] {
  return routes.map((route) => ({ actor, ...route }));
}

export function withAdmin<C extends BaseCtx>(routes: Route<C>[]): Route<C>[] {
  return routes.map((route) => ({ actor: "person", admin: {}, ...route }));
}

type Found<R> = { route: R; params: Record<string, string> } | null;
type PathRoute = Extract<RouteShape, { path: string }>;

export function createRouter<R extends RouteShape>(
  routes: ReadonlyArray<R>,
): (method: string, pathname: string) => Found<R> {
  const pathRoutes = routes.filter((r): r is R & PathRoute => "path" in r);
  const matchers = routes.filter((r) => !("path" in r));
  const shape = (route: PathRoute) => route.path.split("/").map((segment) => segment.startsWith(":"));
  const staticFirst = (a: PathRoute, b: PathRoute) => {
    const [x, y] = [shape(a), shape(b)];
    const differs = x.findIndex((param, i) => param !== y[i]);
    return differs < 0 ? 0 : Number(x[differs]) - Number(y[differs]);
  };
  const buckets = new Map<string, Array<{ route: R & PathRoute; path: ReturnType<typeof compilePath> }>>();
  for (const route of pathRoutes) {
    const key = `${route.method} ${route.path.split("/").length}`;
    buckets.set(key, [...(buckets.get(key) ?? []), { route, path: compilePath(route.path) }]);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => staticFirst(a.route, b.route));
  return (method, pathname) => {
    for (const { route, path } of buckets.get(`${method} ${pathname.split("/").length}`) ?? []) {
      const params: Record<string, string> = {};
      if (path.test(method, pathname, params)) return { route, params };
    }
    const route = matchers.find((r) => "match" in r && r.match(method, pathname));
    return route ? { route, params: {} } : null;
  };
}

export async function run<C extends BaseCtx>(route: Route<C>, params: Record<string, string>, ctx: C): Promise<void> {
  ctx.params = params;
  await route.handle(ctx);
}
