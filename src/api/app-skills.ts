import { type ScopeId, parseScopeId, scopeId, type Principal } from "../types.ts";
import type { SkillManifest } from "../skills/skill-store.ts";
import type { SkillPack, SkillPackStore } from "../skills/skill-pack-store.ts";
import type { SkillPackFetcher } from "../skills/pack-fetcher.ts";
import { planIngest, importPack, collectSharedBundle, type ImportResult } from "../skills/ingest.ts";
import { computeBundleHash } from "../skills/skill-bundle-store.ts";
import { persistedSkillRecordPaths, SKILL_MATERIALIZATION_LOCK } from "../skills/skill-collision.ts";
import { triggerBlocksSharedSkill } from "./artifact-share.ts";

import type { App, AppDeps } from "./app-types.ts";
import { parseRef } from "../acl/resource-ref.ts";
import { principalEntitledToScope } from "../resolution/context-filter.ts";
import type { AppHelpers } from "./app-helpers.ts";
import { tenant } from "../tenant.ts";

export async function skillVisibilityContext(
  deps: AppDeps,
  h: AppHelpers,
  principalId: string,
  homes: readonly ScopeId[],
) {
  const actor = deps.identity.classify(principalId);
  const sharedHomes = [
    ...new Set(
      homes.filter((sid) => {
        const k = parseScopeId(sid).kind;
        return k === "channel" || k === "group";
      }),
    ),
  ];
  const accessibleScopes = new Set(await h.currentResourceScopesForViewer(principalId));
  const member = sharedHomes.map((sid) => (accessibleScopes.has(sid) ? sid : null));
  const shared = member.filter((sid): sid is ScopeId => sid !== null);
  const teams = (actor.teamIds ?? []).map((t) => scopeId("team", t));
  const ordered = [...new Set([scopeId("personal", principalId), ...shared, ...teams, tenant().orgScope])];
  const entitled = (p: Principal, label: ScopeId, sess: ScopeId, org: ScopeId) =>
    principalEntitledToScope(p, label, sess, org) || accessibleScopes.has(label);
  const granted = (
    await deps.acl
      .sharedOfKindForAudience("skill", [actor], scopeId("personal", principalId), tenant().orgScope, entitled)
      .catch(() => [])
  ).map((g) => ({ id: parseRef(g.ref).id, ownerScopeId: g.ownerScopeId }));
  return { ordered, granted };
}

function requireRegistry(deps: AppDeps): { packs: SkillPackStore; fetcher: SkillPackFetcher } {
  if (!deps.skillPacks || !deps.skillFetcher) throw new Error("skill registry not configured");
  return { packs: deps.skillPacks, fetcher: deps.skillFetcher };
}

async function requirePack(deps: AppDeps, id: string) {
  const registry = requireRegistry(deps);
  const pack = await registry.packs.get(id);
  if (!pack) throw new Error(`unknown skill pack: ${id}`);
  return { ...registry, pack };
}

function recordImportError(packs: SkillPackStore, pack: SkillPack, e: unknown): Promise<unknown> {
  return packs.recordImport(pack.id, {
    at: Date.now(),
    commit: pack.ref,
    status: "error",
    error: e instanceof Error ? e.message : String(e),
  });
}

async function planPack(deps: AppDeps, repo: Parameters<typeof planIngest>[0], pack: SkillPack) {
  const nativeNames = await nativeNamesFor(deps, pack.id, pack.targetScopeId);
  return planIngest(repo, { ...(pack.config ? { config: pack.config } : {}), nativeNames });
}

function groupBy<K, V>(entries: ReadonlyArray<readonly [K, V]>): Map<K, V[]> {
  return new Map([...Map.groupBy(entries, ([key]) => key)].map(([key, group]) => [key, group.map(([, v]) => v)]));
}

async function nativeNamesFor(deps: AppDeps, packId: string, scope: ScopeId): Promise<Set<string>> {
  const all = await deps.skills.listInScopes([scope]);
  return new Set(all.filter((s) => s.status !== "archived" && s.pack?.packId !== packId).map((s) => s.manifest.name));
}

async function importedPackSkills(deps: AppDeps, packId: string): Promise<Array<[ScopeId, string]>> {
  return (await deps.skills.list()).flatMap((s) =>
    s.status === "published" && s.pack?.packId === packId
      ? [[s.scopeId, s.pack.upstreamName] as [ScopeId, string]]
      : [],
  );
}

async function buildClaimedPaths(deps: AppDeps, exceptPackId: string, scopeId: ScopeId): Promise<Map<string, string>> {
  const claimed = new Map<string, string>();
  for (const s of await deps.skills.listInScopes([scopeId])) {
    if (s.status !== "published" || s.pack?.packId === exceptPackId) continue;
    for (const p of persistedSkillRecordPaths(s.manifest.name, s.manifest.files)) claimed.set(p, s.createdBy);
  }
  return claimed;
}

async function buildClaimedBundlePaths(deps: AppDeps): Promise<Map<string, string>> {
  const claimed = new Map<string, string>();
  for (const skill of await deps.skills.list()) {
    if (skill.status !== "published") continue;
    for (const path of persistedSkillRecordPaths(skill.manifest.name, skill.manifest.files)) {
      claimed.set(path, `skill "${skill.manifest.name}" in ${skill.scopeId}`);
    }
  }
  return claimed;
}

async function archiveRemoved(deps: AppDeps, packId: string, scopeId: ScopeId, kept: string[]): Promise<string[]> {
  const keptSet = new Set(kept);
  const archived: string[] = [];
  for (const s of await deps.skills.listInScopes([scopeId])) {
    if (s.pack?.packId !== packId || s.status === "archived") continue;
    const upstream = s.pack?.upstreamName;
    if (upstream && !keptSet.has(upstream)) {
      await deps.skills.archive(s.id);
      archived.push(s.manifest.name);
    }
  }
  return archived;
}

interface ReconcileTarget {
  scopeId: ScopeId;
  selected: "all" | string[];
}

function skillPackSourceIdentity(pack: SkillPack): string {
  return JSON.stringify([
    pack.url,
    pack.ref,
    pack.syncMode,
    pack.trustTier,
    pack.config ?? null,
    pack.targetScopeId,
    pack.subset,
    pack.authCredentialSlug ?? null,
    pack.lastImport ?? null,
  ]);
}

async function reconcilePack(deps: AppDeps, id: string, targets: ReconcileTarget[]): Promise<ImportResult> {
  const { packs, fetcher, pack } = await requirePack(deps, id);
  let repo: Awaited<ReturnType<SkillPackFetcher["fetch"]>>;
  try {
    repo = await fetcher.fetch(pack);
  } catch (e) {
    await recordImportError(packs, pack, e);
    throw e;
  }
  const applyFetched = async (): Promise<ImportResult> => {
    const current = await packs.get(id);
    if (!current) throw new Error(`unknown skill pack: ${id}`);
    if (skillPackSourceIdentity(current) !== skillPackSourceIdentity(pack)) {
      throw new Error(`skill pack changed while fetching: ${id}`);
    }
    try {
      const bundleFiles = collectSharedBundle(repo, pack.config);
      const canonPlan = await planPack(deps, repo, pack);
      const imported: string[] = [];
      const updated: string[] = [];
      const skipped: string[] = [];
      const archived: string[] = [];
      for (const target of targets) {
        const nativeNames = await nativeNamesFor(deps, id, target.scopeId);
        const claimedPaths = await buildClaimedPaths(deps, id, target.scopeId);
        const claimedBundlePaths = await buildClaimedBundlePaths(deps);
        const { kept, ...base } = await importPack(repo, deps.skills, {
          pack,
          selected: target.selected,
          targetScopeId: target.scopeId,
          nativeNames,
          claimedPaths,
          claimedBundlePaths,
          bundleFiles,
        });
        imported.push(...base.imported);
        updated.push(...base.updated);
        skipped.push(...base.skipped);
        archived.push(...(await archiveRemoved(deps, id, target.scopeId, kept)));
      }
      if (deps.skillBundles) {
        await deps.skillBundles.put({
          packId: id,
          commit: repo.commit,
          files: bundleFiles,
          hash: computeBundleHash(bundleFiles),
        });
      }
      const result: ImportResult = { imported, updated, skipped, archived, counts: canonPlan.counts };
      await packs.recordImport(id, {
        at: Date.now(),
        commit: repo.commit,
        status: "ok",
        counts: {
          ...canonPlan.counts,
          imported: imported.length,
          updated: updated.length,
          skipped: skipped.length,
          archived: archived.length,
        },
      });
      await packs.update(id, { updateAvailable: false, available: canonPlan.counts.eligible });
      return result;
    } catch (e) {
      await recordImportError(packs, pack, e);
      throw e;
    }
  };
  return deps.advisoryLock.withLock(SKILL_MATERIALIZATION_LOCK, applyFetched);
}

export function createSkillMethods(deps: AppDeps, h: AppHelpers) {
  return {
    listSkills: () => deps.skills.list(),
    getSkill: (id) => deps.skills.get(id),
    archiveSkill: (id) => deps.skills.archive(id),
    async listVisibleSkills(principalId) {
      const { ordered, granted } = await skillVisibilityContext(
        deps,
        h,
        principalId,
        (await deps.skills.list()).map((s) => s.scopeId),
      );
      return deps.skills.visibleFor(ordered, granted);
    },
    canManageSkill: (skill, principalId) => h.canManageSkill(skill, principalId),
    async updateOwnedSkill(id, principalId, patch, opts) {
      const skill = await deps.skills.get(id);
      if (!skill || !(await h.canManageSkill(skill, principalId))) return null;
      if (triggerBlocksSharedSkill(skill.scopeId, opts?.liveActor === true)) return "trigger_blocked";
      if (skill.status === "archived") return null;
      const manifest = {
        ...skill.manifest,
        description: patch.description ?? skill.manifest.description,
        body: patch.body ?? skill.manifest.body,
      };
      const updated = await deps.skills.update(id, manifest);
      const live = await h.republishIfShared(updated, principalId);
      h.audit(principalId, "skill_update", id, skill.scopeId);
      return live;
    },
    async restoreOwnedSkill(id, principalId) {
      const skill = await deps.skills.get(id);
      if (!skill || skill.status !== "archived" || !(await h.canManageSkill(skill, principalId))) return null;
      await deps.skills.review(id, principalId, skill.manifest.requiredCapabilities);
      const restored = await deps.skills.publish(id);
      h.audit(principalId, "skill_restore", id, skill.scopeId);
      return restored;
    },
    listSkillPacks: () => (deps.skillPacks ? deps.skillPacks.list() : Promise.resolve([])),
    getSkillPack: (id) => (deps.skillPacks ? deps.skillPacks.get(id) : Promise.resolve(null)),
    async registerSkillPack(input) {
      const { packs, fetcher } = requireRegistry(deps);
      const pack = await packs.create(input);
      try {
        const plan = await planPack(deps, await fetcher.fetch(pack), pack);
        return await packs.update(pack.id, { available: plan.counts.eligible });
      } catch (e) {
        await recordImportError(packs, pack, e);
        return (await packs.get(pack.id)) ?? pack;
      }
    },
    async updateSkillPack(id, patch) {
      const { packs } = requireRegistry(deps);
      return deps.advisoryLock.withLock(SKILL_MATERIALIZATION_LOCK, () => packs.update(id, patch));
    },
    async skillPackCatalog(id) {
      const { fetcher, pack } = await requirePack(deps, id);
      const repo = await fetcher.fetch(pack);
      const plan = await planPack(deps, repo, pack);
      const bundlePaths = collectSharedBundle(repo, pack.config).map((file) => file.path);
      const importedScopesByUpstream = groupBy(
        (await importedPackSkills(deps, id)).map(([scope, upstreamName]) => [upstreamName, scope] as const),
      );
      return {
        ...plan,
        bundlePaths,
        candidates: plan.candidates.map((c) => ({
          ...c,
          importedScopes: importedScopesByUpstream.get(c.upstreamName) ?? [],
        })),
      };
    },
    async importSkillPack(id, selected, scopeIds) {
      const { pack } = await requirePack(deps, id);
      const scopes = scopeIds && scopeIds.length ? scopeIds : [pack.targetScopeId];
      return reconcilePack(
        deps,
        id,
        scopes.map((scopeId) => ({ scopeId, selected })),
      );
    },
    async syncSkillPack(id) {
      const { pack } = await requirePack(deps, id);
      const targets = [...groupBy(await importedPackSkills(deps, id))].map(([scopeId, selected]) => ({
        scopeId,
        selected,
      }));
      if (!targets.length) targets.push({ scopeId: pack.targetScopeId, selected: [] });
      return reconcilePack(deps, id, targets);
    },
    async removeSkillPack(id) {
      const { packs } = requireRegistry(deps);
      return deps.advisoryLock.withLock(SKILL_MATERIALIZATION_LOCK, async () => {
        const mine = (await deps.skills.list()).filter((s) => s.pack?.packId === id);
        for (const s of mine) await deps.skills.delete(s.id);
        await deps.skillBundles?.delete(id);
        await packs.remove(id);
        return { removed: mine.length };
      });
    },
    async createOwnedSkill(input) {
      const name = input.name.trim();
      const description = input.description.trim();
      const body = input.body.trim();
      if (!name || !description || !body) throw new Error("skill requires a non-empty name, description, and body");
      const homeScope = input.homeScope ?? scopeId("personal", input.principalId);
      const homeKind = parseScopeId(homeScope).kind;
      if (homeKind !== "personal" && homeKind !== "channel" && homeKind !== "group") {
        throw new Error(
          "a skill cannot be created directly in an org or team scope — promote a published skill instead",
        );
      }
      const existing = (await deps.skills.listInScopes([homeScope])).find((s) => s.manifest.name === name);
      if (existing && existing.status !== "archived") return null;
      if (existing) await deps.skills.delete(existing.id);
      const manifest: SkillManifest = {
        name,
        description,
        requiredCapabilities: input.requiredCapabilities ?? [],
        body,
      };
      const skill = await deps.skills.create({ scopeId: homeScope, manifest, createdBy: input.principalId });
      await deps.skills.review(skill.id, "system:skill-authoring", manifest.requiredCapabilities);
      const published = await deps.skills.publish(skill.id);
      h.audit(input.principalId, "skill_create", skill.id, homeScope);
      return published;
    },
    async deleteOwnedSkill({ principalId, id, liveActor }) {
      const skill = await deps.skills.get(id);
      if (!skill) return "missing";
      if (!(await h.canManageSkill(skill, principalId))) return "forbidden";
      if (triggerBlocksSharedSkill(skill.scopeId, liveActor === true)) return "trigger_blocked";
      await deps.skills.archive(id);
      h.audit(principalId, "skill_archive", id, skill.scopeId);
      return "deleted";
    },
  } satisfies Partial<App>;
}
