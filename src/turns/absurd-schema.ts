import { readFileSync } from "node:fs";
import { createPgPool, type PgPool } from "../persistence/pg-pool.ts";
import type { PgMigrationDefinition } from "../persistence/pg-migrations.ts";

export const TURN_QUEUES = ["turns_people", "turns_delegated", "turns_background"] as const;
export type TurnQueue = (typeof TURN_QUEUES)[number];
export const JOB_QUEUE = "jobs";
export type AbsurdQueue = TurnQueue | typeof JOB_QUEUE;
export const ABSURD_QUEUES: readonly AbsurdQueue[] = [...TURN_QUEUES, JOB_QUEUE];

export const ABSURD_SQL_URL = new URL("./absurd.sql", import.meta.url);

const queueSetup = (queue: string): string[] => [
  `SELECT absurd.create_queue('${queue}', 'unpartitioned')`,
  `SELECT absurd.set_queue_policy('${queue}', '{"cleanup_ttl":"7 days"}'::jsonb)`,
];

export const ABSURD_MIGRATION: PgMigrationDefinition = {
  id: "absurd/0.5.1",
  statements: [readFileSync(ABSURD_SQL_URL, "utf8"), ...TURN_QUEUES.flatMap(queueSetup)],
  expectedChecksum: "1ff2d7e74b5a2b0454ec1ccea7f29fdf48fc58cbe89dc8e9f8f9e896ea5c8a2b",
  acceptedChecksums: [
    "4f8dd2e6249339a7c89d650d4d71b5a04228cf329a45f515a834acdeca3864e9",
    "0c43a7c73f71963654a5bb378cd6aa711d18d4e1bb16990631b63db62a8ad1e1",
  ],
};

const RETIRED_FUNCTIONS = [
  "uuidv7_timestamp",
  "uuidv7_floor",
  "week_bucket_utc",
  "partition_week_tag",
  "ensure_partitions",
  "list_detach_candidates",
  "drop_detached_partition",
  "schedule_detach_jobs",
  "enable_cron",
  "disable_cron",
];

export const ABSURD_UNPARTITIONED_MIGRATION: PgMigrationDefinition = {
  id: "absurd/0.5.1-unpartitioned",
  statements: [
    ...RETIRED_FUNCTIONS.map((name) => `DROP FUNCTION IF EXISTS absurd.${name}`),
    readFileSync(ABSURD_SQL_URL, "utf8"),
  ],
};

export const ABSURD_JOBS_MIGRATION: PgMigrationDefinition = {
  id: "absurd/jobs-queue",
  statements: queueSetup(JOB_QUEUE),
};

export function registerAbsurdSchema(connectionString: string): PgPool {
  return createPgPool(connectionString, [ABSURD_MIGRATION, ABSURD_UNPARTITIONED_MIGRATION, ABSURD_JOBS_MIGRATION]);
}
