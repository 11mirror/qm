import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { parseScopeId } from "../types.ts";
import { assertSafeSkillName, isSafeSkillName } from "./skill-name.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";

type SkillStatus = "draft" | "reviewed" | "published" | "archived";

export interface SkillFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface SkillManifest {
  name: string;
  description: string;
  requiredCapabilities: string[];
  body: string;
  files?: SkillFile[];
}

export function safeSkillFilePath(path: string): string {
  const p = path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  const parts = p.split("/").filter(Boolean);
  if (
    !parts.length ||
    path.startsWith("/") ||
    parts.some((part) => part === "." || part === ".." || part.includes("\0"))
  ) {
    throw new Error(`invalid skill file path: ${path}`);
  }
  return parts.join("/");
}

export interface Skill {
  id: string;
  scopeId: ScopeId;
  manifest: SkillManifest;
  status: SkillStatus;
  createdBy: string;
  version: number;
  grantedCapabilities: string[];
  approvals: string[];
  createdAt?: number;
  updatedAt?: number;
  lastUsedAt?: number;
  pack?: { packId: string; commit: string; upstreamName: string };
}

export interface GrantedSkillRef {
  id: string;
  ownerScopeId: ScopeId;
}

export interface SkillResolution {
  skill: Skill | null;
  shadowed: Skill[];
}

export interface SkillStoreOptions {
  databaseUrl: string;
  advisoryLock: AdvisoryLock;
}

const SKILLS: TableSpec = {
  table: "skills",
  key: "id",
  keyIsField: true,
  columns: cols(`scopeId text!, manifest jsonb!, status text!, createdBy text!, version bigint!,
    grantedCapabilities text[]!, approvals text[]!, createdAt bigint, updatedAt bigint,
    lastUsedAt bigint, pack jsonb`),
};

export const SKILLS_MIGRATION = mapToTableMigration("skills/store/0001-typed", SKILLS, {
  dropKeys: ["signature"],
  statements: [
    `CREATE INDEX IF NOT EXISTS skills_scope_id ON skills (scope_id)`,
    `CREATE INDEX IF NOT EXISTS skills_resource_name_idx ON skills ((manifest->>'name'))`,
    `CREATE INDEX IF NOT EXISTS skills_resource_search_gin ON skills USING gin (to_tsvector('simple', coalesce(manifest->>'name', '') || ' ' || coalesce(manifest->>'description', '')))`,
  ],
});

export interface SkillStore {
  create(input: { scopeId: ScopeId; manifest: SkillManifest; createdBy: string; pack?: Skill["pack"] }): Promise<Skill>;
  update(id: string, manifest: SkillManifest): Promise<Skill>;
  withNameLock<T>(scopeId: ScopeId, name: string, fn: () => Promise<T>): Promise<T>;
  get(id: string): Promise<Skill | null>;
  list(): Promise<Skill[]>;
  listInScopes(scopeIds: readonly ScopeId[]): Promise<Skill[]>;
  review(id: string, reviewer: string, grantCapabilities: string[]): Promise<Skill>;
  publish(id: string): Promise<Skill>;
  archive(id: string): Promise<Skill>;
  restore(skill: Skill): Promise<void>;
  delete(id: string): Promise<void>;
  recordUse(id: string, at?: number): Promise<void>;
  resolve(name: string, orderedScopes: ScopeId[]): Promise<SkillResolution>;
  visibleFor(orderedScopes: ScopeId[], granted?: readonly GrantedSkillRef[]): Promise<SkillResolution[]>;
  promote(id: string, targetScopeId: ScopeId): Promise<Skill>;
  move(id: string, toScopeId: ScopeId): Promise<Skill>;
}

function scopeKind(scopeId: ScopeId): string {
  return parseScopeId(scopeId).kind ?? scopeId;
}

export type SkillSummary = Pick<Skill, "id" | "scopeId" | "status"> & { manifest: Pick<SkillManifest, "name"> };

function publishedByScopeAndName<T extends SkillSummary>(all: T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const s of all) {
    if (s.status !== "published") continue;
    const key = `${s.scopeId}\u0000${s.manifest.name}`;
    if (!index.has(key)) index.set(key, s);
  }
  return index;
}

function resolveFromIndex<T extends SkillSummary>(
  index: Map<string, T>,
  name: string,
  orderedScopes: ScopeId[],
): { skill: T | null; shadowed: T[] } {
  if (!isSafeSkillName(name)) return { skill: null, shadowed: [] };
  const published = orderedScopes.map((sc) => index.get(`${sc}\u0000${name}`)).filter((s): s is T => Boolean(s));
  const [skill, ...shadowed] = published;
  return { skill: skill ?? null, shadowed };
}

export function visibleSkillRows<T extends SkillSummary>(
  all: T[],
  orderedScopes: ScopeId[],
  granted?: readonly GrantedSkillRef[],
): Array<{ skill: T; shadowed: T[] }> {
  const index = publishedByScopeAndName(all);
  const inScope = new Set(orderedScopes);
  const names = [
    ...new Set(
      all
        .filter((s) => s.status === "published" && inScope.has(s.scopeId) && isSafeSkillName(s.manifest.name))
        .map((s) => s.manifest.name),
    ),
  ];
  const visible = names
    .map((n) => resolveFromIndex(index, n, orderedScopes))
    .filter((r): r is { skill: T; shadowed: T[] } => r.skill !== null);
  if (granted?.length) {
    const byId = new Map(all.map((skill) => [skill.id, skill]));
    const byName = new Map(visible.map((r) => [r.skill.manifest.name, r]));
    const seen = new Set<string>();
    for (const ref of granted) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      const s = byId.get(ref.id);
      if (!s || s.status !== "published" || s.scopeId !== ref.ownerScopeId || !isSafeSkillName(s.manifest.name))
        continue;
      const existing = byName.get(s.manifest.name);
      if (existing) {
        if (existing.skill.id !== s.id && !existing.shadowed.some((x) => x.id === s.id)) existing.shadowed.push(s);
        continue;
      }
      const r = { skill: s, shadowed: [] as T[] };
      byName.set(s.manifest.name, r);
      visible.push(r);
    }
  }
  return visible;
}

export function createSkillStore(opts: SkillStoreOptions): SkillStore {
  const db = createPgPool(opts.databaseUrl, [SKILLS_MIGRATION]);
  const table = typedTable<Skill>(db, SKILLS);
  const put = (skill: Skill) => table.put(skill.id, skill);
  const listInScopes = async (scopeIds: readonly ScopeId[]): Promise<Skill[]> =>
    scopeIds.length
      ? table.codec.rows(
          await db.q(`SELECT ${table.codec.columns} FROM skills WHERE scope_id = ANY($1::text[]) ORDER BY id`, [
            [...scopeIds],
          ]),
        )
      : [];
  const withNameLock = <T>(scopeId: ScopeId, name: string, fn: () => Promise<T>) =>
    opts.advisoryLock.withLock(`skill-name:${scopeId}:${name}`, fn);
  const load = async (id: string): Promise<Skill> => {
    const s = await table.get(id);
    if (!s) throw new Error(`unknown skill: ${id}`);
    return s;
  };
  const save = async (s: Skill): Promise<Skill> => {
    s.updatedAt = Date.now();
    await put(s);
    return s;
  };

  return {
    withNameLock,
    async create(input) {
      assertSafeSkillName(input.manifest.name);
      const at = Date.now();
      const skill: Skill = {
        id: randomUUID(),
        scopeId: input.scopeId,
        manifest: input.manifest,
        status: "draft",
        createdBy: input.createdBy,
        version: 1,
        grantedCapabilities: [],
        approvals: [],
        createdAt: at,
        updatedAt: at,
        ...(input.pack ? { pack: input.pack } : {}),
      };
      await put(skill);
      return skill;
    },
    async update(id, manifest) {
      assertSafeSkillName(manifest.name);
      const s = await load(id);
      if (manifest.name !== s.manifest.name) throw new Error("skill update cannot rename — create a new skill instead");
      s.manifest = manifest;
      if (scopeKind(s.scopeId) !== "personal") s.status = "draft";
      s.version += 1;
      return save(s);
    },

    get: table.get,
    list: table.all,
    listInScopes,

    async review(id, reviewer, grantCapabilities) {
      const s = await load(id);
      assertSafeSkillName(s.manifest.name);
      s.grantedCapabilities = [...new Set([...s.grantedCapabilities, ...grantCapabilities])];
      if (!s.approvals.includes(reviewer)) s.approvals.push(reviewer);
      s.status = "reviewed";
      return save(s);
    },

    async publish(id) {
      const s = await load(id);
      assertSafeSkillName(s.manifest.name);
      if (s.status === "draft") throw new Error("skill must be reviewed before it is published");
      const missing = s.manifest.requiredCapabilities.filter((c) => !s.grantedCapabilities.includes(c));
      if (missing.length) throw new Error(`skill requires ungranted capabilities: ${missing.join(", ")}`);
      s.status = "published";
      return save(s);
    },

    async archive(id) {
      const existing = await load(id);
      return withNameLock(existing.scopeId, existing.manifest.name, async () => {
        const s = await load(id);
        if (s.status === "archived") return s;
        s.status = "archived";
        return save(s);
      });
    },

    async restore(skill) {
      assertSafeSkillName(skill.manifest.name);
      await put(skill);
    },

    async delete(id) {
      await table.delete(id);
    },

    async recordUse(id, at) {
      await db.q(`UPDATE skills SET last_used_at = $2 WHERE id = $1`, [id, at ?? Date.now()]);
    },

    async resolve(name, orderedScopes) {
      return resolveFromIndex(publishedByScopeAndName(await listInScopes(orderedScopes)), name, orderedScopes);
    },

    async visibleFor(orderedScopes, granted) {
      const all = await listInScopes([...orderedScopes, ...(granted ?? []).map((ref) => ref.ownerScopeId)]);
      return visibleSkillRows(all, orderedScopes, granted);
    },

    async promote(id, targetScopeId) {
      const s = await load(id);
      assertSafeSkillName(s.manifest.name);
      if (s.status !== "published") throw new Error("only a published skill can be promoted");
      const existing = (await table.where("scopeId", targetScopeId)).find(
        (x) => x.status === "published" && x.manifest.name === s.manifest.name,
      );
      const at = Date.now();
      const promoted: Skill = {
        id: existing?.id ?? randomUUID(),
        scopeId: targetScopeId,
        manifest: s.manifest,
        status: "published",
        createdBy: s.createdBy,
        version: (existing?.version ?? 0) + 1,
        grantedCapabilities: [...s.grantedCapabilities],
        approvals: [...s.approvals],
        createdAt: at,
        updatedAt: at,
      };
      await put(promoted);
      return promoted;
    },

    async move(id, toScopeId) {
      const s = await load(id);
      assertSafeSkillName(s.manifest.name);
      if (scopeKind(toScopeId) === "org") {
        throw new Error("ceding a skill to the org goes through promote (admin-gated), not move");
      }
      s.scopeId = toScopeId;
      return save(s);
    },
  };
}
