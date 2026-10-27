import { createHash } from "node:crypto";
import { tenantCols, type PgPool } from "../persistence/pg-pool.ts";
import { cols, columnName, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import type { Cron } from "../types.ts";
import type { CreateCronInput, CronStore } from "./cron-store.ts";
import type { Scheduler } from "./scheduler.ts";

export const nightlyAt = (key: string, hour: number) =>
  `${createHash("sha256").update(key).digest()[0]! % 60} ${hour} * * *`;

export interface ManagedCronClaim {
  cronId?: string;
  arming?: boolean;
}

export const MANAGED_CRON_COLUMNS = cols(`cronId text, arming boolean`);

export interface ManagedCronProfiles<T extends ManagedCronClaim> {
  get(key: string): Promise<T | null>;
  claim(key: string, initial: T, patch: Partial<T>): Promise<T>;
  armed(key: string): Promise<T | null>;
}

export function managedCronProfiles<T extends ManagedCronClaim>(
  db: Pick<PgPool, "q" | "pool">,
  spec: TableSpec,
): ManagedCronProfiles<T> {
  const { q } = db;
  const { codec, get } = typedTable<T>(db, spec);
  const { table } = spec;
  const key = columnName(spec.key);
  return {
    get,
    async claim(id, initial, patch) {
      const sets = Object.keys(patch).map((field) => `${columnName(field)} = EXCLUDED.${columnName(field)}`);
      const claimed = await q(
        `INSERT INTO ${table} (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols(key)}) DO UPDATE SET ${sets.join(", ")} WHERE ${table}.cron_id IS NULL
         RETURNING ${codec.columns}`,
        codec.values(id, { ...initial, ...patch }),
      );
      return claimed.length ? codec.row(claimed[0]!) : (await get(id))!;
    },
    armed: async (id) =>
      codec.rows(await q(`UPDATE ${table} SET arming = NULL WHERE ${key} = $1 RETURNING ${codec.columns}`, [id]))[0] ??
      null,
  };
}

type ManagedCronDeps<T extends ManagedCronClaim> = {
  store: ManagedCronProfiles<T>;
  crons: CronStore;
  scheduler: Pick<Scheduler, "notifyChanged">;
};

export async function claimManagedCron<T extends ManagedCronClaim>(
  deps: ManagedCronDeps<T>,
  key: string,
  initial: T,
  input: CreateCronInput,
  fields: (cron: Cron) => Partial<T> = () => ({}),
): Promise<T> {
  const existing = await deps.store.get(key);
  if (existing?.cronId) return existing.arming ? arm(deps, key, existing.cronId) : existing;
  const cron = await deps.crons.create({ ...input, enabled: false });
  const stored = await deps.store.claim(key, initial, { cronId: cron.id, arming: true, ...fields(cron) } as Partial<T>);
  if (stored.cronId === cron.id) return arm(deps, key, cron.id);
  await deps.crons.delete(cron.id);
  return stored;
}

async function arm<T extends ManagedCronClaim>(deps: ManagedCronDeps<T>, key: string, cronId: string): Promise<T> {
  await deps.crons.setEnabled(cronId, true);
  deps.scheduler.notifyChanged(cronId);
  const armed = await deps.store.armed(key);
  if (!armed) throw new Error(`managed cron profile ${key} disappeared while arming`);
  return armed;
}
