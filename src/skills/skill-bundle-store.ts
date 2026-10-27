import { createHash } from "node:crypto";
import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import type { SkillFile } from "./skill-store.ts";

export interface SkillBundle {
  packId: string;
  commit: string;
  files: SkillFile[];
  hash: string;
}

export function computeBundleHash(files: SkillFile[]): string {
  const h = createHash("sha256");
  for (const e of [...files].map((f) => `${f.path}\0${f.content}`).sort()) {
    h.update(e);
    h.update("\n");
  }
  return h.digest("hex");
}

export interface SkillBundleStore {
  get(packId: string): Promise<SkillBundle | null>;
  put(bundle: SkillBundle): Promise<void>;
  delete(packId: string): Promise<void>;
  list(): Promise<SkillBundle[]>;
}

const SKILL_BUNDLES: TableSpec = {
  table: "skill_bundles",
  key: "packId",
  keyIsField: true,
  columns: cols(`commit text!, files jsonb!, hash text!`),
};

export const SKILL_BUNDLES_MIGRATION = mapToTableMigration("skills/bundles/0001-typed", SKILL_BUNDLES);

const codec = tableCodec<SkillBundle>(SKILL_BUNDLES);

export function createSkillBundleStore(databaseUrl: string): SkillBundleStore {
  const { q } = createPgPool(databaseUrl, [SKILL_BUNDLES_MIGRATION]);
  return {
    get: async (packId) =>
      codec.rows(await q(`SELECT ${codec.columns} FROM skill_bundles WHERE pack_id = $1`, [packId]))[0] ?? null,
    async put(bundle) {
      await q(
        `INSERT INTO skill_bundles (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols("pack_id")}) DO UPDATE SET ${codec.updates}`,
        codec.values(bundle.packId, bundle),
      );
    },
    async delete(packId) {
      await q(`DELETE FROM skill_bundles WHERE pack_id = $1`, [packId]);
    },
    list: async () => codec.rows(await q(`SELECT ${codec.columns} FROM skill_bundles ORDER BY pack_id`)),
  };
}
