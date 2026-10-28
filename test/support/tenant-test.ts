import { test as nodeTest, before as nodeBefore, after as nodeAfter } from "node:test";
import { tenant, withTenant } from "../../src/tenant.ts";
import { configurePgPooling } from "../../src/persistence/pg-pool.ts";
import pg from "pg";

function scoped<T extends (...args: never[]) => unknown>(fn: T): T {
  return ((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === "function")
      args[args.length - 1] = (...values: unknown[]) => withTenant(tenant(), () => callback(...values));
    return (fn as unknown as (...args: unknown[]) => unknown)(...args);
  }) as unknown as T;
}

export const test = scoped(nodeTest);
export const before = scoped(nodeBefore);
export const after = scoped(nodeAfter);

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
    await client.query(`ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA absurd GRANT ALL ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA absurd GRANT ALL ON SEQUENCES TO ${role}`);
  } finally {
    await client.end();
  }
}
