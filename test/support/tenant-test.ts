import {
  test as nodeTest,
  before as nodeBefore,
  after as nodeAfter,
  beforeEach as nodeBeforeEach,
  afterEach as nodeAfterEach,
} from "node:test";
import { registerTenantSettings, tenantFor, withTenant } from "../../src/tenant.ts";
import { configurePgPooling } from "../../src/persistence/pg-pool.ts";
import pg from "pg";
import { useTenantDirectory } from "../../src/tenants/directory.ts";
import { randomUUID } from "node:crypto";
import { useTenantConversion } from "../../src/tenants/bootstrap.ts";
import { upsertTenant } from "../../src/tenants/registry.ts";

const owner = tenantFor("default-org", randomUUID(), "fixture");
export const testTenant = () => owner;
export const fixtureSettings = () => ({
  id: owner.id!,
  orgId: owner.orgId,
  slug: `fixture-${owner.id!.slice(0, 8)}`,
  hosts: ["home.example.test"],
  status: "active" as const,
  oidcAdmin: false,
  secrets: {},
});
registerTenantSettings([fixtureSettings()]);
useTenantConversion(async (client, id) => {
  Object.assign(owner, { id });
  const settings = fixtureSettings();
  registerTenantSettings([settings]);
  await upsertTenant(client, settings, undefined);
});

useTenantDirectory({
  active: async () => [owner],
  owner: async (id) => (id === owner.id ? owner : undefined),
  byHost: async () => undefined,
  watch: () => {},
  close: async () => {},
});

function scoped<T extends (...args: never[]) => unknown>(fn: T): T {
  return ((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === "function")
      args[args.length - 1] = (...values: unknown[]) => withTenant(owner, () => callback(...values));
    return (fn as unknown as (...args: unknown[]) => unknown)(...args);
  }) as unknown as T;
}

export const test = scoped(nodeTest);
export const before = scoped(nodeBefore);
export const after = scoped(nodeAfter);
export const beforeEach = scoped(nodeBeforeEach);
export const afterEach = scoped(nodeAfterEach);

export async function configureTestTenancy(applicationUrl: string): Promise<void> {
  const migration = new URL(process.env.DATABASE_URL!);
  migration.pathname = new URL(applicationUrl).pathname;
  configurePgPooling({ tenancy: true, migrationUrl: migration.toString() });
  const client = new pg.Client({ connectionString: migration.toString() });
  await client.connect();
  const role = pg.escapeIdentifier(decodeURIComponent(new URL(applicationUrl).username));
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS absurd`);
    await client.query(`GRANT USAGE ON SCHEMA absurd TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO ${role}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA absurd GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA absurd GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
  } finally {
    await client.end();
  }
}
