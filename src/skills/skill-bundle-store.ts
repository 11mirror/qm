import { createHash } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
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

const SKILL_BUNDLES_MIGRATION = mapToTableMigration("skills/bundles/0001-typed", SKILL_BUNDLES);

export function createSkillBundleStore(databaseUrl: string): SkillBundleStore {
  const table = typedTable<SkillBundle>(createPgPool(databaseUrl, [SKILL_BUNDLES_MIGRATION]), SKILL_BUNDLES);
  return {
    get: table.get,
    async put(bundle) {
      await table.put(bundle.packId, bundle);
    },
    async delete(packId) {
      await table.delete(packId);
    },
    list: table.all,
  };
}
