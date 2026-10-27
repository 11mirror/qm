import { orgAdmin } from "./common.ts";
import { type ApiCtx, ok, type RouteResult } from "../route.ts";
import { SECURITY_FLAGGED, SECURITY_TOOL_RESULT_QUARANTINE } from "../../../audit/audit-log.ts";

const MAX_FLAGS = 200;
const FLAG_ACTIONS = [SECURITY_FLAGGED, SECURITY_TOOL_RESULT_QUARANTINE];

export async function listSecurityFlags(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  const requested = Number(ctx.url.searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_FLAGS) : 50;
  const events = (await ctx.deps.auditLog?.tail({ limit, action: FLAG_ACTIONS })) ?? [];
  const flags = events.map((event) => ({
    at: event.at,
    principal: event.principalId,
    scope: event.scopeLabel,
    surface: event.resource,
    detail: event.detail,
  }));
  authz.audit("security_posture.flags.read", "security-flags");
  return ok({ flags });
}
