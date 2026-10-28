import { disclosedMemory } from "../../memory/disclosure.ts";
import type { MemoryEdit, MemoryService } from "../../memory/memory-service.ts";
import type { ScopeId } from "../../types.ts";
import { parseScopeId, scopeId as makeScopeId } from "../../types.ts";
import type { Skill, SkillResolution } from "../../skills/skill-store.ts";
import { swallowAs } from "../../util/errors.ts";
import { renderAgentApis } from "../agent-api-catalog.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../../auth/capability-token.ts";
import { fail } from "../http.ts";
import { audit, isObj } from "./shared.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "./route.ts";
import { livePersonCapability, SHARED_SKILL_TRIGGER_REFUSAL } from "../artifact-share.ts";
import { withQuery, badRequest, bodyField, bodyPrincipal, sharedSkillCreateBlock } from "./surface-shared.ts";

export async function memoryFacts(memory: MemoryService, scope: ScopeId) {
  return ((await memory.facts?.(scope)) ?? []).map(({ id, text, createdAt, updatedAt }) => ({
    id,
    text,
    createdAt,
    updatedAt,
  }));
}

export function parseEdits(body: unknown): MemoryEdit[] | string {
  const facts = (isObj(body) ? body : {}).facts;
  if (!Array.isArray(facts) || !facts.length) return "facts (non-empty array of {id, text}) required";
  const edits = facts.flatMap((fact): MemoryEdit[] =>
    isObj(fact) && typeof fact.id === "string" && typeof fact.text === "string" && fact.text.trim()
      ? [{ id: fact.id, text: fact.text }]
      : [],
  );
  return edits.length === facts.length ? edits : "every fact needs a string id and non-empty text";
}

export function parseIds(body: unknown): string[] | string {
  const ids = (isObj(body) ? body : {}).ids;
  return Array.isArray(ids) && ids.length && ids.every((id) => typeof id === "string" && id.trim())
    ? (ids as string[])
    : "ids (non-empty string array) required";
}

export async function selfMemory(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, url, method, body } = ctx;
  const principalId =
    method === "GET" ? url.searchParams.get("principalId") : (body as { principalId?: unknown }).principalId;
  if (typeof principalId !== "string" || !principalId)
    return reply(400, { error: "bad_request", message: "principalId required" });
  if (!deps.memory) return reply(404, { error: "not_found" });
  const scope = makeScopeId("personal", principalId);
  const viewerId = ctx.actor?.p ?? principalId;
  const actor = deps.identity?.classify(viewerId) ?? { id: viewerId, type: "internal" as const };
  const viewerScope = makeScopeId("personal", viewerId);
  const memory = disclosedMemory(deps.memory, {
    actor,
    targetScope: viewerScope,
    nativeScopes: [viewerScope],
    audience: [actor],
    open: true,
    isCurrentSharedScopeMember: (person, target) => ctx.app.isCurrentSharedScopeMember(person, target),
    currentScopeMembers: (target) => ctx.app.currentScopeMembers(target),
  });
  if (method === "PATCH") {
    const edits = parseEdits(body);
    if (typeof edits === "string") return reply(400, { error: "bad_request", message: edits });
    await memory.edit?.(scope, edits, principalId);
  } else if (method === "DELETE") {
    const ids = parseIds(body);
    if (typeof ids === "string") return reply(400, { error: "bad_request", message: ids });
    await memory.delete?.(scope, ids, principalId);
  }
  const action = method === "GET" ? "memory.self.read" : "memory.self.update";
  audit(deps, { principalId, action, resource: "memory", scopeLabel: scope });
  return ok({ scopeId: scope, facts: await memoryFacts(memory, scope) });
}

export async function sessionCapability(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, actor } = ctx;
  if (!actor) return reply(401, { error: "unauthorized", message: "portal identity required" });
  const secret = deps.capabilitySecret ?? ctx.secret;
  if (!secret) return reply(503, { error: "not_configured", message: "capability secret not set" });
  const token = await mintCapabilityToken(
    { actorId: actor.p, scopeId: makeScopeId("personal", actor.p), exp: Date.now() + CAPABILITY_TTL_MS },
    secret,
  );
  return ok({ token });
}

export async function listAgentApis(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, capability } = ctx;
  if (!capability) return reply(401, { error: "unauthorized", message: "agent capability token required" });
  const admin: { isAdmin: boolean; role?: string } = deps.admin
    ? await deps.admin
        .adminStatusOf({ id: capability.actorId, type: "internal" })
        .catch(swallowAs("apis: admin status", { isAdmin: false }))
    : { isAdmin: false };
  audit(deps, {
    principalId: capability.actorId,
    action: "apis.list",
    resource: "apis",
    scopeLabel: capability.scopeId,
  });
  return ok(renderAgentApis(capability, { isAdmin: admin.isAdmin, ...(admin.role ? { role: admin.role } : {}) }));
}

export function parseFacts(body: unknown): string[] | string {
  const b = (isObj(body) ? body : {}) as { facts?: unknown };
  const facts = Array.isArray(b.facts)
    ? b.facts.filter((f): f is string => typeof f === "string" && f.trim() !== "")
    : [];
  if (facts.length === 0) return "facts (non-empty string array) required";
  if (facts.length > 20) return "at most 20 facts per call";
  return facts;
}

export const listSkills = withQuery("principalId", async ({ app, url }, principalId) => {
  const includeShadowed = url.searchParams.get("includeShadowed") === "1";
  const resolved = (await app.listVisibleSkills(principalId)).filter(
    (r): r is SkillResolution & { skill: Skill } => r.skill !== null,
  );
  const archivedChecks = await Promise.all(
    (await app.listSkills())
      .filter((skill) => skill.status === "archived")
      .map(async (skill) => ({ skill, manageable: await app.canManageSkill(skill, principalId) })),
  );
  const archived = archivedChecks.filter((row) => row.manageable).map(({ skill }) => ({ skill, shadowed: [] }));
  const visible = resolved.flatMap((row) => [
    { skill: row.skill, shadowed: row.shadowed },
    ...(includeShadowed ? row.shadowed.map((skill) => ({ skill, shadowed: [] })) : []),
  ]);
  const skills = await Promise.all(
    [...visible, ...archived].map(async (r) => ({
      id: r.skill.id,
      name: r.skill.manifest.name,
      description: r.skill.manifest.description,
      scope: parseScopeId(r.skill.scopeId).kind ?? r.skill.scopeId,
      scopeId: r.skill.scopeId,
      shadowed: r.shadowed.length > 0,
      status: r.skill.status,
      version: r.skill.version,
      source: r.skill.pack ? "pack" : "native",
      pack: r.skill.pack,
      assetCount: r.skill.manifest.files?.length ?? 0,
      requiredCapabilities: r.skill.manifest.requiredCapabilities,
      editable: await app.canManageSkill(r.skill, principalId),
    })),
  );
  return ok({ skills });
});

function skillReader(ctx: ApiCtx, fallback: unknown): string {
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p ?? (typeof fallback === "string" ? fallback : "");
  if (!ctx.capability && !ctx.actor && ctx.secret) throw fail(401, "capability_required");
  if (principalId) return principalId;
  throw badRequest("principalId required");
}

function skillView(skill: Skill) {
  return {
    id: skill.id,
    name: skill.manifest.name,
    description: skill.manifest.description,
    body: skill.manifest.body,
    status: skill.status,
    version: skill.version,
  };
}

export async function getSkillDetail(ctx: ApiCtx): Promise<RouteResult> {
  const { app } = ctx;
  const principalId = skillReader(ctx, ctx.url.searchParams.get("principalId"));
  const skill = await app.getSkill(ctx.params.id!);
  if (
    !skill ||
    (!(await app.canManageSkill(skill, principalId)) &&
      !(await app.listVisibleSkills(principalId)).some((row) => row.skill?.id === skill.id))
  )
    return reply(404, { error: "not_found" });
  return ok({
    skill: {
      ...skillView(skill),
      scope: parseScopeId(skill.scopeId).kind ?? skill.scopeId,
      scopeId: skill.scopeId,
      createdBy: skill.createdBy,
      pack: skill.pack,
      files: (skill.manifest.files ?? []).map((file) => ({ path: file.path, executable: file.executable === true })),
      requiredCapabilities: skill.manifest.requiredCapabilities,
      grantedCapabilities: skill.grantedCapabilities,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
      editable: await app.canManageSkill(skill, principalId),
    },
  });
}

export async function restoreSkill(ctx: ApiCtx): Promise<RouteResult> {
  const principalId = skillReader(ctx, bodyField(ctx, "principalId"));
  const restored = await ctx.app.restoreOwnedSkill(ctx.params.id!, principalId);
  return restored ? ok({ ok: true }) : reply(404, { error: "not_found" });
}

function skillOwner(ctx: ApiCtx): string | null {
  return ctx.capability ? ctx.capability.actorId : bodyPrincipal(ctx);
}

export async function updateSkill(ctx: ApiCtx): Promise<RouteResult> {
  const { app, capability } = ctx;
  const principalId = skillOwner(ctx);
  if (principalId === null) throw badRequest("principalId required");
  const patch: { description?: string; body?: string } = {};
  for (const field of ["description", "body"] as const) {
    const value = bodyField(ctx, field);
    if (value !== undefined && typeof value !== "string") throw badRequest(`${field} must be a string`);
    if (typeof value === "string") patch[field] = value;
  }
  const liveActor = capability ? livePersonCapability(capability) : true;
  const updated = await app.updateOwnedSkill(ctx.params.id!, principalId, patch, { liveActor });
  if (updated === "trigger_blocked") return reply(403, { error: "forbidden", message: SHARED_SKILL_TRIGGER_REFUSAL });
  if (!updated) return reply(404, { error: "not_found", message: "no such skill, or it isn't yours to edit" });
  return ok({ skill: skillView(updated) });
}

export async function deleteSkill(ctx: ApiCtx): Promise<RouteResult> {
  const { app, capability } = ctx;
  const principalId = skillOwner(ctx);
  if (principalId === null) throw badRequest("principalId required");
  const liveActor = capability ? livePersonCapability(capability) : true;
  const outcome = await app.deleteOwnedSkill({ principalId, id: ctx.params.id!, liveActor });
  if (outcome === "missing") return reply(404, { error: "not_found", message: "no such skill" });
  if (outcome === "trigger_blocked") return reply(403, { error: "forbidden", message: SHARED_SKILL_TRIGGER_REFUSAL });
  if (outcome === "forbidden") return reply(403, { error: "forbidden", message: "that skill isn't yours to archive" });
  return ok({ ok: true });
}

export async function createSkill(ctx: ApiCtx): Promise<RouteResult> {
  const { app, capability } = ctx;
  const blocked = sharedSkillCreateBlock(capability);
  if (blocked) return reply(403, { error: "forbidden", message: blocked });
  const principalId = skillOwner(ctx);
  if (principalId === null) throw badRequest("principalId required");
  let homeScope = capability?.scopeId;
  const requestedScope = bodyField(ctx, "scopeId");
  if (!capability && typeof requestedScope === "string" && requestedScope !== makeScopeId("personal", principalId)) {
    if (!(await app.managesScope(principalId, requestedScope as ScopeId)))
      return reply(403, { error: "forbidden", message: "you cannot create a skill in that context" });
    homeScope = requestedScope as ScopeId;
  }
  if (homeScope && (parseScopeId(homeScope).kind === "org" || parseScopeId(homeScope).kind === "team"))
    return reply(403, {
      error: "forbidden",
      message: "a skill cannot be created in an org or team scope — promote a published skill instead",
    });
  const fields = {
    name: bodyField(ctx, "name"),
    description: bodyField(ctx, "description"),
    body: bodyField(ctx, "body"),
  };
  for (const [field, value] of Object.entries(fields))
    if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} required`);
  const created = await app.createOwnedSkill({
    principalId,
    ...(homeScope ? { homeScope } : {}),
    name: fields.name as string,
    description: fields.description as string,
    body: fields.body as string,
  });
  if (!created)
    return reply(409, {
      error: "exists",
      message: "a skill of that name already exists here — edit it instead",
    });
  return reply(201, { skill: skillView(created) });
}
