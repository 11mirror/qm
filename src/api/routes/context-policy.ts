import { parseScopeId } from "../../types.ts";
import { parseBotLedger } from "../../surface-cache/channel-policy-store.ts";
import { sendJson } from "../http.ts";
import { audit, isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

const MAX_ORDERS_CHARS = 20_000;

async function policyContainer(ctx: ApiCtx, principalId: string, scope: string): Promise<string | null> {
  const { res, deps } = ctx;
  if (!principalId || !scope) {
    sendJson(res, 400, { error: "bad_request", message: "principalId and scope required" });
    return null;
  }
  const { kind, ref } = parseScopeId(scope);
  if (!ref || (kind !== "channel" && kind !== "group")) {
    sendJson(res, 400, { error: "bad_request", message: "ambient policy applies to channel and group scopes only" });
    return null;
  }
  if (!deps.channelPolicy) {
    sendJson(res, 404, { error: "not_found", message: "not available on this deployment" });
    return null;
  }
  if ((await ctx.app.listContexts(principalId)).some((c) => c.scopeId === scope)) return ref;
  sendJson(res, 403, { error: "forbidden" });
  return null;
}

export async function getContextPolicy(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const container = await policyContainer(
    ctx,
    (url.searchParams.get("principalId") ?? "").trim(),
    (url.searchParams.get("scope") ?? "").trim(),
  );
  if (!container) return;
  const p = await deps.channelPolicy!.get(container);
  return sendJson(res, 200, {
    policy: {
      orders: p?.orders ?? "",
      bots: p?.bots ?? {},
      ambientEnabled: p?.ambientEnabled ?? null,
      updatedAt: p?.updatedAt ?? 0,
    },
  });
}

export async function setContextPolicy(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const b = isObj(body) ? body : {};
  const principalId = typeof b.principalId === "string" ? b.principalId.trim() : "";
  const scope = typeof b.scope === "string" ? b.scope.trim() : "";
  const container = await policyContainer(ctx, principalId, scope);
  if (!container) return;
  if (typeof b.orders !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "orders (string) required" });
  if (b.orders.length > MAX_ORDERS_CHARS)
    return sendJson(res, 400, {
      error: "bad_request",
      message: `standing order is capped at ${MAX_ORDERS_CHARS} characters — it is rendered into every ambient judgment`,
    });
  const parsed = parseBotLedger(b.bots ?? {});
  if ("error" in parsed) return sendJson(res, 400, { error: "bad_request", message: parsed.error });
  if (b.ambientEnabled !== undefined && b.ambientEnabled !== null && typeof b.ambientEnabled !== "boolean")
    return sendJson(res, 400, {
      error: "bad_request",
      message: "ambientEnabled must be a boolean or null (null = default rule)",
    });
  const current = await deps.channelPolicy!.get(container);
  if (typeof b.baseUpdatedAt === "number" && (current?.updatedAt ?? 0) !== b.baseUpdatedAt) {
    return sendJson(res, 409, {
      error: "conflict",
      message: "this channel's policy changed since you loaded it — reload and re-apply your edit",
    });
  }
  const p = await deps.channelPolicy!.set(container, b.orders, {
    setBy: principalId,
    bots: parsed.bots,
    ambientEnabled: b.ambientEnabled as boolean | null | undefined,
  });
  audit(deps, { principalId, action: "surface.policy.set", resource: container, scopeLabel: scope });
  return sendJson(res, 200, {
    policy: { orders: p.orders, bots: p.bots, ambientEnabled: p.ambientEnabled ?? null, updatedAt: p.updatedAt },
  });
}

export const contextPolicyRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/contexts/policy", actor: "query.principalId", auth: "source", handle: getContextPolicy },
  { method: "PUT", path: "/v1/contexts/policy", auth: "source", handle: setContextPolicy },
];
