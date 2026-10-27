import { parseScopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx } from "./route.ts";
import { livePersonCapability, SHARED_SKILL_TRIGGER_REFUSAL } from "../artifact-share.ts";

export function sharedSkillCreateBlock(capability: ApiCtx["capability"]): string | null {
  if (!capability) return null;
  if (parseScopeId(capability.scopeId).kind === "personal") return null;
  if (livePersonCapability(capability)) return null;
  return SHARED_SKILL_TRIGGER_REFUSAL;
}

export const AGENT_ONLY = { error: "capability_required", message: "this endpoint is for the agent self-API" };
export const WINDOW_ERROR = "tailTurns and beforeSeq must be positive integers, sinceSeq a non-negative one";

export function badRequest(res: ApiCtx["res"], message: string): void {
  return sendJson(res, 400, { error: "bad_request", message });
}

export function found(res: ApiCtx["res"], value: unknown): void {
  return value ? sendJson(res, 200, value) : sendJson(res, 404, { error: "not_found" });
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
  handle: (ctx: ApiCtx, id: string) => Promise<void>,
): (ctx: ApiCtx) => Promise<void> {
  return async (ctx) => {
    const id = ctx.url.searchParams.get(name);
    return id ? handle(ctx, id) : badRequest(ctx.res, `${name} required`);
  };
}

export function withBodyPrincipal(
  handle: (ctx: ApiCtx, principalId: string) => Promise<void>,
): (ctx: ApiCtx) => Promise<void> {
  return async (ctx) => {
    const principalId = bodyPrincipal(ctx);
    return principalId ? handle(ctx, principalId) : badRequest(ctx.res, "principalId required");
  };
}
