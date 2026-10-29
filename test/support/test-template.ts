import { resolve } from "node:path";
import { buildApp } from "../../src/wiring.ts";
import { configurePgTenancy, migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { installSeedSkills } from "../../src/skills/seed.ts";
import { scopeId } from "../../src/types.ts";
import { useTenantConversion } from "../../src/tenants/bootstrap.ts";
import { tenantFor, withTenant } from "../../src/tenant.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { upsertTenant } from "../../src/tenants/registry.ts";
import { testConfig } from "./test-config.ts";

if (import.meta.main) {
  const databaseUrl = process.argv[2]!;
  const config = testConfig({ databaseUrl, databaseMigrationUrl: databaseUrl });
  useTenantConversion((client, id) =>
    upsertTenant(
      client,
      { id, orgId: "fixture", slug: "fixture", hosts: [], status: "active", oidcAdmin: false, secrets: {} },
      undefined,
    ),
  );
  const { runtime, skills } = buildApp({ anthropicApiKey: "test-anthropic-key", ...config });
  configurePgTenancy(false);
  await migrateRegisteredPgSchemas(databaseUrl);
  const pg = createPgPool(databaseUrl);
  const {
    rows: [row],
  } = await (await pg.deploymentPool()).query("SELECT id, 'fixture'::text AS org_id FROM qm_tenant");
  await withTenant(tenantFor(row.org_id, row.id), () =>
    installSeedSkills(skills, {
      dir: resolve("./skills-seed"),
      scopeId: scopeId("org", row.org_id),
      respectArchived: true,
    }),
  );
  await pg.close();
  await runtime.stop();
  process.exit(0);
}
