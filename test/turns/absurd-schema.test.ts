import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { definePgMigration, pgMigrationFrom } from "../../src/persistence/pg-migrations.ts";
import { ABSURD_JOBS_MIGRATION, ABSURD_MIGRATION, ABSURD_SQL_URL, TURN_QUEUES } from "../../src/turns/absurd-schema.ts";

test("Absurd migration runs the vendored file whole, matches its pin and accepts the 0.5.1 release checksum", () => {
  const migration = pgMigrationFrom(ABSURD_MIGRATION);
  assert.equal(migration.id, "absurd/0.5.1");
  assert.equal(migration.statements[0], readFileSync(ABSURD_SQL_URL, "utf8").trim());
  assert.equal(migration.acceptedChecksums?.[0], "4f8dd2e6249339a7c89d650d4d71b5a04228cf329a45f515a834acdeca3864e9");
  assert.deepEqual(
    migration.statements.filter((statement) => statement.startsWith("SELECT absurd.create_queue")),
    TURN_QUEUES.map((queue) => `SELECT absurd.create_queue('${queue}', 'unpartitioned')`),
  );
  assert.throws(
    () => pgMigrationFrom({ ...ABSURD_MIGRATION, statements: [...ABSURD_MIGRATION.statements, "SELECT 1"] }),
    /checksum mismatch/,
  );
  assert.throws(() => definePgMigration(ABSURD_MIGRATION.id, ABSURD_MIGRATION.statements), /single statement/);
});

test("the jobs queue keeps its released checksum", () => {
  assert.equal(
    pgMigrationFrom(ABSURD_JOBS_MIGRATION).checksum,
    "4e1c02cb9dd0d4ebb46c3b5e94dd616019ed61d141298218348db0d747afd93a",
  );
});

test("vendored Absurd SQL carries no partition maintenance or pg_cron jobs", () => {
  const sql = readFileSync(ABSURD_SQL_URL, "utf8");
  for (const name of ["ensure_partitions", "schedule_detach_jobs", "enable_cron", "disable_cron"])
    assert.ok(!sql.includes(name), name);
});
