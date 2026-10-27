import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { configurePgCaTrust, configurePgTenancy, createPgPool } from "./persistence/pg-pool.ts";
import { errMessage } from "./util/errors.ts";
import { importTenant, migrateWithBuild } from "./tenants/import.ts";
import { tenantSecretsKey, upsertTenant } from "./tenants/registry.ts";

const USAGE = `usage: node src/tenant-import-main.ts [source] [staging] [target] [tenant] [options]
  source:   --source-url <url> | --admin-url-env <NAME> --source-db <name>
  staging:  --staging-url <url> | --admin-url-env <NAME> --staging-db <name>
  target:   --target-url <url> | --target-url-env <NAME> (default DATABASE_URL)
  tenant:   --spec-env <NAME> (JSON {slug, orgId, hosts, env, secretEnv})
            | --slug <slug> --org-id <id> [--hosts a,b] [--env-file <json>] [--secret-env-file <json>]
  options:  [--tenant-id <uuid>] [--create-staging] [--batch-size <n>]
            [--replace] [--allow-extra-columns] [--dry-run]`;

type ServiceEnv = Record<string, Record<string, string>>;

interface TenantSpec {
  slug: string;
  orgId: string;
  hosts: string[];
  env: ServiceEnv;
  secretEnv: ServiceEnv;
}

function serviceEnv(parsed: unknown, label: string): ServiceEnv {
  if (parsed === undefined) return {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object keyed by service`);
  }
  const env: ServiceEnv = {};
  for (const [service, values] of Object.entries(parsed)) {
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      throw new Error(`${label}: ${service} must map variable names to strings`);
    }
    env[service] = {};
    for (const [name, value] of Object.entries(values)) {
      if (typeof value !== "string") throw new Error(`${label}: ${service}.${name} must be a string`);
      env[service][name] = value;
    }
  }
  return env;
}

function readServiceEnv(path: string | undefined, flag: string): ServiceEnv {
  return path ? serviceEnv(JSON.parse(readFileSync(path, "utf8")), flag) : {};
}

function specFromEnv(name: string): TenantSpec {
  const raw = process.env[name];
  if (!raw) throw new Error(`--spec-env: ${name} is not set`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${name} does not hold valid JSON`);
  }
  if (typeof parsed.slug !== "string" || !parsed.slug) throw new Error(`${name}: slug must be a non-empty string`);
  if (typeof parsed.orgId !== "string" || !parsed.orgId) throw new Error(`${name}: orgId must be a non-empty string`);
  const hosts = parsed.hosts ?? [];
  if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== "string")) {
    throw new Error(`${name}: hosts must be an array of strings`);
  }
  return {
    slug: parsed.slug,
    orgId: parsed.orgId,
    hosts: hosts as string[],
    env: serviceEnv(parsed.env, `${name}.env`),
    secretEnv: serviceEnv(parsed.secretEnv, `${name}.secretEnv`),
  };
}

function urlFromEnv(name: string, flag: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${flag}: ${name} is not set`);
  parseUrl(value, name);
  return value;
}

function parseUrl(url: string, label: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`${label} is not a valid connection URL`);
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = parseUrl(url, "the admin database URL");
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

function describeEnv(env: ServiceEnv): string {
  const services = Object.entries(env).map(([service, vars]) => `${service}(${Object.keys(vars).sort().join(", ")})`);
  return services.length ? services.join(" ") : "none";
}

const { values } = parseArgs({
  options: {
    "source-url": { type: "string" },
    "admin-url-env": { type: "string" },
    "source-db": { type: "string" },
    "staging-db": { type: "string" },
    "target-url-env": { type: "string" },
    "spec-env": { type: "string" },
    "staging-url": { type: "string" },
    "target-url": { type: "string" },
    slug: { type: "string" },
    "org-id": { type: "string" },
    hosts: { type: "string" },
    "env-file": { type: "string" },
    "secret-env-file": { type: "string" },
    "tenant-id": { type: "string" },
    "create-staging": { type: "boolean", default: false },
    "batch-size": { type: "string", default: "500" },
    replace: { type: "boolean", default: false },
    "allow-extra-columns": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

function usageError(message: string): never {
  console.error(`[qm:tenant-import] ${message}\n${USAGE}`);
  process.exit(2);
}

async function main(): Promise<void> {
  configurePgCaTrust({ cert: process.env.DATABASE_CA_CERT, certFile: process.env.DATABASE_CA_CERT_FILE });
  const adminUrlEnv = values["admin-url-env"];
  const adminUrl = adminUrlEnv ? urlFromEnv(adminUrlEnv, "--admin-url-env") : undefined;
  const sourceUrl =
    (values["source-url"] && values["source-url"]) ??
    (adminUrl && values["source-db"] ? withDatabase(adminUrl, values["source-db"]) : undefined);
  const stagingUrl =
    (values["staging-url"] && values["staging-url"]) ??
    (adminUrl && values["staging-db"] ? withDatabase(adminUrl, values["staging-db"]) : undefined);
  const targetUrl =
    (values["target-url"] && values["target-url"]) ??
    urlFromEnv(values["target-url-env"] ?? "DATABASE_URL", "--target-url-env");
  if (!sourceUrl) usageError("no source database");
  if (!stagingUrl) usageError("no staging database");
  const spec: TenantSpec = values["spec-env"]
    ? specFromEnv(values["spec-env"])
    : {
        slug: values.slug ?? usageError("--slug or --spec-env is required"),
        orgId: values["org-id"] ?? usageError("--org-id or --spec-env is required"),
        hosts: (values.hosts ?? "")
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
        env: readServiceEnv(values["env-file"], "--env-file"),
        secretEnv: readServiceEnv(values["secret-env-file"], "--secret-env-file"),
      };
  if (new Set([sourceUrl, stagingUrl, targetUrl]).size !== 3) {
    usageError("the source, staging and target databases must be three different databases");
  }
  const batchSize = Number(values["batch-size"]);
  if (!Number.isInteger(batchSize) || batchSize < 1) usageError("--batch-size must be a positive integer");

  configurePgTenancy(true);
  const log = (line: string) => console.log(`[qm:tenant-import] ${line}`);
  log(`tenant ${spec.slug} (org ${spec.orgId}); hosts: ${spec.hosts.join(", ") || "none"}`);
  log(`env: ${describeEnv(spec.env)}; secret env: ${describeEnv(spec.secretEnv)}`);

  const result = await importTenant({
    sourceUrl,
    stagingUrl,
    targetUrl,
    slug: spec.slug,
    orgId: spec.orgId,
    hosts: spec.hosts,
    ...(values["tenant-id"] ? { tenantId: values["tenant-id"] } : {}),
    dryRun: values["dry-run"],
    replace: values.replace,
    allowExtraColumns: values["allow-extra-columns"],
    createStaging: values["create-staging"],
    ...(adminUrl ? { maintenanceUrl: adminUrl } : {}),
    batchSize,
    migrate: migrateWithBuild(process.env, { tenantize: true, orgId: spec.orgId }),
    writeTenant: async (id) => {
      const pool = createPgPool(targetUrl);
      try {
        await upsertTenant(pool, { id, ...spec, status: "active" }, tenantSecretsKey(process.env));
      } finally {
        await pool.close();
      }
    },
    log,
  });
  log(
    result.committed
      ? `imported ${result.tables.length} tables`
      : "dry run complete; nothing was written to the target",
  );
}

try {
  await main();
} catch (error) {
  console.error(`[qm:tenant-import] ${errMessage(error)}`);
  process.exitCode = 1;
}
