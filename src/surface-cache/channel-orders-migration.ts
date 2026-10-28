import type { PgMigrationDefinition } from "../persistence/pg-migrations.ts";

const ORDERS_INTO_INSTRUCTIONS: readonly string[] = [
  `DO $orders_into_instructions$
DECLARE
  tenanted boolean;
  has_state boolean := to_regclass('channel_state') IS NOT NULL;
  r record;
  scope text;
  existing jsonb;
  revision jsonb;
  merged text;
  now_ms bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'channel_policy' AND column_name = 'orders')
  THEN RETURN; END IF;
  ALTER TABLE channel_policy_history ALTER COLUMN orders SET DEFAULT '';
  tenanted := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'soul_configs' AND column_name = 'tenant_id'
  );
  FOR r IN EXECUTE format(
    $q$SELECT %1$s AS tenant, c.id AS misfiled, substr(c.id, 9) AS container,
              COALESCE(c.json->>'content', '') AS orders, c.json->>'updatedBy' AS set_by, 'group' AS kind
       FROM soul_configs c WHERE c.id LIKE 'channel:web-project-%%'
       UNION ALL
       SELECT %2$s, NULL, p.container, p.orders, p.set_by,
              CASE WHEN p.container LIKE 'web-project-%%' THEN 'group' ELSE %3$s END
       FROM channel_policy p %4$s WHERE btrim(p.orders) <> ''$q$,
    CASE WHEN tenanted THEN 'c.tenant_id' ELSE 'NULL::uuid' END,
    CASE WHEN tenanted THEN 'p.tenant_id' ELSE 'NULL::uuid' END,
    CASE WHEN has_state THEN 's.kind' ELSE 'NULL::text' END,
    CASE WHEN has_state THEN
      'LEFT JOIN channel_state s ON s.org_id = p.org_id AND s.container = p.container'
        || CASE WHEN tenanted THEN ' AND s.tenant_id = p.tenant_id' ELSE '' END
    ELSE '' END
  )
  LOOP
    IF r.misfiled IS NOT NULL THEN
      IF tenanted THEN
        EXECUTE 'DELETE FROM soul_configs WHERE tenant_id = $1 AND id = $2' USING r.tenant, r.misfiled;
      ELSE
        EXECUTE 'DELETE FROM soul_configs WHERE id = $1' USING r.misfiled;
      END IF;
      IF btrim(r.orders) = '' THEN CONTINUE; END IF;
    END IF;
    scope := CASE WHEN r.kind = 'group' THEN 'group:' ELSE 'channel:' END || r.container;
    IF tenanted THEN
      EXECUTE 'SELECT json FROM soul_configs WHERE tenant_id = $1 AND id = $2 FOR UPDATE'
        INTO existing USING r.tenant, scope;
    ELSE
      EXECUTE 'SELECT json FROM soul_configs WHERE id = $1 FOR UPDATE' INTO existing USING scope;
    END IF;
    merged := CASE
      WHEN existing IS NULL OR btrim(COALESCE(existing->>'content', '')) = '' THEN r.orders
      WHEN existing->>'content' = r.orders THEN r.orders
      ELSE (existing->>'content') || E'\\n\\n---\\n\\n' || r.orders
    END;
    revision := jsonb_build_object(
      'scopeId', scope,
      'content', merged,
      'version', COALESCE((existing->>'version')::int, 0) + 1,
      'updatedAt', now_ms
    ) || CASE WHEN r.set_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updatedBy', r.set_by) END;
    revision := revision || jsonb_build_object(
      'history',
      jsonb_build_array(revision) || CASE
        WHEN existing IS NULL THEN '[]'::jsonb
        WHEN jsonb_typeof(existing->'history') = 'array' THEN existing->'history'
        ELSE COALESCE((SELECT jsonb_agg(h.json ORDER BY (h.json->>'version')::int DESC)
          FROM soul_history h WHERE h.json->>'scopeId' = scope
            AND (to_jsonb(h)->>'tenant_id') IS NOT DISTINCT FROM r.tenant::text), '[]'::jsonb) || jsonb_build_array(
          jsonb_strip_nulls(jsonb_build_object(
            'scopeId', scope,
            'content', existing->>'content',
            'version', COALESCE((existing->>'version')::int, 0),
            'updatedAt', COALESCE((existing->>'updatedAt')::bigint, 0),
            'updatedBy', existing->>'updatedBy'
          ))
        )
      END
    );
    revision := jsonb_set(revision, '{history}', (SELECT jsonb_agg(h ORDER BY (h->>'version')::int DESC)
      FROM jsonb_array_elements(revision->'history') h));
    IF tenanted THEN
      EXECUTE 'INSERT INTO soul_configs (tenant_id, id, json) VALUES ($1, $2, $3)
               ON CONFLICT (tenant_id, id) DO UPDATE SET json = EXCLUDED.json'
        USING r.tenant, scope, revision;
    ELSE
      EXECUTE 'INSERT INTO soul_configs (id, json) VALUES ($1, $2)
               ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json'
        USING scope, revision;
    END IF;
  END LOOP;
END
$orders_into_instructions$`,
];

export const CHANNEL_ORDERS_MIGRATION: PgMigrationDefinition = {
  id: "surface-cache/channel-policy/0003-orders-into-instructions",
  acceptedChecksums: ["a47c3d4c3c62b65458a63c2417283e39a2aefa17acf1337cd43e52de513f568d"],
  statements: ORDERS_INTO_INSTRUCTIONS,
};
