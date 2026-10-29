import { AsyncLocalStorage } from "node:async_hooks";
import { configurePgTenantSource } from "./persistence/pg-pool.ts";
import type { TenantSettings } from "./tenants/registry.ts";
import { scopeId, type ScopeId } from "./types.ts";
import { reportFailureAs } from "./util/errors.ts";

export interface Tenant {
  readonly id: string;
  readonly slug?: string;
  readonly orgId: string;
  readonly orgScope: ScopeId;
}

const current = new AsyncLocalStorage<Tenant>();

configurePgTenantSource(() => {
  const scoped = current.getStore();
  return scoped?.id;
});

export function tenantFor(orgId: string, id: string, slug?: string): Tenant {
  return { orgId, orgScope: scopeId("org", orgId), id, ...(slug ? { slug } : {}) };
}

export function tenant(): Tenant {
  const scoped = current.getStore();
  if (scoped) return scoped;
  throw new Error("Tenant work requires an explicit registered tenant");
}

export function scopedTenant(): Tenant | undefined {
  return current.getStore();
}

export function withTenant<T>(t: Tenant, fn: () => T): T {
  return current.run(t, fn);
}

export function withoutTenant<T>(fn: () => T): T {
  return current.exit(fn);
}

let registered = new Map<string, TenantSettings>();

export function registerTenantSettings(list: readonly TenantSettings[]): void {
  registered = new Map(list.flatMap((settings) => (settings.id ? [[settings.id, settings] as const] : [])));
}

export function registeredTenant(id: string): Tenant | undefined {
  const settings = registered.get(id);
  return settings?.status === "active" ? tenantFor(settings.orgId, id, settings.slug) : undefined;
}

export function tenantSettings(t: Tenant = tenant()): TenantSettings {
  if (t.id) {
    const own = registered.get(t.id);
    if (!own) throw new Error(`tenant ${t.slug ?? t.id} has no registered settings`);
    return own;
  }
  throw new Error("Tenant settings require a registered tenant id");
}

const IDLE_MS = 30 * 60_000;
const SWEEP_MS = 60_000;
type Slot = { dispose?: (state: never) => unknown };
const cached = new Map<string, { tenant: Tenant; at: number; holds: number; slots: Map<Slot, unknown> }>();
let sweptAt = 0;

function drop(key: string): void {
  const entry = cached.get(key);
  if (!entry) return;
  cached.delete(key);
  for (const [slot, state] of entry.slots)
    if (slot.dispose)
      void Promise.resolve()
        .then(() => withTenant(entry.tenant, () => slot.dispose!(state as never)))
        .catch(reportFailureAs("tenant cache: dispose", undefined, `tenant=${key}`));
}

export function evictTenant(t: Tenant): void {
  drop(t.id);
}

function cachedEntry(t: Tenant) {
  const key = t.id;
  const now = Date.now();
  if (now - sweptAt >= SWEEP_MS) {
    sweptAt = now;
    for (const [id, entry] of cached) if (entry.holds === 0 && now - entry.at >= IDLE_MS) drop(id);
  }
  let entry = cached.get(key);
  if (!entry) cached.set(key, (entry = { tenant: t, at: now, holds: 0, slots: new Map() }));
  entry.at = now;
  return entry;
}

export function holdTenant(t: Tenant): () => void {
  const entry = cachedEntry(t);
  entry.holds++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    entry.holds--;
    entry.at = Date.now();
  };
}

export function cachedTenantCount(): number {
  return cached.size;
}

export function perTenant<T>(create: () => T, dispose?: (state: T) => unknown): () => T {
  const slot: Slot = dispose ? { dispose } : {};
  return () => {
    const { slots } = cachedEntry(tenant());
    if (slots.has(slot)) return slots.get(slot) as T;
    const state = create();
    slots.set(slot, state);
    return state;
  };
}

export function pinnedPerTenant<T>(create: () => T): () => T {
  const states = new Map<string, T>();
  return () => {
    const t = tenant();
    const key = t.id;
    let state = states.get(key);
    if (state === undefined) {
      state = create();
      states.set(key, state);
    }
    return state;
  };
}
