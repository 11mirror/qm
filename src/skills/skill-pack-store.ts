import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { columnName, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import type { PackConfig } from "./normalize.ts";

type PackKind = "git";
type SyncMode = "pinned" | "tracked";
type TrustTier = "internal" | "third-party";

interface ImportRecord {
  at: number;
  commit: string;
  status: "ok" | "error";
  error?: string;
  counts?: Record<string, number>;
}

export interface SkillPack {
  id: string;
  kind: PackKind;
  url: string;
  ref: string;
  syncMode: SyncMode;
  trustTier: TrustTier;
  config?: PackConfig;
  targetScopeId: ScopeId;
  subset: "all" | string[];
  authCredentialSlug?: string;
  createdBy: string;
  createdAt: number;
  lastImport?: ImportRecord;
  updateAvailable?: boolean;
  available?: number;
}

export type NewSkillPack = Omit<SkillPack, "id" | "createdAt" | "lastImport">;

export interface SkillPackStore {
  create(input: NewSkillPack): Promise<SkillPack>;
  get(id: string): Promise<SkillPack | null>;
  list(): Promise<SkillPack[]>;
  update(id: string, patch: Partial<Omit<SkillPack, "id" | "createdAt">>): Promise<SkillPack>;
  remove(id: string): Promise<void>;
  recordImport(id: string, result: ImportRecord): Promise<void>;
}

const SKILL_PACKS: TableSpec = {
  table: "skill_packs",
  key: "id",
  keyIsField: true,
  columns: {
    kind: { type: "text", required: true },
    url: { type: "text", required: true },
    ref: { type: "text", required: true },
    syncMode: { type: "text", required: true },
    trustTier: { type: "text", required: true },
    config: { type: "jsonb" },
    targetScopeId: { type: "text", required: true },
    subset: { type: "jsonb", required: true },
    authCredentialSlug: { type: "text" },
    createdBy: { type: "text", required: true },
    createdAt: { type: "bigint", required: true },
    lastImport: { type: "jsonb" },
    updateAvailable: { type: "boolean" },
    available: { type: "bigint" },
  },
};

export const SKILL_PACKS_MIGRATION = mapToTableMigration("skills/packs/0001-typed", SKILL_PACKS);

const codec = tableCodec<SkillPack>(SKILL_PACKS);
const FIELDS = Object.keys(SKILL_PACKS.columns);

export function createSkillPackStore(opts: { databaseUrl: string; now?: () => number }): SkillPackStore {
  const { q } = createPgPool(opts.databaseUrl, [SKILL_PACKS_MIGRATION]);
  const now = opts.now ?? (() => Date.now());
  const patch = async (id: string, changes: Partial<SkillPack>): Promise<SkillPack | null> => {
    const values = codec.values(id, changes as SkillPack);
    const set = FIELDS.flatMap((field, i) =>
      field in changes ? [{ col: columnName(field), value: values[i + 1] }] : [],
    );
    if (!set.length)
      return codec.rows(await q(`SELECT ${codec.columns} FROM skill_packs WHERE id = $1`, [id]))[0] ?? null;
    const rows = await q(
      `UPDATE skill_packs SET ${set.map((c, i) => `${c.col} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING ${codec.columns}`,
      [id, ...set.map((c) => c.value)],
    );
    return codec.rows(rows)[0] ?? null;
  };
  return {
    async create(input) {
      const pack: SkillPack = { ...input, id: randomUUID(), createdAt: now() };
      await q(
        `INSERT INTO skill_packs (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${codec.updates}`,
        codec.values(pack.id, pack),
      );
      return pack;
    },
    get: async (id) => codec.rows(await q(`SELECT ${codec.columns} FROM skill_packs WHERE id = $1`, [id]))[0] ?? null,
    list: async () => codec.rows(await q(`SELECT ${codec.columns} FROM skill_packs ORDER BY id`)),
    async update(id, changes) {
      const merged = await patch(id, changes);
      if (!merged) throw new Error(`unknown skill pack: ${id}`);
      return merged;
    },
    async remove(id) {
      await q(`DELETE FROM skill_packs WHERE id = $1`, [id]);
    },
    async recordImport(id, result) {
      await patch(id, { lastImport: result });
    },
  };
}
