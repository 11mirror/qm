import { AsyncResource } from "node:async_hooks";
import { normalizeHost, routeForHost, type HostRoute } from "../../plugins/chassis/src/tenant-hosts.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { subscribePostgresChannel } from "../persistence/postgres-listener.ts";
import { registerTenantSettings, tenant, tenantFor, withTenant, type Tenant } from "../tenant.ts";
import { reportFailure, reportFailureAs } from "../util/errors.ts";
import { homeTenantId, listTenants, type TenantRecord } from "./registry.ts";

const FRESH_MS = 60_000;
const MISS_RELOAD_MS = 1_000;

export interface TenantDirectory {
  byHost(host: string | undefined): Promise<Tenant | undefined>;
  byId(id: string): Promise<Tenant | undefined>;
  active(): Promise<Tenant[]>;
  watch(listener: (active: Tenant[]) => void): void;
  close(): Promise<void>;
}

interface Snapshot {
  at: number;
  routes: HostRoute<Tenant>[];
  active: Tenant[];
}

export function createTenantDirectory(opts: {
  databaseUrl: string;
  pool: PgPool;
  secretsKey: Buffer | undefined;
  home: Tenant;
  homeHosts: readonly string[];
  homeAppsDomain?: string;
  prepare?: () => Promise<void>;
  now?: () => number;
}): TenantDirectory {
  const now = opts.now ?? Date.now;
  let current: Snapshot | undefined;
  const prepared = new Set<string>();

  async function ready(t: Tenant): Promise<boolean> {
    const key = t.id ?? "";
    if (!opts.prepare || prepared.has(key)) return true;
    try {
      await withTenant(t, opts.prepare);
      prepared.add(key);
      return true;
    } catch (error) {
      reportFailure(`tenant ${t.slug ?? key}: preparation failed`, error);
      return false;
    }
  }
  let loading: Promise<Snapshot> | null = null;

  async function load(): Promise<Snapshot> {
    const [id, records] = await Promise.all([homeTenantId(opts.pool), listTenants(opts.pool, opts.secretsKey)]);
    registerTenantSettings(records);
    const homeRecord = records.find((rec) => rec.id === id);
    const others = records.filter((rec) => rec.id !== id && rec.status === "active");
    const homeRoute: HostRoute<Tenant> = {
      hosts: [...opts.homeHosts, ...(homeRecord?.hosts ?? [])],
      ...(opts.homeAppsDomain ? { appsDomain: opts.homeAppsDomain } : {}),
      target: opts.home,
    };
    const tenants: Array<{ rec: TenantRecord; t: Tenant }> = [];
    for (const rec of others) {
      const t = tenantFor(rec.orgId, rec.id, rec.slug);
      if (await ready(t)) tenants.push({ rec, t });
    }
    return {
      at: now(),
      routes: [homeRoute, ...tenants.map(({ rec, t }) => ({ hosts: rec.hosts, target: t }))],
      active: [opts.home, ...tenants.map(({ t }) => t)],
    };
  }

  const listeners: Array<(active: Tenant[]) => void> = [];

  function reload(): Promise<Snapshot> {
    return (loading ??= load()
      .then((next) => {
        current = next;
        for (const listener of listeners) listener(next.active);
        return next;
      })
      .finally(() => {
        loading = null;
      }));
  }

  const refresh = AsyncResource.bind(() => void reload().catch(reportFailureAs("tenant registry reload", undefined)));
  const unsubscribe = subscribePostgresChannel(opts.databaseUrl, "qm_tenants", refresh, refresh);

  async function snapshot(maxAgeMs: number): Promise<Snapshot> {
    if (current && now() - current.at < maxAgeMs) return current;
    return reload();
  }

  return {
    async byHost(raw) {
      const host = normalizeHost(raw);
      if (!host) return undefined;
      const found = routeForHost((await snapshot(FRESH_MS)).routes, host);
      if (found) return found;
      return routeForHost((await snapshot(MISS_RELOAD_MS)).routes, host);
    },
    async byId(id) {
      const find = (snap: Snapshot) => snap.active.find((t) => t.id === id);
      return find(await snapshot(FRESH_MS)) ?? find(await snapshot(MISS_RELOAD_MS));
    },
    async active() {
      return (await snapshot(FRESH_MS)).active;
    },
    watch(listener) {
      listeners.push(listener);
    },
    close: unsubscribe,
  };
}

let directory: TenantDirectory | undefined;

export function useTenantDirectory(next: TenantDirectory | undefined): void {
  directory = next;
}

export function tenantByHost(host: string | undefined): Promise<Tenant | undefined> {
  if (!directory) return Promise.reject(new Error("no tenant directory is configured"));
  return directory.byHost(host);
}

export function watchActiveTenants(listener: (active: Tenant[]) => void): void {
  directory?.watch(listener);
}

export async function tenantById(id: string): Promise<Tenant | undefined> {
  return directory?.byId(id);
}

export async function activeTenants(): Promise<Tenant[]> {
  return directory ? directory.active() : [tenant()];
}

export function isHomeTenant(t: Tenant): boolean {
  return t.id === undefined;
}

export async function eachActiveTenant(fn: () => Promise<unknown>): Promise<void> {
  for (const t of await activeTenants()) {
    if (isHomeTenant(t)) await withTenant(t, fn);
    else await withTenant(t, fn).catch(reportFailureAs(`tenant ${t.slug ?? t.id}: startup`, undefined));
  }
}
