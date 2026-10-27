import { createDecipheriv } from "node:crypto";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Worker } from "node:worker_threads";
import { errMessage } from "./errors.ts";
import { createHostFront, hostOfUrl, proxyTarget, type HostRoute, type HostTarget } from "./tenant-hosts.ts";

export type TenantService = "core" | "portal" | "web-ui";

export interface RegistryTenant {
  id: string;
  slug: string;
  orgId: string;
  hosts: string[];
  env: Partial<Record<TenantService, Record<string, string>>>;
  secretEnv: Partial<Record<TenantService, Record<string, string>>>;
}

interface TenantRegistrySnapshot {
  homeId: string;
  tenants: RegistryTenant[];
}

type Env = Record<string, string | undefined>;

export function multitenant(env: Env): boolean {
  return env.QM_MULTITENANT === "1";
}

export function homeHosts(env: Env): string[] {
  return [env.PORTAL_PUBLIC_URL, env.PUBLIC_WEB_URL, env.PUBLIC_API_URL, env.AGENT_API_URL]
    .map(hostOfUrl)
    .filter((host): host is string => Boolean(host));
}

function secretsKey(env: Env): Buffer | undefined {
  const raw = env.QM_TENANT_SECRETS_KEY?.trim();
  if (!raw) return undefined;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("QM_TENANT_SECRETS_KEY must be 32 bytes, base64-encoded");
  return key;
}

function openSecretEnv(sealed: Buffer | null, key: Buffer | undefined): RegistryTenant["secretEnv"] {
  if (!sealed?.length) return {};
  if (!key) throw new Error("tenant secret env is set but QM_TENANT_SECRETS_KEY is not");
  if (sealed[0] !== 1) throw new Error("tenant secret env: unknown format");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
  decipher.setAuthTag(sealed.subarray(13, 29));
  const plain = Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as RegistryTenant["secretEnv"];
}

interface PgClient {
  connect(): Promise<void>;
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

async function readTenantRegistry(env: Env): Promise<TenantRegistrySnapshot> {
  if (!env.DATABASE_URL) throw new Error("QM_MULTITENANT=1 needs DATABASE_URL to read the tenant registry");
  const pgModule = "pg";
  const { default: pg } = (await import(pgModule)) as {
    default: { Client: new (config: { connectionString: string }) => PgClient };
  };
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const key = secretsKey(env);
    const home = await client.query<{ id: string }>("SELECT id::text AS id FROM qm_tenant LIMIT 1");
    const { rows } = await client.query<{
      id: string;
      slug: string;
      org_id: string;
      hosts: string[] | null;
      env: RegistryTenant["env"] | null;
      secret_env: Buffer | null;
    }>(
      "SELECT id::text AS id, slug, org_id, hosts, env, secret_env FROM tenants WHERE status = 'active' ORDER BY created_at",
    );
    return {
      homeId: home.rows[0]?.id ?? "",
      tenants: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        orgId: row.org_id,
        hosts: row.hosts ?? [],
        env: row.env ?? {},
        secretEnv: openSecretEnv(row.secret_env, key),
      })),
    };
  } finally {
    await client.end();
  }
}

export function tenantServiceEnv(base: Env, tenant: RegistryTenant, service: TenantService): Record<string, string> {
  const merged: Env = { ...base, ...tenant.env[service], ...tenant.secretEnv[service] };
  if (service !== "core") {
    merged.CORE_ORG_ID = tenant.orgId;
    if (tenant.hosts[0]) merged.CORE_TENANT_HOST = tenant.hosts[0];
  }
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function appsDomainOf(env: Env): string | undefined {
  return env.PORTAL_APPS_DOMAIN || env.DEPLOY_APPS_DOMAIN || undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export async function relocateEmbeddedAuth(env: Record<string, string>): Promise<Record<string, string>> {
  const current = env.AUTH_BROKER_UPSTREAM?.replace(/\/$/, "");
  if (env.AUTH_EMBEDDED !== "1" || !current) return env;
  const next = `http://127.0.0.1:${await freePort()}`;
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      value.startsWith(current) ? next + value.slice(current.length) : value,
    ]),
  );
}

export interface TenantWorker {
  port: number;
  stop(): Promise<number>;
}

export function startTenantWorker(entry: URL, env: Record<string, string>): Promise<TenantWorker> {
  const worker = new Worker(new URL("./tenant-worker.ts", import.meta.url), {
    env,
    workerData: { entry: entry.href },
  });
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", (port: number) => {
      worker.off("error", reject);
      worker.on("error", (error) => console.error(`[tenant] worker for ${entry.pathname} failed:`, errMessage(error)));
      resolve({ port, stop: () => worker.terminate() });
    });
  });
}

interface TenantFront {
  server: Server;
  workers: TenantWorker[];
}

export async function serveTenantsByHost(opts: {
  entry: URL;
  service: Exclude<TenantService, "core">;
  port: number;
  env: Env;
}): Promise<TenantFront> {
  const registry = await readTenantRegistry(opts.env);
  const home: RegistryTenant = {
    id: registry.homeId,
    slug: "home",
    orgId: opts.env.CORE_ORG_ID ?? "",
    hosts: homeHosts(opts.env),
    env: {},
    secretEnv: {},
  };
  const workers: TenantWorker[] = [];
  const routes: HostRoute<HostTarget>[] = [];
  let homeTarget: HostTarget | undefined;
  for (const tenant of [home, ...registry.tenants.filter((t) => t.id !== registry.homeId)]) {
    const serviceEnv = tenantServiceEnv(opts.env, tenant, opts.service);
    const env = tenant === home ? serviceEnv : await relocateEmbeddedAuth(serviceEnv);
    const worker = await startTenantWorker(opts.entry, env);
    workers.push(worker);
    const target = proxyTarget(worker.port);
    if (tenant === home) homeTarget = target;
    const appsDomain = appsDomainOf(env);
    routes.push({ hosts: tenant.hosts, ...(appsDomain ? { appsDomain } : {}), target });
  }
  const server = createHostFront(
    () => routes,
    () => homeTarget,
  );
  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  console.log(
    `[${opts.service}] multitenant front on :${(server.address() as AddressInfo).port} for ${routes.length} tenant(s)`,
  );
  return { server, workers };
}
