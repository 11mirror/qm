import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { USER_KINDS } from "./items.ts";
import { SPEND_FIELDS, spendValue } from "./postgres-session-sql.ts";

// Sessions migrations after the schema baseline (src/persistence/schema-baseline.sql), which holds 0001–0044.
export const SESSION_STORE_MIGRATIONS: PgMigrationDefinition[] = [
  {
    id: "sessions/store/0045-llm-request-spend-columns",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      ...SPEND_FIELDS.map(
        ([column, , type]) => `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS ${column} ${type}`,
      ),
      // Usage JSON as jsonb when it parses and every number field casts, else NULL (never an error).
      `CREATE OR REPLACE FUNCTION llm_spend_usage(t text) RETURNS jsonb
             LANGUAGE plpgsql IMMUTABLE PARALLEL RESTRICTED AS $llm_spend_usage$
             DECLARE j jsonb;
             BEGIN
               IF t IS NULL OR NOT pg_input_is_valid(t, 'jsonb') THEN RETURN NULL; END IF;
               j := t::jsonb;
               IF pg_input_is_valid(j ->> 'costUsd', 'double precision') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'input', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'output', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheRead', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheWrite', 'bigint') IS NOT FALSE THEN
                 RETURN j;
               END IF;
               RETURN NULL;
             EXCEPTION WHEN statement_too_complex OR program_limit_exceeded THEN
               RETURN NULL;
             END
             $llm_spend_usage$`,
      // Spend reads these columns; a call with malformed usage still counts, at zero.
      `CREATE OR REPLACE FUNCTION llm_request_spend_columns() RETURNS trigger
             LANGUAGE plpgsql AS $llm_request_spend_columns$
             DECLARE u jsonb := llm_spend_usage(NEW.usage_json);
             BEGIN
               IF NEW.usage_json IS NULL THEN
                 ${SPEND_FIELDS.map(([column]) => `NEW.${column} := NULL;`).join(" ")}
               ELSE
                 ${SPEND_FIELDS.map(([column, key, type]) => `NEW.${column} := ${spendValue("u", key, type)};`).join(" ")}
               END IF;
               RETURN NEW;
             END
             $llm_request_spend_columns$`,
      `CREATE TRIGGER session_llm_requests_spend_columns
             BEFORE INSERT OR UPDATE OF usage_json ON session_llm_requests
             FOR EACH ROW EXECUTE FUNCTION llm_request_spend_columns()`,
    ],
  },
  {
    id: "sessions/store/0046-llm-request-spend-unparsed",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_llm_requests_spend_unparsed
             ON session_llm_requests(id) WHERE usage_json IS NOT NULL AND spend_cost_usd IS NULL`,
    ],
  },
  {
    id: "sessions/store/0047-drop-spend-json-indexes",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `DROP INDEX IF EXISTS session_llm_requests_spend`,
      `DROP INDEX IF EXISTS session_llm_requests_spend_wide`,
    ],
  },
  {
    id: "sessions/store/0048-attributed-turns",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `CREATE TABLE attributed_turns(
             session_id TEXT NOT NULL, principal_id TEXT NOT NULL, day BIGINT NOT NULL,
             turns BIGINT NOT NULL, first_at BIGINT NOT NULL, last_at BIGINT NOT NULL,
             PRIMARY KEY(session_id, principal_id, day)
           )`,
      `CREATE TABLE attributed_turns_dirty(session_id TEXT PRIMARY KEY)`,
      `CREATE OR REPLACE FUNCTION mark_attribution_dirty() RETURNS trigger LANGUAGE plpgsql AS $mark_attribution_dirty$
           BEGIN
             INSERT INTO attributed_turns_dirty(session_id) VALUES (COALESCE(NEW.session_id, OLD.session_id))
             ON CONFLICT DO NOTHING;
             RETURN NULL;
           END $mark_attribution_dirty$`,
      // Items are append-only and leave only with their session, whose participants go too.
      `CREATE TRIGGER items_attribution_dirty AFTER INSERT ON items
           FOR EACH ROW WHEN (NEW.kind IN ${USER_KINDS}) EXECUTE FUNCTION mark_attribution_dirty()`,
      `CREATE TRIGGER participants_attribution_dirty AFTER INSERT OR UPDATE OR DELETE ON participants
           FOR EACH ROW EXECUTE FUNCTION mark_attribution_dirty()`,
      `INSERT INTO attributed_turns_dirty(session_id) SELECT DISTINCT session_id FROM participants
           ON CONFLICT DO NOTHING`,
    ],
  },
];
