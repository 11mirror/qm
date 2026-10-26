import { buildApp } from "../../src/wiring.ts";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { installSeedSkills } from "../../src/skills/seed.ts";
import { scopeId } from "../../src/types.ts";
import { testConfig } from "./test-config.ts";

if (import.meta.main) {
  const databaseUrl = process.argv[2]!;
  const config = testConfig({ databaseUrl });
  const { runtime, skills } = buildApp({ anthropicApiKey: "test-anthropic-key", ...config });
  await migrateRegisteredPgSchemas(databaseUrl);
  await installSeedSkills(skills, {
    dir: config.skillsSeedDir,
    scopeId: scopeId("org", config.orgId),
    respectArchived: true,
  });
  await runtime.stop();
  process.exit(0);
}
