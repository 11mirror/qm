import { errMessage } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import { type ApiCtx } from "../route.ts";
import { orgAdmin } from "./common.ts";

export async function manageSandboxResources(ctx: ApiCtx): Promise<void> {
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  const actorId = authz.actor.id;
  const resources = ctx.deps.sandboxResources;
  if (!resources) return sendJson(ctx.res, 404, { error: "not_supported" });
  const scopeId = ctx.params.scopeId!;
  const input = (ctx.body ?? {}) as Record<string, unknown>;
  try {
    if (ctx.req.method === "GET") return sendJson(ctx.res, 200, await resources.list(actorId, scopeId));
    if (input.action === "retire") {
      if (typeof input.sandboxId !== "string") throw new Error("retire requires sandboxId");
      const record = await resources.access(actorId, input.sandboxId);
      if (record.ownerScopeId !== scopeId) throw new Error("sandbox belongs to another scope");
      await resources.retire(actorId, input.sandboxId);
      authz.audit("sandbox.retire", input.sandboxId, scopeId);
      return sendJson(ctx.res, 200, { retired: input.sandboxId });
    }
    if (input.action === "default") {
      if (input.sandboxId !== null && typeof input.sandboxId !== "string")
        throw new Error("sandboxId must be an ID or null");
      await resources.setDefault(actorId, scopeId, input.sandboxId);
      authz.audit("sandbox.default", String(input.sandboxId), scopeId);
      return sendJson(ctx.res, 200, { defaultSandboxId: input.sandboxId });
    }
    if (input.action !== "create" || typeof input.backend !== "string")
      throw new Error("choose create with backend, or default with sandboxId");
    const name = typeof input.name === "string" ? input.name : undefined;
    const record = await resources.create(actorId, scopeId, input.backend, name);
    authz.audit("sandbox.create", record.id, scopeId);
    return sendJson(ctx.res, 201, record);
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "sandbox_request_failed", message: errMessage(error) });
  }
}
