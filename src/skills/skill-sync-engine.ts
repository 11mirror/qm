import type { SkillPackStore } from "./skill-pack-store.ts";
import type { SkillPackFetcher } from "./pack-fetcher.ts";
import { reportFailure } from "../util/errors.ts";

export interface SkillSyncEngine {
  tick(now?: number): Promise<void>;
}

export interface SkillSyncDeps {
  packs: SkillPackStore;
  fetcher: SkillPackFetcher;
  reconcile: (packId: string) => Promise<unknown>;
}

export function createSkillSyncEngine(deps: SkillSyncDeps): SkillSyncEngine {
  async function syncOne(packId: string): Promise<void> {
    const pack = await deps.packs.get(packId);
    if (!pack) return;
    if (pack.syncMode === "tracked") {
      const head = await deps.fetcher.resolveRef(pack);
      if (pack.lastImport?.status === "ok" && head === pack.lastImport.commit) return;
      await deps.reconcile(packId);
    } else {
      const head = await deps.fetcher.resolveRef(pack);
      const available = pack.lastImport ? head !== pack.lastImport.commit : false;
      if (available !== Boolean(pack.updateAvailable)) {
        await deps.packs.update(packId, { updateAvailable: available });
      }
    }
  }

  async function syncAll(): Promise<void> {
    for (const pack of await deps.packs.list()) {
      try {
        await syncOne(pack.id);
      } catch (e) {
        reportFailure("skill-sync: pack sync", e, pack.id);
      }
    }
  }

  return { tick: syncAll };
}
