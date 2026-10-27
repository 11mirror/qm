import { refusal } from "../../http.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "../route.ts";
import { orgAdmin } from "./common.ts";

export async function manageSandboxResources(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  const actorId = authz.actor.id;
  const resources = ctx.deps.sandboxResources;
  if (!resources) return reply(404, { error: "not_supported" });
  const scopeId = ctx.params.scopeId!;
  const input = (ctx.body ?? {}) as Record<string, unknown>;
  try {
    if (ctx.req.method === "GET") return ok(await resources.list(actorId, scopeId));
    if (input.action === "retire") {
      if (typeof input.sandboxId !== "string") throw new Error("retire requires sandboxId");
      const record = await resources.access(actorId, input.sandboxId);
      if (record.ownerScopeId !== scopeId) throw new Error("sandbox belongs to another scope");
      await resources.retire(actorId, input.sandboxId);
      authz.audit("sandbox.retire", input.sandboxId, scopeId);
      return ok({ retired: input.sandboxId });
    }
    if (input.action === "default") {
      if (input.sandboxId !== null && typeof input.sandboxId !== "string")
        throw new Error("sandboxId must be an ID or null");
      await resources.setDefault(actorId, scopeId, input.sandboxId);
      authz.audit("sandbox.default", String(input.sandboxId), scopeId);
      return ok({ defaultSandboxId: input.sandboxId });
    }
    if (input.action !== "create" || typeof input.backend !== "string")
      throw new Error("choose create with backend, or default with sandboxId");
    const name = typeof input.name === "string" ? input.name : undefined;
    const record = await resources.create(actorId, scopeId, input.backend, name);
    authz.audit("sandbox.create", record.id, scopeId);
    return reply(201, record);
  } catch (error) {
    throw refusal(400, "sandbox_request_failed", error);
  }
}
