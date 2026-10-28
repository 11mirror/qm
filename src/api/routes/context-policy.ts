import { parseScopeId, type ScopeId } from "../../types.ts";
import { InstructionsVersionConflictError } from "../app-types.ts";
import { parseBotLedger, type BotPolicy, type ChannelPolicyStore } from "../../surface-cache/channel-policy-store.ts";
import { audit, isObj, refuse } from "./shared.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult } from "./route.ts";

export async function checkChannelSettings(
  store: ChannelPolicyStore,
  container: string,
  input: { bots?: unknown; ambientEnabled?: unknown; baseUpdatedAt?: unknown },
): Promise<
  | { bots: Record<string, BotPolicy>; ambientEnabled: boolean | null | undefined }
  | { status: 400 | 409; message: string }
> {
  const parsed = parseBotLedger(input.bots);
  if ("error" in parsed) return { status: 400, message: parsed.error };
  const { ambientEnabled } = input;
  if (ambientEnabled !== undefined && ambientEnabled !== null && typeof ambientEnabled !== "boolean")
    return { status: 400, message: "ambientEnabled must be a boolean or null (null = default rule)" };
  const current = await store.get(container);
  if (typeof input.baseUpdatedAt === "number" && (current?.updatedAt ?? 0) !== input.baseUpdatedAt)
    return {
      status: 409,
      message: "this channel's policy changed since you loaded it — reload and re-apply your edit",
    };
  return { bots: parsed.bots, ambientEnabled };
}

async function policyContainer(ctx: ApiCtx, principalId: string, scope: string): Promise<string | null> {
  const { deps } = ctx;
  if (!principalId || !scope) throw refuse(400, { error: "bad_request", message: "principalId and scope required" });
  const { kind, ref } = parseScopeId(scope);
  if (!ref || (kind !== "channel" && kind !== "group"))
    throw refuse(400, {
      error: "bad_request",
      message: "ambient policy applies to channel and group scopes only",
    });
  if (!deps.channelPolicy) throw refuse(404, { error: "not_found", message: "not available on this deployment" });
  if ((await ctx.app.listContexts(principalId)).some((c) => c.scopeId === scope)) return ref;
  throw refuse(403, { error: "forbidden" });
}

export async function getContextPolicy(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, url } = ctx;
  const container = await policyContainer(
    ctx,
    (url.searchParams.get("principalId") ?? "").trim(),
    (url.searchParams.get("scope") ?? "").trim(),
  );
  if (!container) return;
  const p = await deps.channelPolicy!.get(container);
  const instructions = ctx.app.getInstructions((url.searchParams.get("scope") ?? "").trim() as ScopeId);
  return ok({
    policy: {
      instructions: instructions.instructions ?? "",
      instructionsVersion: instructions.instructionsVersion,
      bots: p?.bots ?? {},
      ambientEnabled: p?.ambientEnabled ?? null,
      updatedAt: p?.updatedAt ?? 0,
    },
  });
}

export async function setContextPolicy(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body, app } = ctx;
  const b = isObj(body) ? body : {};
  const principalId = typeof b.principalId === "string" ? b.principalId.trim() : "";
  const scope = typeof b.scope === "string" ? b.scope.trim() : "";
  const container = await policyContainer(ctx, principalId, scope);
  if (!container) return;
  if (b.instructions !== undefined && typeof b.instructions !== "string")
    return reply(400, { error: "bad_request", message: "instructions must be a string" });
  const settings = await checkChannelSettings(deps.channelPolicy!, container, { ...b, bots: b.bots ?? {} });
  if ("message" in settings)
    return reply(settings.status, {
      error: settings.status === 409 ? "conflict" : "bad_request",
      message: settings.message,
    });
  if (
    typeof b.instructions === "string" &&
    b.instructions !== (app.getInstructions(scope as ScopeId).instructions ?? "")
  ) {
    try {
      await app.updateInstructions(scope as ScopeId, b.instructions, principalId, {
        allowSharedScope: true,
        ...(typeof b.instructionsVersion === "number" ? { expectedVersion: b.instructionsVersion } : {}),
      });
    } catch (e) {
      if (e instanceof InstructionsVersionConflictError) return reply(409, { error: "conflict", message: e.message });
      throw e;
    }
  }
  const p = await deps.channelPolicy!.set(container, { setBy: principalId, ...settings });
  audit(deps, { principalId, action: "surface.policy.set", resource: container, scopeLabel: scope });
  const saved = app.getInstructions(scope as ScopeId);
  return ok({
    policy: {
      instructions: saved.instructions ?? "",
      instructionsVersion: saved.instructionsVersion,
      bots: p.bots,
      ambientEnabled: p.ambientEnabled ?? null,
      updatedAt: p.updatedAt,
    },
  });
}

export const contextPolicyRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/contexts/policy", actor: "query.principalId", auth: "source", handle: getContextPolicy },
  { method: "PUT", path: "/v1/contexts/policy", actor: "body.principalId", auth: "source", handle: setContextPolicy },
];
