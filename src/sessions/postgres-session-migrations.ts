import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { USER_KINDS } from "./items.ts";
import { SPEND_FIELDS, spendValue } from "./postgres-session-sql.ts";

const firstSeqAtOrAfter = (ms: string, sameSession: string): string =>
  `COALESCE((SELECT MIN(i.seq) FROM items i WHERE ${sameSession} AND i.created_at >= to_timestamp(${ms}::double precision / 1000)),
            (SELECT COALESCE(MAX(i.seq) + 1, 0) FROM items i WHERE ${sameSession}))`;

const backfillParticipantSeqBounds = (sameSession: string): string =>
  `UPDATE participants p
      SET valid_from_seq = COALESCE(p.valid_from_seq, ${firstSeqAtOrAfter("p.valid_from", sameSession)}),
          valid_to_seq = CASE WHEN p.valid_to IS NULL THEN NULL
                              ELSE COALESCE(p.valid_to_seq, ${firstSeqAtOrAfter("p.valid_to", sameSession)}) END
    WHERE p.valid_from_seq IS NULL OR (p.valid_to IS NOT NULL AND p.valid_to_seq IS NULL)`;

export const SESSION_STORE_MIGRATIONS: PgMigrationDefinition[] = [
  {
    id: "sessions/store/0045-llm-request-spend-columns",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      ...SPEND_FIELDS.map(
        ([column, , type]) => `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS ${column} ${type}`,
      ),
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
      `CREATE TRIGGER items_attribution_dirty AFTER INSERT ON items
           FOR EACH ROW WHEN (NEW.kind IN ${USER_KINDS}) EXECUTE FUNCTION mark_attribution_dirty()`,
      `CREATE TRIGGER participants_attribution_dirty AFTER INSERT OR UPDATE OR DELETE ON participants
           FOR EACH ROW EXECUTE FUNCTION mark_attribution_dirty()`,
      `INSERT INTO attributed_turns_dirty(session_id) SELECT DISTINCT session_id FROM participants
           ON CONFLICT DO NOTHING`,
    ],
  },
  {
    id: "sessions/store/0049-attributed-turns-tenant",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `CREATE OR REPLACE FUNCTION mark_attribution_dirty() RETURNS trigger LANGUAGE plpgsql AS $mark_attribution_dirty$
           BEGIN
             IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'attributed_turns_dirty'::regclass
                             AND attname = 'tenant_id' AND NOT attisdropped) THEN
               INSERT INTO attributed_turns_dirty(session_id) VALUES (COALESCE(NEW.session_id, OLD.session_id))
               ON CONFLICT DO NOTHING;
             ELSIF TG_OP = 'DELETE' THEN
               INSERT INTO attributed_turns_dirty(tenant_id, session_id) VALUES (OLD.tenant_id, OLD.session_id)
               ON CONFLICT DO NOTHING;
             ELSE
               INSERT INTO attributed_turns_dirty(tenant_id, session_id) VALUES (NEW.tenant_id, NEW.session_id)
               ON CONFLICT DO NOTHING;
             END IF;
             RETURN NULL;
           END $mark_attribution_dirty$`,
      `DO $attributed_turns_tenant$
           BEGIN
             IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'participants'::regclass
                         AND attname = 'tenant_id' AND NOT attisdropped) THEN
               ALTER TABLE attributed_turns ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT qm_tenant_id();
               ALTER TABLE attributed_turns_dirty ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT qm_tenant_id();
               DELETE FROM attributed_turns;
               DELETE FROM attributed_turns_dirty;
               INSERT INTO attributed_turns_dirty(tenant_id, session_id)
                 SELECT DISTINCT tenant_id, session_id FROM participants
               ON CONFLICT DO NOTHING;
             END IF;
           END
           $attributed_turns_tenant$`,
    ],
  },
  {
    id: "sessions/store/0050-restore-spend-json-indexes",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_llm_requests_spend
             ON session_llm_requests(created_at,
               ((spend_usage_json(usage_json) ->> 'costUsd')::double precision),
               ((spend_usage_json(usage_json) ->> 'input')::bigint),
               ((spend_usage_json(usage_json) ->> 'output')::bigint),
               ((spend_usage_json(usage_json) ->> 'cacheRead')::bigint),
               ((spend_usage_json(usage_json) ->> 'cacheWrite')::bigint))
             INCLUDE (session_id, model, usage_json)
             WHERE usage_json IS NOT NULL AND (spend_usage_json(usage_json) IS NOT NULL
             AND octet_length(session_id) + octet_length(model) + octet_length(usage_json) <= 2000)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_llm_requests_spend_wide
             ON session_llm_requests(created_at)
             WHERE usage_json IS NOT NULL AND NOT (spend_usage_json(usage_json) IS NOT NULL
             AND octet_length(session_id) + octet_length(model) + octet_length(usage_json) <= 2000)`,
    ],
  },
  {
    id: "sessions/store/0051-participant-seq-bounds",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `DO $participant_seq_bounds$
           BEGIN
             IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'participants'::regclass
                         AND attname = 'tenant_id' AND NOT attisdropped) THEN
               ${backfillParticipantSeqBounds("i.tenant_id = p.tenant_id AND i.session_id = p.session_id")};
             ELSE
               ${backfillParticipantSeqBounds("i.session_id = p.session_id")};
             END IF;
           END
           $participant_seq_bounds$`,
      `ALTER TABLE participants ALTER COLUMN valid_from_seq SET NOT NULL`,
    ],
  },
  {
    id: "sessions/store/0052-items-call-id-from-body",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `DO $items_call_id_from_body$
           BEGIN
             IF EXISTS (SELECT 1 FROM items WHERE call_id IS NULL AND kind IN ('ToolCall', 'ToolResult')
                         AND jsonb_typeof(body -> 'callId') = 'string' AND body ->> 'callId' <> '') THEN
               ALTER TABLE items DISABLE TRIGGER items_append_only;
               UPDATE items SET call_id = body ->> 'callId', body = body - 'callId'
                WHERE call_id IS NULL AND kind IN ('ToolCall', 'ToolResult')
                  AND jsonb_typeof(body -> 'callId') = 'string' AND body ->> 'callId' <> '';
               ALTER TABLE items ENABLE TRIGGER items_append_only;
             END IF;
           END
           $items_call_id_from_body$`,
    ],
  },
];
