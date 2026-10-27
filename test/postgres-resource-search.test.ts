import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresResourceSearch } from "../src/search/resource-search.ts";
import { CRONS_MIGRATION } from "../src/cron/cron-store.ts";
import { DEPLOYMENTS_MIGRATION } from "../src/deploy/deploy-store.ts";
import { WEBHOOKS_MIGRATION } from "../src/webhooks/webhook-store.ts";
import { SKILLS_MIGRATION } from "../src/skills/skill-store.ts";

const database = process.env.DATABASE_URL;
test(
  "resource GIN indexes match real queries, exclude heavy fields, and track writes",
  { skip: !database },
  async () => {
    const admin = createPgPool(database!);
    const schema = `search_${randomUUID().replaceAll("-", "")}`;
    await admin.q(`CREATE SCHEMA ${schema}`);
    const url = new URL(database!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pg = createPgPool(url.toString(), [
      CRONS_MIGRATION,
      WEBHOOKS_MIGRATION,
      DEPLOYMENTS_MIGRATION,
      SKILLS_MIGRATION,
    ]);
    try {
      let searchSql = "";
      let searchParams: unknown[] = [];
      const store = createPostgresResourceSearch({
        ...pg,
        q: async (sql, params, options) => {
          if (sql.includes("@@ to_tsquery")) {
            searchSql = sql;
            searchParams = params ?? [];
          }
          return pg.q(sql, params, options);
        },
      });
      for (const kind of ["skills", "crons", "deploys", "webhooks"] as const) await store.search(kind, "zanzibar", 50);
      const triggerColumns = `id, owner_scope_id, owner, created_by, enabled, created_at, action`;
      for (const [table, [insert, insertParams, update, updateParams]] of [
        [
          "skills",
          [
            `INSERT INTO skills (id, scope_id, manifest, status, created_by, version, granted_capabilities, approvals)
             VALUES ('hit', 'personal:U1', $1, 'published', 'U1', 1, '{}', '{}')`,
            [
              JSON.stringify({
                name: "zanzibar-review",
                description: "release checklist",
                body: "privatebody ".repeat(10000),
                files: [{ content: "asset".repeat(10000) }],
              }),
            ],
            `UPDATE skills SET manifest = $1 WHERE id = 'hit'`,
            [JSON.stringify({ name: "other" })],
          ],
        ],
        [
          "crons",
          [
            `INSERT INTO crons (${triggerColumns}, title, schedule, last_fire_note)
             VALUES ('hit', 'personal:U1', 'U1', 'U1', true, 1, 'release checklist', 'zanzibar digest', '{}', $1)`,
            [JSON.stringify({ text: "privatebody ".repeat(10000), at: 1 })],
            `UPDATE crons SET title = $1, action = $1 WHERE id = 'hit'`,
            ["other"],
          ],
        ],
        [
          "deployments",
          [
            `INSERT INTO deployments (id, name, display_name, owner_scope_id, created_by, current_version, status, endpoint, versions)
             VALUES ('hit', 'zanzibar', 'Release checklist', 'personal:U1', 'U1', 1, 'stopped', $1, $2)`,
            [JSON.stringify({ secret: "never return" }), JSON.stringify([{ files: "version ".repeat(10000) }])],
            `UPDATE deployments SET name = 'other', display_name = NULL`,
            [],
          ],
        ],
        [
          "webhooks",
          [
            `INSERT INTO webhooks (${triggerColumns}, verification)
             VALUES ('hit', 'personal:U1', 'U1', 'U1', true, 1, 'zanzibar release checklist', $1)`,
            [JSON.stringify({ scheme: "github", secret: "never return" })],
            `UPDATE webhooks SET action = $1 WHERE id = 'hit'`,
            ["other"],
          ],
        ],
      ] as const) {
        await pg.q((insert as string).replace("$table", table), [...insertParams]);
        const kind = table === "deployments" ? "deploys" : table;
        const rows = await store.search(kind, "zanz release", 50);
        const actualSql = searchSql;
        const actualParams = searchParams;
        assert.equal(rows.length, 1);
        assert.ok(JSON.stringify(rows).length < 1000);
        assert.equal(JSON.stringify(rows).includes("never return"), false);
        assert.equal((await store.search(kind, "privatebody", 50)).length, 0);
        assert.equal((await store.search(kind, "' | &", 50)).length, 0);
        const indexes = await pg.q(
          "SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 AND indexname LIKE '%resource_search_gin'",
          [schema, table],
        );
        assert.equal(indexes.length, 1);
        const client = await (await pg.pool()).connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL enable_seqscan=off");
          const plan = await client.query(`EXPLAIN (FORMAT JSON) ${actualSql}`, actualParams);
          assert.match(JSON.stringify(plan.rows), /resource_search_gin/);
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
        await pg.q((update as string).replace("$table", table), [...updateParams]);
        assert.equal((await store.search(kind, "zanzibar", 50)).length, 0);
      }
    } finally {
      await pg.close();
      await admin.q(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  },
);
