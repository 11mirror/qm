import { fail } from "../http.ts";
import { type ApiCtx, ok, type Route, type RouteResult, withAdmin } from "./route.ts";
import { audit, authorizeAdmin } from "./shared.ts";
import type { NewSkillPack, SkillPack } from "../../skills/skill-pack-store.ts";
import type { PackConfig } from "../../skills/normalize.ts";
import { parseScopeId, type ScopeId } from "../../types.ts";
import { tenant } from "../../tenant.ts";

function asSubset(v: unknown): "all" | string[] | undefined {
  if (v === "all" || v === undefined) return "all";
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}

function asScopeIds(v: unknown): ScopeId[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: ScopeId[] = [];
  for (const x of v) {
    if (typeof x !== "string") return undefined;
    const { kind, ref } = parseScopeId(x);
    if (!kind || !ref) return undefined;
    out.push(x);
  }
  return [...new Set(out)];
}

function asConfig(v: unknown): PackConfig | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const cfg: PackConfig = {};
  if (Array.isArray(o.skillGlobs)) cfg.skillGlobs = o.skillGlobs.filter((x): x is string => typeof x === "string");
  if (Array.isArray(o.exclude)) cfg.exclude = o.exclude.filter((x): x is string => typeof x === "string");
  if (o.fieldOverrides && typeof o.fieldOverrides === "object")
    cfg.fieldOverrides = o.fieldOverrides as Record<string, string>;
  return cfg;
}

function badRequest(ctx: ApiCtx, message: string): null {
  throw fail(400, "bad_request", message);
}

function packRoute(
  action: string,
  run: (ctx: ApiCtx, actorId: string) => Promise<{ body: unknown; resource?: string; scopeLabel?: string } | null>,
): (ctx: ApiCtx) => Promise<RouteResult> {
  return async (ctx) => {
    const actor = await authorizeAdmin(ctx, tenant().orgScope);
    const out = await run(ctx, actor.id);
    if (!out) return;
    audit(ctx.deps, {
      principalId: actor.id,
      action,
      resource: out.resource ?? ctx.params.id!,
      scopeLabel: out.scopeLabel ?? tenant().orgScope,
    });
    return ok(out.body);
  };
}

const listPacks = packRoute("skill_packs.read", async ({ app }) => {
  const packs = await app.listSkillPacks();
  const importedByPack = new Map<string, Set<string>>();
  for (const sk of await app.listSkills()) {
    if (sk.status === "published" && sk.pack) {
      const set = importedByPack.get(sk.pack.packId) ?? new Set<string>();
      set.add(sk.pack.upstreamName);
      importedByPack.set(sk.pack.packId, set);
    }
  }
  const decorated = packs.map((p) => ({ ...p, importedCount: importedByPack.get(p.id)?.size ?? 0 }));
  return { body: { packs: decorated }, resource: "skill_packs" };
});

const registerPack = packRoute("skill_pack.register", async (ctx, actorId) => {
  const b = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof b.url !== "string" || !b.url.trim()) return badRequest(ctx, "url is required");
  const subset = asSubset(b.subset);
  if (subset === undefined) return badRequest(ctx, "subset must be 'all' or string[]");
  const config = asConfig(b.config);
  const input: NewSkillPack = {
    kind: "git",
    url: b.url.trim(),
    ref: typeof b.ref === "string" ? b.ref.trim() : "",
    syncMode: "pinned",
    trustTier: b.trustTier === "internal" ? "internal" : "third-party",
    targetScopeId: tenant().orgScope,
    subset,
    createdBy: actorId,
    ...(config ? { config } : {}),
    ...(typeof b.authCredentialSlug === "string" && b.authCredentialSlug
      ? { authCredentialSlug: b.authCredentialSlug }
      : {}),
  };
  const pack = await ctx.app.registerSkillPack(input);
  return { body: { pack }, resource: pack.id, scopeLabel: pack.targetScopeId };
});

const packCatalog = packRoute("skill_pack.catalog", async ({ app, params }) => ({
  body: await app.skillPackCatalog(params.id!),
}));

const importPack = packRoute("skill_pack.import", async (ctx) => {
  const body = (ctx.body as Record<string, unknown> | null) ?? {};
  const subset = asSubset(body.selected);
  if (subset === undefined) return badRequest(ctx, "selected must be 'all' or string[]");
  const scopeIds = asScopeIds(body.scopeIds);
  if (scopeIds === undefined) return badRequest(ctx, "scopeIds must be an array of 'kind:ref' scope ids");
  const result = await ctx.app.importSkillPack(ctx.params.id!, subset, scopeIds);
  return { body: result, ...(scopeIds.length ? { scopeLabel: scopeIds.join(",") } : {}) };
});

const syncPack = packRoute("skill_pack.sync", async ({ app, params }) => ({
  body: await app.syncSkillPack(params.id!),
}));

const patchPack = packRoute("skill_pack.update", async (ctx) => {
  const b = (ctx.body ?? {}) as Record<string, unknown>;
  const patch: Partial<Omit<SkillPack, "id" | "createdAt">> = {};
  if (typeof b.ref === "string" && b.ref.trim()) patch.ref = b.ref.trim();
  if (typeof b.url === "string" && b.url.trim()) patch.url = b.url.trim();
  if (b.trustTier === "internal" || b.trustTier === "third-party") patch.trustTier = b.trustTier;
  if (b.syncMode === "pinned" || b.syncMode === "tracked") patch.syncMode = b.syncMode;
  if (b.subset !== undefined) {
    const subset = asSubset(b.subset);
    if (subset === undefined) return badRequest(ctx, "subset must be 'all' or string[]");
    patch.subset = subset;
  }
  if (b.config !== undefined) patch.config = asConfig(b.config);
  const pack = await ctx.app.updateSkillPack(ctx.params.id!, patch);
  return { body: { pack }, resource: pack.id, scopeLabel: pack.targetScopeId };
});

const removePack = packRoute("skill_pack.remove", async ({ app, params }) => ({
  body: await app.removeSkillPack(params.id!),
}));

export const skillPackRoutes: ReadonlyArray<Route<ApiCtx>> = withAdmin([
  { method: "POST", path: "/v1/admin/skill-packs", auth: "either", handle: registerPack },
  { method: "GET", path: "/v1/admin/skill-packs", auth: "either", handle: listPacks },
  { method: "GET", path: "/v1/admin/skill-packs/:id/catalog", auth: "either", handle: packCatalog },
  { method: "POST", path: "/v1/admin/skill-packs/:id/import", auth: "either", handle: importPack },
  { method: "POST", path: "/v1/admin/skill-packs/:id/sync", auth: "either", handle: syncPack },
  { method: "PATCH", path: "/v1/admin/skill-packs/:id", auth: "either", handle: patchPack },
  { method: "DELETE", path: "/v1/admin/skill-packs/:id", auth: "either", handle: removePack },
]);
