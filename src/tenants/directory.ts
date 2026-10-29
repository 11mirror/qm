import { AsyncResource } from "node:async_hooks";
import { normalizeHost, routeForHost, type HostRoute } from "../../plugins/chassis/src/tenant-hosts.ts";
import { tenantSandboxPrefix } from "../../plugins/chassis/src/tenant-settings.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { subscribePostgresChannel } from "../persistence/postgres-listener.ts";
import { perTenant, registerTenantSettings, tenant, tenantFor, withTenant, type Tenant } from "../tenant.ts";
import { reportFailure, reportFailureAs } from "../util/errors.ts";
import { listTenants, type TenantRecord } from "./registry.ts";

const FRESH_MS = 60_000;
const MISS_RELOAD_MS = 1_000;
const PREPARE_RETRY_MS = 30_000;

interface Snapshot {
  at: number;
  routes: HostRoute<Tenant>[];
  tenants: Tenant[];
  byId: Map<string, Tenant>;
}

interface DirectoryOptions {
  databaseUrl: string;
  pool: PgPool;
  secretsKey: Buffer | undefined;
  sandboxPrefix: string;
  prepare?: () => Promise<void>;
  now?: () => number;
}

const reportedCollisions = new Set<string>();

function servable(records: TenantRecord[], opts: DirectoryOptions): TenantRecord[] {
  const active = records.filter((rec) => rec.status === "active");
  const keys = (rec: TenantRecord) => [
    `org:${rec.orgId}`,
    `sandbox:${rec.sandboxNamePrefix ?? tenantSandboxPrefix(opts.sandboxPrefix, rec.id)}`,
    ...rec.hosts.map((h) => `host:${normalizeHost(h)}`),
    ...(rec.appsDomain ? [`apps:${normalizeHost(rec.appsDomain)}`] : []),
  ];
  const counts = new Map<string, number>();
  for (const rec of active) for (const key of new Set(keys(rec))) counts.set(key, (counts.get(key) ?? 0) + 1);
  const kept = [];
  for (const rec of active) {
    const conflicts = keys(rec).filter((key) => counts.get(key)! > 1);
    if (conflicts.length) {
      const collision = `${rec.id}:${conflicts.join(",")}`;
      if (!reportedCollisions.has(collision)) {
        reportedCollisions.add(collision);
        reportFailure(
          `tenant ${rec.slug}: not served`,
          new Error(`routing keys are shared by another tenant: ${conflicts.join(", ")}`),
        );
      }
    } else kept.push(rec);
  }
  return kept;
}

function tenantPreparation(prepare: (() => Promise<void>) | undefined, now: () => number) {
  const readiness = perTenant(() => ({
    done: false,
    pending: undefined as Promise<void> | undefined,
    failedAt: -Infinity,
  }));
  const isReady = (t: Tenant) => !prepare || withTenant(t, () => readiness().done);
  const ready = (t: Tenant): Promise<void> => {
    if (!prepare || isReady(t)) return Promise.resolve();
    return withTenant(t, () => {
      const r = readiness();
      if (r.pending) return r.pending;
      if (now() - r.failedAt < PREPARE_RETRY_MS)
        return Promise.reject(new Error(`tenant ${t.slug ?? t.id}: preparation failed recently`));
      r.pending = Promise.resolve()
        .then(prepare)
        .then(
          () => {
            r.done = true;
          },
          (error: unknown) => {
            r.failedAt = now();
            reportFailure(`tenant ${t.slug ?? t.id}: preparation failed`, error);
            throw error;
          },
        )
        .finally(() => {
          r.pending = undefined;
        });
      return r.pending;
    });
  };
  return { isReady, ready };
}

export function createTenantDirectory(opts: DirectoryOptions) {
  const now = opts.now ?? Date.now;
  let current: Snapshot | undefined;
  let loading: Promise<Snapshot> | null = null;
  const listeners: Array<(active: Tenant[]) => void> = [];

  const notify = () => {
    const active = current?.tenants ?? [];
    for (const listener of listeners) listener(active);
  };

  const { isReady, ready } = tenantPreparation(opts.prepare, now);

  async function load(): Promise<Snapshot> {
    const records = await listTenants(opts.pool, opts.secretsKey);
    registerTenantSettings(records);
    const entries = servable(records, opts).map((rec) => ({ rec, t: tenantFor(rec.orgId, rec.id, rec.slug) }));
    return {
      at: now(),
      routes: entries.map(({ rec, t }) => ({
        hosts: rec.hosts,
        ...(rec.appsDomain ? { appsDomain: rec.appsDomain } : {}),
        target: t,
      })),
      tenants: entries.map(({ t }) => t),
      byId: new Map(entries.map(({ rec, t }) => [rec.id, t] as const)),
    };
  }

  let attemptedAt = Number.NEGATIVE_INFINITY;
  let lastFailure: unknown;
  const attemptedRecently = () => now() - attemptedAt < MISS_RELOAD_MS;

  function reload(): Promise<Snapshot> {
    if (!loading) attemptedAt = now();
    return (loading ??= load()
      .then((next) => {
        current = next;
        notify();
        return next;
      })
      .catch((error: unknown) => {
        lastFailure = error;
        throw error;
      })
      .finally(() => {
        loading = null;
      }));
  }

  const refresh = AsyncResource.bind(() => void reload().catch(reportFailureAs("tenant registry reload", undefined)));
  const unsubscribe = subscribePostgresChannel(opts.databaseUrl, "qm_tenants", refresh, refresh);

  async function snapshot(): Promise<Snapshot> {
    if (!current) return !loading && attemptedRecently() ? Promise.reject(lastFailure) : reload();
    if (now() - current.at >= FRESH_MS && !attemptedRecently()) refresh();
    return current;
  }

  async function fresher(): Promise<Snapshot> {
    if (current && !loading && (now() - current.at < MISS_RELOAD_MS || attemptedRecently())) return current;
    try {
      return await reload();
    } catch (error) {
      if (!current) throw error;
      reportFailure("tenant registry reload", error);
      return current;
    }
  }

  return {
    async byHost(raw: string | undefined) {
      const host = normalizeHost(raw);
      if (!host) return undefined;
      const found = routeForHost((await snapshot()).routes, host) ?? routeForHost((await fresher()).routes, host);
      if (found) await ready(found);
      return found;
    },
    async active() {
      return (await snapshot()).tenants;
    },
    async owner(id: string | undefined, wait = false): Promise<Tenant | "retired" | undefined> {
      const found = id === undefined ? undefined : ((await snapshot()).byId.get(id) ?? (await fresher()).byId.get(id));
      if (!found) {
        if (id === undefined) return undefined;
        return ((await (await opts.pool.deploymentPool()).query("SELECT 1 FROM tenants WHERE id = $1::uuid", [id]))
          .rowCount ?? 0) > 0
          ? undefined
          : "retired";
      }
      if (isReady(found)) return found;
      const preparing = ready(found).then(
        () => found,
        () => undefined,
      );
      return wait ? preparing : undefined;
    },
    watch(listener: (active: Tenant[]) => void) {
      listeners.push(listener);
    },
    close: unsubscribe,
  };
}

export type TenantDirectory = ReturnType<typeof createTenantDirectory>;

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

export async function activeTenants(): Promise<Tenant[]> {
  return directory ? directory.active() : [];
}

export function foreignTenant(claimed: string | undefined, _credential: string): boolean {
  return claimed !== undefined && claimed !== tenant().orgId;
}

export async function taskTenant(id: string | undefined, wait = false): Promise<Tenant | "retired" | undefined> {
  if (directory) return directory.owner(id, wait);
  return undefined;
}

export function retiredTenantReason(id: string | undefined): string {
  return `tenant ${id ?? "unregistered"} no longer exists`;
}
