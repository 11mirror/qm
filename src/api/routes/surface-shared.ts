import { parseScopeId } from "../../types.ts";
import { fail, type HttpError } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "./route.ts";
import { livePersonCapability, SHARED_SKILL_TRIGGER_REFUSAL } from "../artifact-share.ts";

export function sharedSkillCreateBlock(capability: ApiCtx["capability"]): string | null {
  if (!capability) return null;
  if (parseScopeId(capability.scopeId).kind === "personal") return null;
  if (livePersonCapability(capability)) return null;
  return SHARED_SKILL_TRIGGER_REFUSAL;
}

export const AGENT_ONLY = { error: "capability_required", message: "this endpoint is for the agent self-API" };
export const WINDOW_ERROR = "tailTurns and beforeSeq must be positive integers, sinceSeq a non-negative one";

export const badRequest = (message: string): HttpError => fail(400, "bad_request", message);

export function found(value: unknown): RouteResult {
  return value ? ok(value) : reply(404, { error: "not_found" });
}

export function bodyField(ctx: ApiCtx, name: string): unknown {
  return isObj(ctx.body) ? ctx.body[name] : undefined;
}

export function bodyPrincipal(ctx: ApiCtx): string | null {
  const principalId = bodyField(ctx, "principalId");
  return typeof principalId === "string" && principalId ? principalId : null;
}

export function withQuery(
  name: "viewer" | "principalId",
  handle: (ctx: ApiCtx, id: string) => Promise<RouteResult>,
): (ctx: ApiCtx) => Promise<RouteResult> {
  return async (ctx) => {
    const id = ctx.url.searchParams.get(name);
    if (!id) throw badRequest(`${name} required`);
    return handle(ctx, id);
  };
}

export function withBodyPrincipal(
  handle: (ctx: ApiCtx, principalId: string) => Promise<RouteResult>,
): (ctx: ApiCtx) => Promise<RouteResult> {
  return async (ctx) => {
    const principalId = bodyPrincipal(ctx);
    if (!principalId) throw badRequest("principalId required");
    return handle(ctx, principalId);
  };
}
