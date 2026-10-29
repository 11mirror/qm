import { isDeepStrictEqual } from "node:util";
import { isCronRuntime } from "../../../cron/runtime.ts";
import { type Destination } from "../../../types.ts";
import { publicUrlOf } from "../../../deploy/deploy-store.ts";
import { refusal } from "../../http.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "../route.ts";
import { notifyOwnerOfCronEdit } from "../../../triggers/edit-notice.ts";
import { ADMIN_CRON_FIELDS, badRequest, pick, requireScopedResource, scopedAdmin } from "./common.ts";

const CRON_FIELDS = [...ADMIN_CRON_FIELDS, "runtime", "unattendedGrants", "destination"] as const;

function isAdminCronDestination(v: unknown): v is Destination {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  const keys = Object.keys(d);
  if (d.type !== "principal" && d.type !== "slack") return false;
  if (typeof d.target !== "string" || d.target.trim() === "") return false;
  if (d.audienceScopeId !== undefined && typeof d.audienceScopeId !== "string") return false;
  if (d.onBehalfOf !== undefined && typeof d.onBehalfOf !== "string") return false;
  return keys.every((k) => k === "type" || k === "target" || k === "audienceScopeId" || k === "onBehalfOf");
}

export async function listAdminArtifacts(ctx: ApiCtx): Promise<RouteResult> {
  const { app, pathname } = ctx;
  const resource = pathname.slice("/v1/admin/".length);
  const authz = await scopedAdmin(ctx, resource);
  const { scope, orgWide } = authz;
  if (resource === "crons") {
    const crons = (await app.listCrons())
      .filter((c) => orgWide || c.ownerScopeId === scope)
      .map((c) => pick(c, CRON_FIELDS));
    return ok({ scopeId: scope, crons });
  }
  if (resource === "deployments") {
    const deployments = (await app.listDeployments())
      .filter((d) => orgWide || d.ownerScopeId === scope)
      .map((d) => ({
        id: d.id,
        ownerScopeId: d.ownerScopeId,
        name: d.displayName || d.name,
        status: d.status,
        currentVersion: d.currentVersion,
        versions: d.versions.length,
        createdBy: d.createdBy,
        createdAt: d.versions[0]?.createdAt,
        lastAccessAt: d.lastAccessAt,
        publicUrl: publicUrlOf(d.endpoint),
      }));
    return ok({ scopeId: scope, deployments });
  }
  const packsById = new Map((await app.listSkillPacks()).map((p) => [p.id, p]));
  const skills = (await app.listSkills())
    .filter((s) => orgWide || s.scopeId === scope)
    .map((s) => {
      const provenancePack = s.pack ? packsById.get(s.pack.packId) : undefined;
      return {
        id: s.id,
        ownerScopeId: s.scopeId,
        name: s.manifest.name,
        description: s.manifest.description,
        status: s.status,
        version: s.version,
        createdBy: s.createdBy,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastUsedAt: s.lastUsedAt,
        ...(provenancePack ? { pack: { id: provenancePack.id, url: provenancePack.url } } : {}),
      };
    });
  return ok({ scopeId: scope, skills });
}

export async function putAdminCronRuntime(ctx: ApiCtx): Promise<RouteResult> {
  const { app, params, body } = ctx;
  const id = params.id!;
  const scoped = await requireScopedResource(ctx, () => app.getCron(id), "ownerScopeId", "cron");
  if (
    typeof body !== "object" ||
    body === null ||
    !("runtime" in body) ||
    Object.keys(body).some((key) => key !== "runtime") ||
    body.runtime === undefined ||
    !isCronRuntime(body.runtime)
  )
    throw badRequest("runtime is required; use null to inherit");
  try {
    const updated = await app.setCronRuntime(id, body.runtime);
    scoped.audit("cron.runtime.update", id, scoped.record.ownerScopeId);
    return ok({ cron: updated ? { id: updated.id, runtime: updated.runtime } : null });
  } catch (error) {
    throw refusal(400, "bad_request", error);
  }
}

export async function putAdminCronDestination(ctx: ApiCtx): Promise<RouteResult> {
  const { app, params, body } = ctx;
  const id = params.id!;
  const scoped = await requireScopedResource(ctx, () => app.getCron(id), "ownerScopeId", "cron");
  const { actor, record: cron } = scoped;
  if (typeof body !== "object" || body === null || !("destination" in body))
    throw badRequest("destination is required; use null to clear");
  if ((cron.unattendedGrants?.length ?? 0) > 0)
    return reply(409, {
      error: "conflict",
      message: "this cron carries unattended admin read grants, so only its owner can change where it delivers",
    });
  const destination = (body as { destination: unknown }).destination;
  if (destination !== null && !isAdminCronDestination(destination))
    throw badRequest("destination must be a principal or slack destination with a target");
  const next = destination === null ? undefined : destination;
  if (isDeepStrictEqual(cron.destination, next)) return ok({ cron: { id: cron.id, destination: cron.destination } });
  const updated = await app.setCronDestination(id, next);
  await notifyOwnerOfCronEdit(app, { cron, editorId: actor.id, changeSummary: ["destination"] });
  scoped.audit("cron.destination.update", id, cron.ownerScopeId);
  return ok({ cron: updated ? { id: updated.id, destination: updated.destination } : null });
}

export async function getAdminSkill(ctx: ApiCtx): Promise<RouteResult> {
  const { app, params } = ctx;
  const id = params.id!;
  const scoped = await requireScopedResource(ctx, () => app.getSkill(id), "scopeId", "skill", "fallback");
  const { record: skill } = scoped;
  const provenance = skill.pack;
  const provenancePack = provenance ? ((await app.getSkillPack(provenance.packId)) ?? undefined) : undefined;
  scoped.audit("skill.read", id, skill.scopeId);
  return ok({
    id: skill.id,
    ownerScopeId: skill.scopeId,
    name: skill.manifest.name,
    description: skill.manifest.description,
    body: skill.manifest.body,
    files: (skill.manifest.files ?? []).map((f) => ({ path: f.path, executable: f.executable === true })),
    requiredCapabilities: skill.manifest.requiredCapabilities,
    grantedCapabilities: skill.grantedCapabilities,
    approvals: skill.approvals,
    status: skill.status,
    version: skill.version,
    createdBy: skill.createdBy,
    ...(provenancePack ? { pack: { id: provenancePack.id, url: provenancePack.url } } : {}),
  });
}

export async function archiveAdminSkill(ctx: ApiCtx): Promise<RouteResult> {
  const { app, params } = ctx;
  const id = params.id!;
  const scoped = await requireScopedResource(ctx, () => app.getSkill(id), "scopeId", "skill");
  const { record: skill } = scoped;
  await app.archiveSkill(id);
  scoped.audit("skill.archive", id, skill.scopeId);
  return ok({ ok: true });
}
