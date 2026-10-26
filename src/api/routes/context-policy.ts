import { parseScopeId, type ScopeId } from "../../types.ts";
import { InstructionsVersionConflictError } from "../app-types.ts";
import { MAX_INSTRUCTIONS_CHARS } from "../../resolution/config-store.ts";
import { parseBotLedger } from "../../surface-cache/channel-policy-store.ts";
import { sendJson } from "../http.ts";
import { audit, isObj, refuse } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

async function policyContainer(ctx: ApiCtx, principalId: string, scope: string): Promise<string | null> {
  const { res, deps } = ctx;
  if (!principalId || !scope)
    return refuse(res, 400, { error: "bad_request", message: "principalId and scope required" });
  const { kind, ref } = parseScopeId(scope);
  if (!ref || (kind !== "channel" && kind !== "group"))
    return refuse(res, 400, {
      error: "bad_request",
      message: "ambient policy applies to channel and group scopes only",
    });
  if (!deps.channelPolicy) return refuse(res, 404, { error: "not_found", message: "not available on this deployment" });
  if ((await ctx.app.listContexts(principalId)).some((c) => c.scopeId === scope)) return ref;
  return refuse(res, 403, { error: "forbidden" });
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
  const instructions = ctx.app.getInstructions((url.searchParams.get("scope") ?? "").trim() as ScopeId);
  return sendJson(res, 200, {
    policy: {
      instructions: instructions.instructions ?? "",
      instructionsVersion: instructions.instructionsVersion,
      bots: p?.bots ?? {},
      ambientEnabled: p?.ambientEnabled ?? null,
      updatedAt: p?.updatedAt ?? 0,
    },
  });
}

export async function setContextPolicy(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, app } = ctx;
  const b = isObj(body) ? body : {};
  const principalId = typeof b.principalId === "string" ? b.principalId.trim() : "";
  const scope = typeof b.scope === "string" ? b.scope.trim() : "";
  const container = await policyContainer(ctx, principalId, scope);
  if (!container) return;
  const parsed = parseBotLedger(b.bots ?? {});
  if ("error" in parsed) return sendJson(res, 400, { error: "bad_request", message: parsed.error });
  if (b.ambientEnabled !== undefined && b.ambientEnabled !== null && typeof b.ambientEnabled !== "boolean")
    return sendJson(res, 400, {
      error: "bad_request",
      message: "ambientEnabled must be a boolean or null (null = default rule)",
    });
  if (b.instructions !== undefined && typeof b.instructions !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "instructions must be a string" });
  if (typeof b.instructions === "string" && b.instructions.length > MAX_INSTRUCTIONS_CHARS)
    return sendJson(res, 400, {
      error: "bad_request",
      message: `instructions are capped at ${MAX_INSTRUCTIONS_CHARS} characters`,
    });
  const current = await deps.channelPolicy!.get(container);
  if (typeof b.baseUpdatedAt === "number" && (current?.updatedAt ?? 0) !== b.baseUpdatedAt) {
    return sendJson(res, 409, {
      error: "conflict",
      message: "this channel's policy changed since you loaded it — reload and re-apply your edit",
    });
  }
  if (typeof b.instructions === "string" && b.instructions !== (app.getInstructions(scope as ScopeId).instructions ?? "")) {
    try {
      await app.updateInstructions(scope as ScopeId, b.instructions, principalId, {
        allowSharedScope: true,
        ...(typeof b.instructionsVersion === "number" ? { expectedVersion: b.instructionsVersion } : {}),
      });
    } catch (e) {
      if (e instanceof InstructionsVersionConflictError)
        return sendJson(res, 409, { error: "conflict", message: e.message });
      throw e;
    }
  }
  const p = await deps.channelPolicy!.set(container, {
    setBy: principalId,
    bots: parsed.bots,
    ambientEnabled: b.ambientEnabled as boolean | null | undefined,
  });
  audit(deps, { principalId, action: "surface.policy.set", resource: container, scopeLabel: scope });
  const saved = app.getInstructions(scope as ScopeId);
  return sendJson(res, 200, {
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
  { method: "PUT", path: "/v1/contexts/policy", auth: "source", handle: setContextPolicy },
];
