import type { PgMaintenanceDefinition, PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { DIRECTORY_MIGRATIONS } from "../directory/postgres-directory-store.ts";
import { ITEMS_CUTOVER_MIGRATIONS, LEGACY_TAPE_MIGRATIONS } from "./legacy-history-migrations.ts";
import { USER_KINDS, msOf } from "./items.ts";
import { agentOriginPattern, fireOriginPattern, ORIGIN_ALTERNATION, threadRefCronIdExpr } from "./thread-ref.ts";
import { SPEND_FIELDS, spendValue, TENANT } from "./postgres-session-sql.ts";

const threadRefOriginExpr = (threadRef: string): string =>
  `COALESCE(substring(${threadRef} FROM '${agentOriginPattern(ORIGIN_ALTERNATION)}'), substring(${threadRef} FROM '${fireOriginPattern(ORIGIN_ALTERNATION)}'), 'conversation')`;

const LOOP_OR_SWARM_REF = fireOriginPattern("(loop|swarm)");

const sessionOriginBackfillLoop = (candidates: string, keepSpendMarkers: boolean): string => `
  after := '';
  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch
      FROM (SELECT id FROM sessions WHERE id > after AND ${candidates} ORDER BY id LIMIT 5000) candidates;
    EXIT WHEN batch IS NULL;
    UPDATE sessions SET origin = ${threadRefOriginExpr("thread_ref")}, origin_id = ${threadRefCronIdExpr("thread_ref")}
     WHERE id = ANY(batch);${keepSpendMarkers ? "" : "\n    DELETE FROM session_spend_dirty WHERE writer = pg_current_xact_id();"}
    after := batch[cardinality(batch)];
    COMMIT;
    PERFORM pg_sleep(0.25);
  END LOOP;`;

const SESSION_ORIGIN_BACKFILL_SQL = `DO $session_origin_backfill$
DECLARE
  batch text[];
  after text;
BEGIN${sessionOriginBackfillLoop(`origin IS NULL AND thread_ref !~ '${LOOP_OR_SWARM_REF}'`, false)}${sessionOriginBackfillLoop(
  `(origin IS NULL OR origin = 'conversation') AND thread_ref ~ '${LOOP_OR_SWARM_REF}'`,
  true,
)}
END $session_origin_backfill$`;

const LAST_USER_ACTIVITY_BACKFILL_SQL = `DO $last_user_activity_backfill$
DECLARE
  batch text[];
  after text := '';
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch
      FROM (SELECT id FROM sessions WHERE id > after ORDER BY id LIMIT 2000) candidates;
    EXIT WHEN batch IS NULL;
    WITH latest AS MATERIALIZED (
      SELECT b.id, (SELECT ${msOf("MAX(e.created_at)")} FROM items e
                     WHERE e.tenant_id = ${TENANT} AND e.session_id = b.id AND e.kind IN ${USER_KINDS}) AS at
        FROM unnest(batch) AS b(id))
    UPDATE sessions s
       SET last_user_activity = latest.at
      FROM latest
     WHERE s.id = latest.id AND latest.at IS NOT NULL
       AND (s.last_user_activity IS NULL OR s.last_user_activity < latest.at);
    after := batch[cardinality(batch)];
    COMMIT;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $last_user_activity_backfill$`;

/** Only migration 0021 (already applied) still names this; its checksum covers the text. */
const SPEND_INDEXABLE = `(spend_usage_json(usage_json) IS NOT NULL
  AND octet_length(session_id) + octet_length(model) + octet_length(usage_json) <= 2000)`;

export const SESSION_STORE_MIGRATIONS: PgMigrationDefinition[] = [
  ...DIRECTORY_MIGRATIONS,
  {
    id: "sessions/store/0001",
    expectedChecksum: "cf56c9f6488806677a229698193ef6dd7cb74300c343bdb1930c17702c5ccf2f",
    statements: [
      `CREATE OR REPLACE FUNCTION safe_json(t text) RETURNS json
        LANGUAGE plpgsql IMMUTABLE PARALLEL UNSAFE AS $safe_json$
        BEGIN RETURN t::json; EXCEPTION WHEN others THEN RETURN NULL; END $safe_json$`,
      `DO $safe_jsonb_parallel$
        BEGIN
          IF to_regprocedure('safe_jsonb(text)') IS NOT NULL THEN
            ALTER FUNCTION safe_jsonb(text) PARALLEL UNSAFE;
          END IF;
        END $safe_jsonb_parallel$`,
      `CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY, type TEXT NOT NULL, scope_id TEXT NOT NULL,
        thread_ref TEXT UNIQUE NOT NULL, created_at BIGINT NOT NULL, title TEXT, channel_name TEXT
      )`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS channel_name TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS surface TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity BIGINT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS messages INT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turns INT`,
      `CREATE TABLE IF NOT EXISTS session_entries(
        session_id TEXT NOT NULL, seq INT NOT NULL, parent_seq INT,
        type TEXT NOT NULL, payload TEXT, scope_label TEXT NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY(session_id, seq)
      )`,
      `CREATE TABLE IF NOT EXISTS participants(
        session_id TEXT NOT NULL, principal_id TEXT NOT NULL,
        valid_from BIGINT NOT NULL, valid_to BIGINT,
        valid_from_seq INT, valid_to_seq INT,
        title TEXT, archived BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY(session_id, principal_id)
      )`,
      `CREATE TABLE IF NOT EXISTS session_leases(
        session_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at BIGINT NOT NULL
      )`,
      `ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS holder TEXT`,
      `ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS acquired_at BIGINT`,
      `CREATE TABLE IF NOT EXISTS session_tape(
        session_id TEXT NOT NULL, seq INT NOT NULL,
        kind TEXT NOT NULL, harness TEXT, payload TEXT NOT NULL, scope_label TEXT NOT NULL,
        bare_text TEXT, ts TEXT, change_time TEXT, hidden BOOLEAN, overheard BOOLEAN, author TEXT,
        entry_seq INT, covers_entry_seq INT, created_at BIGINT NOT NULL,
        PRIMARY KEY(session_id, seq)
      )`,
      `ALTER TABLE participants ADD COLUMN IF NOT EXISTS title TEXT`,
      `ALTER TABLE participants ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE participants ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE participants ADD COLUMN IF NOT EXISTS color TEXT`,
      `ALTER TABLE participants ADD COLUMN IF NOT EXISTS valid_from_seq INT`,
      `ALTER TABLE participants ADD COLUMN IF NOT EXISTS valid_to_seq INT`,
      `UPDATE participants p SET valid_from = 0, valid_from_seq = 0
        FROM sessions s
       WHERE s.id = p.session_id
         AND s.scope_id LIKE 'group:web-project-%'
         AND p.valid_to IS NULL
         AND (p.valid_from_seq IS DISTINCT FROM 0 OR p.valid_from <> 0)`,
      `UPDATE participants p SET title = NULL
        FROM sessions s
       WHERE s.id = p.session_id
         AND s.scope_id LIKE 'group:web-project-%'
         AND p.valid_to IS NULL
         AND p.title = ''`,
      `CREATE TABLE IF NOT EXISTS session_llm_requests(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_seq INT,
        step INT NOT NULL, model TEXT NOT NULL, scope_label TEXT NOT NULL,
        request TEXT NOT NULL, truncated BOOLEAN NOT NULL DEFAULT FALSE, created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS session_llm_requests_by_session
        ON session_llm_requests(session_id, created_at, step)`,
      `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS ttft_ms INT`,
      `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS duration_ms INT`,
      `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS step_gap_ms INT`,
      `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS tool_wall_json TEXT`,
      `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS usage_json TEXT`,
      `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS transport_json TEXT`,
      `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS gap_phases_json TEXT`,
      `CREATE INDEX IF NOT EXISTS sessions_by_scope ON sessions(scope_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS sessions_by_activity ON sessions((COALESCE(last_activity, created_at)) DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS sessions_by_scope_activity
        ON sessions(scope_id, (COALESCE(last_activity, created_at)) DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS session_entries_user_ts ON session_entries(created_at) WHERE type = 'user'`,
      `CREATE INDEX IF NOT EXISTS session_entries_session_created ON session_entries(session_id, created_at DESC)`,
      `DELETE FROM session_entries WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
      `DELETE FROM participants WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
      `DELETE FROM session_leases WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
      `DELETE FROM session_llm_requests WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
      `DELETE FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$'`,
    ],
  },
  {
    id: "sessions/store/0002",
    expectedChecksum: "ca9877865861adf81cfb433750327462aedcfa1e60d4e87a7845d1a77f64c2ec",
    statements: [
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS forked_from_session_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS forked_from_title TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS fork_boundary_seq INT`,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_fork_provenance_pair') THEN
          ALTER TABLE sessions ADD CONSTRAINT sessions_fork_provenance_pair
          CHECK ((forked_from_session_id IS NULL) = (fork_boundary_seq IS NULL)) NOT VALID;
        END IF;
      END $$`,
      `ALTER TABLE session_llm_requests ALTER COLUMN request DROP NOT NULL`,
      `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS prompt_hash TEXT`,
      `CREATE TABLE IF NOT EXISTS llm_prompt_envelopes(
        hash TEXT PRIMARY KEY, body TEXT NOT NULL, created_at BIGINT NOT NULL
      )`,
    ],
  },
  {
    id: "sessions/store/0003",
    expectedChecksum: "fd77efdccf169dee81da809a54313be30a0aaf92cdea4f6c33e34555bb2396c8",
    statements: [
      `CREATE OR REPLACE FUNCTION entry_search_text(payload text) RETURNS text
        LANGUAGE plpgsql IMMUTABLE PARALLEL UNSAFE AS $entry_search_text$
        DECLARE j json;
        BEGIN
          j := replace(payload, '\\u0000', '')::json;
          RETURN CASE WHEN json_typeof(j -> 'text') = 'string' THEN j ->> 'text'
                      WHEN json_typeof(j) = 'string' THEN j #>> '{}'
                      ELSE NULL END;
        EXCEPTION WHEN others THEN RETURN NULL;
        END $entry_search_text$`,
      `CREATE INDEX IF NOT EXISTS session_entries_search_fts
        ON session_entries USING GIN (to_tsvector('simple', COALESCE(entry_search_text(payload), '')))
        WHERE type IN ('user', 'assistant', 'text')`,
    ],
  },
  {
    id: "sessions/store/0004",
    expectedChecksum: "856cc6940c934b59e37d511271630f77d72b235c92ab0e2e2085207d15750a75",
    statements: [
      `CREATE TABLE IF NOT EXISTS session_pins(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT, entry_seq INT,
        added_by TEXT NOT NULL, created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS session_pins_by_session ON session_pins(session_id, created_at)`,
    ],
  },
  {
    id: "sessions/store/0005",
    expectedChecksum: "4b0824aa4311df8c66b57b16f331e9dcf3dfc8d11c112a000d83f46b1fba1bd0",
    statements: [
      `CREATE INDEX IF NOT EXISTS session_entries_user_attributed
        ON session_entries(session_id, created_at, seq)
        WHERE type = 'user' AND (payload IS NULL OR payload NOT LIKE '%"overheard":true%')`,
    ],
  },
  {
    id: "sessions/store/0006",
    expectedChecksum: "57037691db0c87e9eeb28927758ae35e426eb8a8b7f7b5b8440bb08817f39203",
    statements: [
      `ALTER FUNCTION entry_search_text(text) PARALLEL SAFE`,
      `ALTER TABLE session_entries ADD COLUMN IF NOT EXISTS search_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(entry_search_text(payload), ''))) STORED`,
      `CREATE INDEX IF NOT EXISTS session_entries_search_tsv
        ON session_entries USING GIN (search_tsv)
        WHERE type IN ('user', 'assistant', 'text')`,
      `DROP INDEX IF EXISTS session_entries_search_fts`,
    ],
  },
  {
    id: "sessions/store/0007",
    expectedChecksum: "8322f0c560da60399baf59f0364e8125e836384cd8b4d9795bd1c114d4d7d514",
    statements: [`ALTER TABLE session_tape ADD COLUMN IF NOT EXISTS attachments TEXT`],
  },
  {
    id: "sessions/store/0008",
    expectedChecksum: "4b32bec77fa021de97736856a70a45bf1e51e59e574987e0d044fe748ec4cf58",
    statements: [
      `ALTER TABLE session_tape ADD COLUMN IF NOT EXISTS display TEXT`,
      `ALTER TABLE session_tape ADD COLUMN IF NOT EXISTS security_tainted BOOLEAN`,
      `ALTER TABLE session_tape ADD COLUMN IF NOT EXISTS entry_created_at BIGINT`,
    ],
  },
  {
    id: "sessions/store/0009",
    expectedChecksum: "40558264e0589a236a8a5a688a42eb49acf8a774371b9e1c6a3e5e0a84065c7d",
    statements: [
      `CREATE TABLE IF NOT EXISTS session_entry_search(
        session_id TEXT NOT NULL, seq INT NOT NULL, type TEXT NOT NULL,
        author TEXT, text TEXT NOT NULL, created_at BIGINT NOT NULL,
        search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
        PRIMARY KEY(session_id, seq)
      )`,
      `CREATE INDEX IF NOT EXISTS session_entry_search_tsv
        ON session_entry_search USING GIN (search_tsv)`,
    ],
  },
  {
    id: "sessions/store/0010",
    expectedChecksum: "29832445f9d3bfaf0d97f11b2748a1ca533ff57c6f4bd96c594e83a6ab4f7c9a",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `DROP INDEX IF EXISTS sessions_by_activity`,
      `ALTER TABLE sessions SET (fillfactor = 70)`,
    ],
  },
  {
    id: "sessions/store/0011",
    expectedChecksum: "be590472124ab471453cfbbd7d3c1a0c57f792c97704707fba3682f4183f870d",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS origin TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS origin_id TEXT`,
    ],
  },
  {
    id: "sessions/store/0012",
    expectedChecksum: "6f52591c733daffdda7aca112ad5a21cfec5c0c36f97838d74b107a79b7100bf",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `CREATE INDEX IF NOT EXISTS session_llm_requests_screens
        ON session_llm_requests(created_at DESC) WHERE step = -1`,
    ],
  },
  {
    id: "sessions/store/0013",
    expectedChecksum: "86c8d0eff24f8f2deab4f33eccff6d0206b3a9a64943a812eec0965203dd5262",
    statements: [
      `CREATE EXTENSION IF NOT EXISTS btree_gin`,
      `CREATE INDEX IF NOT EXISTS session_entries_session_search_tsv
        ON session_entries USING GIN (session_id, search_tsv)
        WHERE type IN ('user', 'assistant', 'text')`,
      `CREATE INDEX IF NOT EXISTS session_entry_search_session_tsv
        ON session_entry_search USING GIN (session_id, search_tsv)`,
    ],
  },
  {
    id: "sessions/store/0014-search-write-through-v1",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `CREATE OR REPLACE FUNCTION sync_session_entry_search() RETURNS trigger
           LANGUAGE plpgsql AS $sync_session_entry_search$
           DECLARE body text;
           BEGIN
             IF TG_OP = 'DELETE' THEN
               DELETE FROM session_entry_search WHERE session_id = OLD.session_id AND seq = OLD.seq;
               RETURN OLD;
             END IF;
             IF TG_OP = 'UPDATE' AND (OLD.session_id, OLD.seq) IS DISTINCT FROM (NEW.session_id, NEW.seq) THEN
               DELETE FROM session_entry_search WHERE session_id = OLD.session_id AND seq = OLD.seq;
             END IF;
             IF NEW.type IN ('user', 'assistant', 'text') THEN
               body := entry_search_text(NEW.payload);
             END IF;
             IF body IS NULL OR btrim(body) = '' THEN
               DELETE FROM session_entry_search WHERE session_id = NEW.session_id AND seq = NEW.seq;
             ELSE
               INSERT INTO session_entry_search(session_id, seq, type, author, text, created_at)
               VALUES (NEW.session_id, NEW.seq, NEW.type,
                       CASE WHEN NEW.type = 'user' THEN
                         (SELECT CASE WHEN json_typeof(j -> 'name') = 'string' THEN j ->> 'name' END
                            FROM (SELECT safe_json(replace(NEW.payload, '\\u0000', '')) AS j) _) END,
                       body, NEW.created_at)
               ON CONFLICT (session_id, seq) DO UPDATE
                 SET type = EXCLUDED.type, author = EXCLUDED.author, text = EXCLUDED.text,
                     created_at = EXCLUDED.created_at;
             END IF;
             RETURN NEW;
           END $sync_session_entry_search$`,
      `CREATE TRIGGER session_entries_search_write_through
           AFTER INSERT OR UPDATE OF payload, type, created_at, session_id, seq OR DELETE ON session_entries
           FOR EACH ROW EXECUTE FUNCTION sync_session_entry_search()`,
    ],
  },
  {
    id: "sessions/store/0015-search-backfill-v1",
    statements: [
      `WITH missing AS MATERIALIZED (
             SELECT e.session_id, e.seq, e.type,
                    CASE WHEN e.type = 'user' THEN
                      (SELECT CASE WHEN json_typeof(j -> 'name') = 'string' THEN j ->> 'name' END
                         FROM (SELECT safe_json(replace(e.payload, '\\u0000', '')) AS j) _) END AS author,
                    entry_search_text(e.payload) AS text, e.created_at
               FROM session_entries e
              WHERE e.type IN ('user', 'assistant', 'text')
                AND NOT EXISTS (SELECT 1 FROM session_entry_search s WHERE s.session_id = e.session_id AND s.seq = e.seq)
              FOR SHARE OF e
           )
           INSERT INTO session_entry_search(session_id, seq, type, author, text, created_at)
           SELECT session_id, seq, type, author, text, created_at FROM missing
            WHERE COALESCE(btrim(text), '') <> ''
           ON CONFLICT (session_id, seq) DO NOTHING`,
    ],
  },
  {
    id: "sessions/store/0016-tape-source-role",
    statements: [`SET LOCAL lock_timeout = '3s'`, `ALTER TABLE session_tape ADD COLUMN IF NOT EXISTS source_role TEXT`],
  },
  {
    id: "sessions/store/0017-transcript-entries",
    statements: [
      `CREATE INDEX IF NOT EXISTS session_tape_transcript_entries
           ON session_tape(session_id, entry_seq DESC, seq DESC)
           WHERE kind = 'annotation' AND safe_json(payload)->>'event' = 'transcript_entry'`,
      `CREATE OR REPLACE VIEW session_transcript_entries AS
           SELECT DISTINCT ON (session_id, entry_seq)
             session_id, entry_seq AS seq,
             (safe_json(payload)->'entry'->>'parentSeq')::int AS parent_seq,
             safe_json(payload)->'entry'->>'type' AS type,
             (safe_json(payload)->'entry'->'payload')::text AS payload,
             scope_label,
             (safe_json(payload)->'entry'->>'at')::bigint AS created_at
           FROM session_tape t
           WHERE kind = 'annotation' AND safe_json(payload)->>'event' = 'transcript_entry'
           ORDER BY t.session_id, t.entry_seq DESC, t.seq DESC`,
    ],
  },
  {
    id: "sessions/store/0017-subagent-parentage",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS spawn_meta TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id
             ON sessions(parent_session_id) WHERE parent_session_id IS NOT NULL`,
    ],
  },
  {
    id: "sessions/store/0016-status",
    statements: ["ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status JSONB"],
  },
  {
    id: "sessions/store/0018-llm-requests-created-at",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `CREATE INDEX IF NOT EXISTS session_llm_requests_created_at
        ON session_llm_requests(created_at)`,
    ],
  },
  {
    id: "sessions/store/0019-participant-activity-indexes",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS participants_by_principal
             ON participants(principal_id, session_id)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_entries_user_activity
             ON session_entries(session_id, created_at DESC) WHERE type = 'user'`,
    ],
  },
  {
    id: "sessions/store/0020-spend-usage-json",
    statements: [
      `CREATE OR REPLACE FUNCTION spend_usage_json(t text) RETURNS jsonb
             LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $spend_usage_json$
             SELECT CASE WHEN pg_input_is_valid(j ->> 'costUsd', 'double precision') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'input', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'output', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'cacheRead', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'cacheWrite', 'bigint') IS NOT FALSE THEN j END
               FROM (SELECT CASE WHEN pg_input_is_valid(t, 'jsonb') THEN t::jsonb END AS j OFFSET 0) parsed
             $spend_usage_json$`,
    ],
  },
  {
    id: "sessions/store/0020-spend-usage-json-size",
    statements: [
      `CREATE OR REPLACE FUNCTION spend_usage_json(t text) RETURNS jsonb
             LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $spend_usage_json$
             SELECT CASE WHEN pg_input_is_valid(j ->> 'costUsd', 'double precision') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'input', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'output', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'cacheRead', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'cacheWrite', 'bigint') IS NOT FALSE THEN j END
               FROM (SELECT CASE WHEN octet_length(t) > 2000 THEN NULL
                                 WHEN pg_input_is_valid(t, 'jsonb') THEN t::jsonb END AS j OFFSET 0) parsed
             $spend_usage_json$`,
    ],
  },
  {
    id: "sessions/store/0020-spend-usage-json-size-plpgsql",
    statements: [
      `CREATE OR REPLACE FUNCTION spend_usage_json(t text) RETURNS jsonb
             LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $spend_usage_json$
             DECLARE j jsonb;
             BEGIN
               IF t IS NULL OR octet_length(t) > 2000 OR NOT pg_input_is_valid(t, 'jsonb') THEN
                 RETURN NULL;
               END IF;
               j := t::jsonb;
               IF pg_input_is_valid(j ->> 'costUsd', 'double precision') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'input', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'output', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheRead', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheWrite', 'bigint') IS NOT FALSE THEN
                 RETURN j;
               END IF;
               RETURN NULL;
             END
             $spend_usage_json$`,
    ],
  },
  {
    id: "sessions/store/0021-spend-covering-index",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_llm_requests_spend
             ON session_llm_requests(created_at,
               ((spend_usage_json(usage_json) ->> 'costUsd')::double precision),
               ((spend_usage_json(usage_json) ->> 'input')::bigint),
               ((spend_usage_json(usage_json) ->> 'output')::bigint),
               ((spend_usage_json(usage_json) ->> 'cacheRead')::bigint),
               ((spend_usage_json(usage_json) ->> 'cacheWrite')::bigint))
             INCLUDE (session_id, model, usage_json)
             WHERE usage_json IS NOT NULL AND ${SPEND_INDEXABLE}`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_llm_requests_spend_wide
             ON session_llm_requests(created_at)
             WHERE usage_json IS NOT NULL AND NOT ${SPEND_INDEXABLE}`,
    ],
  },
  {
    id: "sessions/store/0022-spend-days",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `CREATE TABLE session_spend_days(day BIGINT PRIMARY KEY, rows JSONB NOT NULL, updated_at BIGINT NOT NULL)`,
      `CREATE TABLE session_spend_dirty(
             day BIGINT, session_id TEXT, writer xid8 NOT NULL DEFAULT pg_current_xact_id(),
             UNIQUE(day, writer), CHECK (num_nonnulls(day, session_id) = 1)
           )`,
      `CREATE OR REPLACE FUNCTION invalidate_request_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_request_spend$
           BEGIN
             INSERT INTO session_spend_dirty(day)
             SELECT DISTINCT floor(at::numeric / 86400000)::bigint
               FROM (VALUES
                 (CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.created_at END),
                 (CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.created_at END)
               ) changed(at) WHERE at IS NOT NULL
             ON CONFLICT DO NOTHING;
             RETURN NULL;
           END $invalidate_request_spend$`,
      `CREATE TRIGGER session_llm_requests_spend_dirty
           AFTER INSERT OR UPDATE OF created_at, session_id, model, usage_json OR DELETE ON session_llm_requests
           FOR EACH ROW EXECUTE FUNCTION invalidate_request_spend()`,
      `CREATE OR REPLACE FUNCTION invalidate_session_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_session_spend$
           BEGIN
             IF TG_OP = 'UPDATE' AND ROW(OLD.id, OLD.scope_id, OLD.origin, OLD.thread_ref, OLD.parent_session_id)
                  IS NOT DISTINCT FROM ROW(NEW.id, NEW.scope_id, NEW.origin, NEW.thread_ref, NEW.parent_session_id) THEN
               RETURN NULL;
             END IF;
             INSERT INTO session_spend_dirty(session_id)
             SELECT DISTINCT id FROM (VALUES (OLD.id), (NEW.id)) changed(id) WHERE id IS NOT NULL;
             RETURN NULL;
           END $invalidate_session_spend$`,
      `CREATE TRIGGER sessions_spend_dirty
           AFTER INSERT OR UPDATE OF id, scope_id, origin, thread_ref, parent_session_id OR DELETE ON sessions
           FOR EACH ROW EXECUTE FUNCTION invalidate_session_spend()`,
    ],
  },
  {
    id: "sessions/store/0023-spend-days-backfill",
    statements: [
      `INSERT INTO session_spend_dirty(day)
           SELECT DISTINCT floor(created_at::numeric / 86400000)::bigint
             FROM session_llm_requests WHERE usage_json IS NOT NULL
           ON CONFLICT DO NOTHING`,
    ],
  },
  {
    id: "sessions/store/0024-user-previews",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS first_user_preview TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_user_preview TEXT`,
    ],
  },
  {
    id: "sessions/store/0025-org-activity-index",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_by_activity
             ON sessions((COALESCE(last_activity, created_at)) DESC, id DESC)`,
    ],
  },
  {
    id: "sessions/store/0026-participant-read-at",
    statements: [
      `ALTER TABLE participants ADD COLUMN IF NOT EXISTS read_at BIGINT`,
      `UPDATE participants SET read_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint WHERE read_at IS NULL`,
      `ALTER TABLE sessions DROP COLUMN IF EXISTS status`,
    ],
  },
  {
    id: "sessions/store/0027-agent-reply-index",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_entries_agent_reply
             ON session_entries(session_id, created_at DESC) WHERE type IN ('assistant', 'delivery')`,
    ],
  },
  {
    id: "sessions/store/0028-drop-run-tasks",
    statements: [`DROP TABLE IF EXISTS task_events`, `DROP TABLE IF EXISTS tasks`],
  },
  ...LEGACY_TAPE_MIGRATIONS,
  {
    id: "sessions/store/0032-session-goals",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `CREATE TABLE IF NOT EXISTS session_goals(
             session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
             objective TEXT NOT NULL,
             status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'complete', 'cancelled')),
             floor JSONB,
             token_cap BIGINT,
             tokens_used BIGINT NOT NULL DEFAULT 0,
             active_ms BIGINT,
             active_since TIMESTAMPTZ,
             completion_note TEXT,
             cancel_note TEXT,
             governor JSONB,
             pause_reason TEXT,
             created_at TIMESTAMPTZ NOT NULL,
             updated_at TIMESTAMPTZ NOT NULL
           )`,
    ],
  },
  {
    id: "sessions/store/0033-client-tools",
    statements: [`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS client_tools JSONB`],
  },
  {
    id: "sessions/store/0034-session-origin-backfill",
    prepare: [SESSION_ORIGIN_BACKFILL_SQL],
    statements: [],
  },
  ...ITEMS_CUTOVER_MIGRATIONS,
  {
    id: "sessions/store/0037-drop-legacy-history",
    statements: [
      `SET LOCAL lock_timeout = '60s'`,
      `DROP TRIGGER IF EXISTS session_entry_search ON items`,
      `DROP FUNCTION IF EXISTS sync_item_search(), sync_session_entry_search()`,
      `DROP VIEW IF EXISTS session_transcript_entries`,
      `DROP TABLE IF EXISTS session_entry_search, legacy_session_entries, session_entries, session_tape,
             legacy_tape_steps, legacy_turn_runs, legacy_tape_steps_progress, legacy_tape_skipped,
             legacy_tape_writes, legacy_prep_runs`,
      `DROP PROCEDURE IF EXISTS prepare_legacy_tape_steps(INT)`,
      `DROP FUNCTION IF EXISTS legacy_tape_written(), legacy_tape_steps_batch(TEXT[], BIGINT),
             entry_search_text(text), items_copy_payload(text), items_copy_payload(jsonb)`,
      `DROP SCHEMA IF EXISTS items_copy_ops CASCADE`,
    ],
  },
  {
    id: "sessions/store/0038-scoped-origin-pages",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_conversations_by_scope_activity
        ON sessions(scope_id, (COALESCE(last_activity, created_at)) DESC, id DESC) WHERE origin = 'conversation'`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_other_background_by_scope_activity
        ON sessions(scope_id, (COALESCE(last_activity, created_at)) DESC, id DESC) WHERE origin NOT IN ('conversation', 'cron')`,
    ],
  },
  {
    id: "sessions/store/0039-items-call-id-digest-index",
    statements: [
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS items_one_call_per_kind_digest
        ON items(tenant_id, session_id, kind, md5(call_id)) WHERE call_id IS NOT NULL`,
    ],
  },
  {
    id: "sessions/store/0040-items-call-id-digest-swap",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `DROP INDEX IF EXISTS items_one_call_per_kind`,
      `ALTER INDEX items_one_call_per_kind_digest RENAME TO items_one_call_per_kind`,
    ],
  },
  {
    id: "sessions/store/0041-drop-inline-llm-request",
    statements: [`SET LOCAL lock_timeout = '15s'`, `ALTER TABLE session_llm_requests DROP COLUMN IF EXISTS request`],
  },
  {
    id: "sessions/store/0042-llm-prompt-envelopes-created-at",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS llm_prompt_envelopes_created_at
             ON llm_prompt_envelopes(created_at)`,
    ],
  },
  {
    id: "sessions/store/0043-last-user-activity",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_user_activity BIGINT`,
    ],
  },
  {
    id: "sessions/store/0044-last-user-activity-backfill",
    prepare: [LAST_USER_ACTIVITY_BACKFILL_SQL],
    statements: [],
  },
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

export const SESSION_STORE_MAINTENANCE: PgMaintenanceDefinition[] = [
  {
    id: "sessions/maintenance/safe-jsonb-parallel",
    statements: [
      `DO $safe_jsonb_parallel$
        BEGIN
          IF to_regprocedure('safe_jsonb(text)') IS NOT NULL THEN
            ALTER FUNCTION safe_jsonb(text) PARALLEL UNSAFE;
          END IF;
        END $safe_jsonb_parallel$`,
    ],
  },
];
