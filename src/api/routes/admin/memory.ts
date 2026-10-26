import { sendJson } from "../../http.ts";
import { renderFacts } from "../../../memory/facts.ts";
import { memoryFacts, parseEdits, parseFacts, parseIds } from "../surface.ts";
import { type ApiCtx } from "../route.ts";
import { badRequest, discoverScopes, notFound, orgAdmin, scopedAdmin } from "./common.ts";

export async function listMemoryScopes(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  if (!deps.memory) return notFound(res);
  authz.audit("memory.scopes.read", "memory");
  const labels = await discoverScopes(app, deps);
  const meta = (await deps.memory.metadata?.()) ?? null;
  const scopes = await Promise.all(
    [...labels].map(async ([id, label]) => {
      let bytes: number;
      let updatedAt: number | undefined;
      if (meta) {
        const m = meta.get(id);
        bytes = m?.bytes ?? 0;
        updatedAt = m?.updatedAt;
      } else {
        const content = await deps.memory!.read(id);
        bytes = Buffer.byteLength(content);
      }
      return {
        scopeId: id,
        ...(label ? { label } : {}),
        hasMemory: bytes > 0,
        bytes,
        ...(updatedAt ? { updatedAt } : {}),
      };
    }),
  );
  scopes.sort(
    (a, b) =>
      Number(b.hasMemory) - Number(a.hasMemory) ||
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      a.scopeId.localeCompare(b.scopeId),
  );
  return sendJson(res, 200, { scopeId: authz.scope, scopes });
}

export async function adminMemory(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, method } = ctx;
  const authz = await scopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  const memory = deps.memory;
  if (!memory) return notFound(res);
  if (method === "POST") {
    const facts = parseFacts(body);
    if (typeof facts === "string") return badRequest(res, facts);
    await memory.capture(scope, facts, Date.now(), actor.id, { mode: "explicit" });
  } else if (method === "PATCH") {
    const edits = parseEdits(body);
    if (typeof edits === "string") return badRequest(res, edits);
    await memory.edit?.(scope, edits, actor.id);
  } else if (method === "DELETE") {
    const ids = parseIds(body);
    if (typeof ids === "string") return badRequest(res, ids);
    await memory.delete?.(scope, ids, actor.id);
  }
  authz.audit(method === "GET" ? "memory.read" : "memory.update", "memory");
  const facts = await memoryFacts(memory, scope);
  return sendJson(res, 200, {
    scopeId: scope,
    content: memory.facts ? renderFacts(facts) : await memory.read(scope),
    facts,
  });
}
