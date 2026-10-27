import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, columnName, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
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
  columns: cols(`kind text!, url text!, ref text!, syncMode text!, trustTier text!, config jsonb,
    targetScopeId text!, subset jsonb!, authCredentialSlug text, createdBy text!,
    createdAt bigint!, lastImport jsonb, updateAvailable boolean, available bigint`),
};

export const SKILL_PACKS_MIGRATION = mapToTableMigration("skills/packs/0001-typed", SKILL_PACKS);

const FIELDS = Object.keys(SKILL_PACKS.columns);

export function createSkillPackStore(opts: { databaseUrl: string; now?: () => number }): SkillPackStore {
  const db = createPgPool(opts.databaseUrl, [SKILL_PACKS_MIGRATION]);
  const table = typedTable<SkillPack>(db, SKILL_PACKS);
  const now = opts.now ?? (() => Date.now());
  const patch = async (id: string, changes: Partial<SkillPack>): Promise<SkillPack | null> => {
    const values = table.codec.values(id, changes as SkillPack);
    const set = FIELDS.flatMap((field, i) =>
      field in changes ? [{ col: columnName(field), value: values[i + 1] }] : [],
    );
    if (!set.length) return table.get(id);
    const rows = await db.q(
      `UPDATE skill_packs SET ${set.map((c, i) => `${c.col} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING ${table.codec.columns}`,
      [id, ...set.map((c) => c.value)],
    );
    return table.codec.rows(rows)[0] ?? null;
  };
  return {
    async create(input) {
      const pack: SkillPack = { ...input, id: randomUUID(), createdAt: now() };
      await table.put(pack.id, pack);
      return pack;
    },
    get: table.get,
    list: table.all,
    async update(id, changes) {
      const merged = await patch(id, changes);
      if (!merged) throw new Error(`unknown skill pack: ${id}`);
      return merged;
    },
    async remove(id) {
      await table.delete(id);
    },
    async recordImport(id, result) {
      await patch(id, { lastImport: result });
    },
  };
}
