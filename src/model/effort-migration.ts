import type { PgMigrationDefinition } from "../persistence/pg-migrations.ts";

export const EFFORT_MIGRATION: PgMigrationDefinition = {
  id: "zz/runtime/0001-normalize-effort",
  statements: [
    `CREATE FUNCTION qm_normalize_effort(value jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; BEGIN
      CASE jsonb_typeof(value)
      WHEN 'object' THEN SELECT COALESCE(jsonb_object_agg(key,
        CASE WHEN key IN ('effortLevel', 'thinkingLevel', 'effort') AND val = '"ultracode"'::jsonb
          THEN '"max"'::jsonb ELSE qm_normalize_effort(val) END), '{}'::jsonb)
        INTO result FROM jsonb_each(value) e(key, val);
      WHEN 'array' THEN SELECT COALESCE(jsonb_agg(qm_normalize_effort(val) ORDER BY ord), '[]'::jsonb)
        INTO result FROM jsonb_array_elements(value) WITH ORDINALITY e(val, ord);
      ELSE result := value;
      END CASE;
      RETURN result;
    END $$`,
    `DO $$ DECLARE c record; BEGIN
      FOR c IN SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
        WHERE (table_schema = current_schema() AND (
          (table_name = 'base_model_configs' AND column_name IN ('cron_runtime','subagent_runtime','fallback_runtime')) OR
          (table_name = 'crons' AND column_name = 'runtime') OR
          (table_name = 'runs' AND column_name IN ('request','result','delivery_state')) OR
          (table_name = 'items' AND column_name = 'body') OR
          (table_name = 'decision_rules' AND column_name = 'options') OR
          (table_name IN ('run_activity','run_signals') AND column_name = 'payload')))
          OR (table_schema = 'absurd' AND (table_name LIKE 't\\_%' ESCAPE '\\' OR table_name LIKE 'c\\_%' ESCAPE '\\')
            AND column_name IN ('params','state','completed_payload'))
      LOOP
        EXECUTE format('UPDATE %I.%I SET %I = qm_normalize_effort(%I::jsonb)%s
          WHERE %I IS NOT NULL AND %I::text LIKE %L', c.table_schema, c.table_name, c.column_name,
          c.column_name, CASE WHEN c.data_type = 'text' THEN '::text' ELSE '' END,
          c.column_name, c.column_name, '%ultracode%');
      END LOOP;
      UPDATE base_model_configs SET effort_level = 'max' WHERE effort_level = 'ultracode';
    END $$`,
    "DROP FUNCTION qm_normalize_effort(jsonb)",
  ],
};
