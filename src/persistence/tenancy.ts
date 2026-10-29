import type { Pool } from "pg";
import { TENANT_EXTRA_COLUMNS } from "../tenants/registry.ts";
import { convertDatabaseTenant } from "../tenants/bootstrap.ts";

const DEPLOYMENT_TABLES = {
  instance_heartbeats: "instance_id",
  background_ownership: "id",
  source_auth_replay: "event_id",
};

const TENANCY_EXCLUDED_TABLES = ["qm_tenant", "tenants", "qm_schema_migrations", ...Object.keys(DEPLOYMENT_TABLES)];

const EXCLUDED = TENANCY_EXCLUDED_TABLES.map((t) => `'${t}'`).join(", ");

const TENANCY_FUNCTIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tenants(
     id UUID PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     org_id TEXT NOT NULL,
     hosts TEXT[] NOT NULL DEFAULT '{}',
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE tenants
     ADD COLUMN IF NOT EXISTS apps_domain TEXT,
     ADD COLUMN IF NOT EXISTS s3_bucket TEXT,
     ADD COLUMN IF NOT EXISTS sentry_deployment TEXT,
     ADD COLUMN IF NOT EXISTS favicon_svg TEXT,
     ADD COLUMN IF NOT EXISTS oidc_client_id TEXT,
     ADD COLUMN IF NOT EXISTS oidc_label TEXT,
     ADD COLUMN IF NOT EXISTS oidc_admin BOOLEAN NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS secrets BYTEA`,
  ...TENANT_EXTRA_COLUMNS.map(([, column, type]) => `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ${column} ${type}`),
  `CREATE OR REPLACE FUNCTION qm_tenants_changed() RETURNS trigger LANGUAGE plpgsql
   AS $qm_tenants_changed$ BEGIN PERFORM pg_notify('qm_tenants', TG_OP); RETURN NULL; END $qm_tenants_changed$`,
  `CREATE OR REPLACE TRIGGER tenants_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON tenants
   FOR EACH STATEMENT EXECUTE FUNCTION qm_tenants_changed()`,
  `CREATE OR REPLACE FUNCTION qm_tenant_id() RETURNS uuid LANGUAGE plpgsql STABLE PARALLEL SAFE
   AS $qm_tenant_id$
   DECLARE id text := NULLIF(current_setting('qm.tenant_id', true), '');
   BEGIN
     IF id IS NULL THEN RAISE EXCEPTION 'Postgres query requires an explicit tenant context'; END IF;
     RETURN id::uuid;
   END $qm_tenant_id$`,
  `CREATE OR REPLACE FUNCTION qm_tenants_with_rows(tables regclass[]) RETURNS TABLE(id uuid)
   LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $tenants_with_rows$
   DECLARE rel regclass;
   BEGIN
     FOREACH rel IN ARRAY tables LOOP
       IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE c.oid = rel AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
           AND c.relrowsecurity AND a.attname = 'tenant_id' AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped)
       THEN RAISE EXCEPTION 'Not a tenant table'; END IF;
       RETURN QUERY EXECUTE format('SELECT DISTINCT tenant_id FROM %s', rel);
     END LOOP;
   END $tenants_with_rows$`,
  `CREATE OR REPLACE FUNCTION qm_tenant_columns(rel oid, attnums smallint[]) RETURNS text LANGUAGE sql STABLE
   AS $qm_tenant_columns$
     SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
     FROM unnest(attnums) WITH ORDINALITY k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = rel AND a.attnum = k.attnum
   $qm_tenant_columns$`,
  `CREATE OR REPLACE FUNCTION qm_tenant_fk_def(con oid) RETURNS text LANGUAGE sql STABLE AS $qm_tenant_fk_def$
     SELECT format('FOREIGN KEY (tenant_id, %s) REFERENCES %s(tenant_id, %s)%s%s%s%s%s%s',
       qm_tenant_columns(c.conrelid, c.conkey),
       c.confrelid::regclass,
       qm_tenant_columns(c.confrelid, c.confkey),
       CASE c.confmatchtype WHEN 'f' THEN ' MATCH FULL' WHEN 'p' THEN ' MATCH PARTIAL' ELSE '' END,
       CASE c.confupdtype
         WHEN 'r' THEN ' ON UPDATE RESTRICT' WHEN 'c' THEN ' ON UPDATE CASCADE'
         WHEN 'n' THEN ' ON UPDATE SET NULL' WHEN 'd' THEN ' ON UPDATE SET DEFAULT' ELSE '' END,
       CASE c.confdeltype
         WHEN 'r' THEN ' ON DELETE RESTRICT' WHEN 'c' THEN ' ON DELETE CASCADE'
         WHEN 'n' THEN ' ON DELETE SET NULL' WHEN 'd' THEN ' ON DELETE SET DEFAULT' ELSE '' END,
       CASE WHEN c.confdeltype IN ('n', 'd')
         THEN format(' (%s)', qm_tenant_columns(c.conrelid, COALESCE(c.confdelsetcols, c.conkey))) ELSE '' END,
       CASE WHEN c.condeferrable THEN ' DEFERRABLE' ELSE '' END
         || CASE WHEN c.condeferred THEN ' INITIALLY DEFERRED' ELSE '' END,
       CASE WHEN c.convalidated THEN '' ELSE ' NOT VALID' END)
     FROM pg_constraint c WHERE c.oid = con
   $qm_tenant_fk_def$`,
  `CREATE OR REPLACE FUNCTION qm_tenant_index_def(index_oid oid, index_name text) RETURNS text LANGUAGE sql STABLE
   AS $qm_tenant_index_def$
     WITH col AS (
       SELECT n, n <= i.indnkeyatts AS is_key, pg_get_indexdef(i.indexrelid, n, true) AS plain,
         pg_get_indexdef(i.indexrelid, n, true)
           || CASE WHEN i.indcollation[n - 1] <> 0 THEN ' COLLATE ' || i.indcollation[n - 1]::regcollation::text ELSE '' END
           || CASE WHEN oc.opcdefault = false THEN format(' %I.%I', ons.nspname, oc.opcname) ELSE '' END
           || CASE WHEN i.indoption[n - 1] & 1 = 1 THEN ' DESC' ELSE '' END
           || CASE WHEN i.indoption[n - 1] & 2 = 2 THEN ' NULLS FIRST'
                   WHEN i.indoption[n - 1] & 1 = 1 THEN ' NULLS LAST' ELSE '' END AS key
       FROM pg_index i
       CROSS JOIN generate_series(1, i.indnatts) n
       LEFT JOIN pg_opclass oc ON oc.oid = i.indclass[n - 1]
       LEFT JOIN pg_namespace ons ON ons.oid = oc.opcnamespace
       WHERE i.indexrelid = index_oid
     )
     SELECT format('CREATE UNIQUE INDEX %I ON %I USING %I (tenant_id, %s)%s%s%s%s',
       index_name, tc.relname, am.amname,
       (SELECT string_agg(key, ', ' ORDER BY n) FROM col WHERE is_key),
       COALESCE(' INCLUDE (' || (SELECT string_agg(plain, ', ' ORDER BY n) FROM col WHERE NOT is_key) || ')', ''),
       CASE WHEN i.indnullsnotdistinct THEN ' NULLS NOT DISTINCT' ELSE '' END,
       COALESCE(' WITH (' || array_to_string(ic.reloptions, ', ') || ')', ''),
       COALESCE(' WHERE ' || pg_get_expr(i.indpred, i.indrelid, true), ''))
     FROM pg_index i
     JOIN pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_class tc ON tc.oid = i.indrelid
     JOIN pg_am am ON am.oid = ic.relam
     WHERE i.indexrelid = index_oid
   $qm_tenant_index_def$`,
  `CREATE OR REPLACE FUNCTION acl_grants_bump_version() RETURNS trigger LANGUAGE plpgsql AS $acl_grants_bump_version$
   BEGIN
     INSERT INTO acl_grants_version(only_row, v) VALUES (TRUE, 1)
     ON CONFLICT (tenant_id, only_row) DO UPDATE SET v = acl_grants_version.v + 1;
     RETURN NULL;
   END
   $acl_grants_bump_version$`,
  `DROP FUNCTION IF EXISTS qm_tenantize()`,
  `CREATE OR REPLACE FUNCTION qm_tenantize(owner uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $qm_tenantize$
DECLARE
  t record;
  ix record;
  fk record;
  fks text[] := '{}';
  tmp text;
  changed integer := 0;
BEGIN
  FOR t IN
    SELECT c.oid, c.relname FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
      AND c.relname NOT IN (${EXCLUDED}) AND c.relname NOT LIKE 'pg\\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  LOOP
    IF owner IS NULL THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id uuid NOT NULL', t.relname);
    ELSE
      EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id uuid NOT NULL DEFAULT %L::uuid', t.relname, owner);
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT qm_tenant_id()', t.relname);
    changed := changed + 1;
  END LOOP;

  FOR fk IN
    SELECT con.oid, con.conname, con.conrelid::regclass::text AS tbl
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class dst ON dst.oid = con.confrelid
    WHERE con.contype = 'f'
      AND src.relnamespace = current_schema()::regnamespace AND dst.relnamespace = current_schema()::regnamespace
      AND src.relname NOT IN (${EXCLUDED}) AND dst.relname NOT IN (${EXCLUDED})
      AND (SELECT attname FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = con.conkey[1]) <> 'tenant_id'
  LOOP
    fks := fks || format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.tbl, fk.conname, qm_tenant_fk_def(fk.oid));
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
    changed := changed + 1;
  END LOOP;

  FOR ix IN
    SELECT i.indexrelid, ic.relname AS index_name, tc.relname AS table_name, con.conname, con.contype
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class tc ON tc.oid = i.indrelid
    LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid AND con.contype IN ('p', 'u')
    WHERE i.indisunique AND tc.relnamespace = current_schema()::regnamespace AND tc.relkind = 'r'
      AND tc.relname NOT IN (${EXCLUDED})
      AND COALESCE((SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[0]), '') <> 'tenant_id'
  LOOP
    IF ix.conname IS NULL THEN
      tmp := qm_tenant_index_def(ix.indexrelid, ix.index_name);
      EXECUTE format('DROP INDEX %I', ix.index_name);
      EXECUTE tmp;
    ELSE
      tmp := left('qm_tnt_' || md5(ix.index_name), 60);
      EXECUTE qm_tenant_index_def(ix.indexrelid, tmp);
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', ix.table_name, ix.conname);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s USING INDEX %I', ix.table_name, ix.conname,
        CASE ix.contype WHEN 'p' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END, tmp);
    END IF;
    changed := changed + 1;
  END LOOP;

  FOREACH tmp IN ARRAY fks LOOP
    EXECUTE tmp;
  END LOOP;

  FOR t IN
    SELECT c.oid, c.relname FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
      AND c.relname NOT IN (${EXCLUDED}) AND c.relname NOT LIKE 'pg\\_%'
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'qm_tenant_isolation'
          AND pg_get_expr(p.polqual, p.polrelid) = '(tenant_id = qm_tenant_id())'
          AND pg_get_expr(p.polwithcheck, p.polrelid) = '(tenant_id = qm_tenant_id())'))
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS qm_tenant_isolation ON %I', t.relname);
    EXECUTE format('CREATE POLICY qm_tenant_isolation ON %I USING (tenant_id = qm_tenant_id()) '
      'WITH CHECK (tenant_id = qm_tenant_id())', t.relname);
    changed := changed + 1;
  END LOOP;
  RETURN changed;
END
$qm_tenantize$`,
];

async function tenantizeQueues(client: import("pg").PoolClient, owner: string | undefined): Promise<void> {
  const { rows } = await client.query(`SELECT relname FROM pg_class
    WHERE relnamespace = 'absurd'::regnamespace AND relkind = 'r' AND relname <> 'queues'
      AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = pg_class.oid AND attname = 'tenant_id')`);
  for (const { relname } of rows) {
    if (!/^[trcewi]_[a-z0-9_]+$/.test(relname)) throw new Error(`Unexpected queue table ${relname}`);
    await client.query(
      `ALTER TABLE absurd.${relname} ADD COLUMN tenant_id uuid ${owner ? `DEFAULT '${owner}'::uuid` : ""}`,
    );
  }
  for (const { relname } of rows.filter(({ relname }) => relname.startsWith("t_")))
    await client.query(`UPDATE absurd.${relname} SET tenant_id = COALESCE((headers->>'tenantId')::uuid, $1::uuid)`, [
      owner ?? null,
    ]);
  for (const { relname } of rows.filter(({ relname }) => /^[rcwi]_/.test(relname)))
    await client.query(`UPDATE absurd.${relname} q SET tenant_id = t.tenant_id
      FROM absurd.t_${relname.slice(2)} t WHERE t.task_id = q.task_id`);
  for (const { relname } of rows.filter(({ relname }) => relname.startsWith("e_")))
    await client.query(`UPDATE absurd.${relname} e SET tenant_id = w.tenant_id
      FROM absurd.w_${relname.slice(2)} w WHERE w.event_name = e.event_name`);
  for (const { relname } of rows.filter(({ relname }) => relname.startsWith("e_")))
    await client.query(`UPDATE absurd.${relname} e SET tenant_id = t.tenant_id
      FROM absurd.t_${relname.slice(2)} t WHERE t.params->>'turnId' = e.payload->>'turnId'`);
  for (const { relname } of rows.filter(({ relname }) => /^[rcwi]_/.test(relname))) {
    const unknown = await client.query(`SELECT 1 FROM absurd.${relname} q
      WHERE NOT EXISTS (SELECT 1 FROM absurd.t_${relname.slice(2)} t WHERE t.task_id = q.task_id) LIMIT 1`);
    if (unknown.rowCount)
      throw new Error(`Queue ownership is missing in ${relname}; repair queue state before migrating`);
  }
  for (const { relname } of rows.filter(({ relname }) => relname.startsWith("e_"))) {
    const queue = relname.slice(2);
    const unknown = await client.query(
      `SELECT 1 FROM absurd.${relname} e
      WHERE (SELECT count(DISTINCT owner) FROM (
        SELECT w.tenant_id AS owner FROM absurd.w_${queue} w WHERE w.event_name = e.event_name
        UNION SELECT t.tenant_id FROM absurd.t_${queue} t WHERE t.params->>'turnId' = e.payload->>'turnId'
      ) owners) > 1 OR (EXISTS (SELECT 1 FROM absurd.t_${queue} t WHERE ($1::uuid IS NULL OR t.tenant_id <> $1::uuid))
        AND NOT EXISTS (SELECT 1 FROM absurd.w_${queue} w WHERE w.event_name = e.event_name)
        AND NOT EXISTS (SELECT 1 FROM absurd.t_${queue} t WHERE t.params->>'turnId' = e.payload->>'turnId')) LIMIT 1`,
      [owner ?? null],
    );
    if (unknown.rowCount)
      throw new Error(`Queue event ownership is missing in ${relname}; repair queue state before migrating`);
  }
  for (const { relname } of rows) {
    await client.query(
      `ALTER TABLE absurd.${relname} ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT qm_tenant_id()`,
    );
  }
  await client.query(`CREATE OR REPLACE FUNCTION qm_queue_tenants(queue text) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $queue_tenants$
    BEGIN
      IF queue NOT IN ('jobs', 'turns_people', 'turns_delegated', 'turns_background') THEN
        RAISE EXCEPTION 'Unknown work queue';
      END IF;
      RETURN QUERY EXECUTE format('SELECT DISTINCT tenant_id FROM absurd.%I
        WHERE state IN (''pending'', ''running'', ''sleeping'') ORDER BY tenant_id', 't_' || queue);
    END $queue_tenants$`);
  const tables = await client.query(`SELECT relname FROM pg_class
    WHERE relnamespace = 'absurd'::regnamespace AND relkind = 'r' AND relname <> 'queues'
      AND (NOT relrowsecurity OR NOT relforcerowsecurity OR NOT EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid = pg_class.oid AND p.polname = 'qm_tenant_isolation'
          AND pg_get_expr(p.polqual, p.polrelid) = '(tenant_id = qm_tenant_id())'
          AND pg_get_expr(p.polwithcheck, p.polrelid) = '(tenant_id = qm_tenant_id())'))`);
  for (const { relname } of tables.rows) {
    if (!/^[trcewi]_[a-z0-9_]+$/.test(relname)) throw new Error(`Unexpected queue table ${relname}`);
    await client.query(`CREATE INDEX IF NOT EXISTS ${relname}_tenant ON absurd.${relname}(tenant_id)`);
    await client.query(`ALTER TABLE absurd.${relname} ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE absurd.${relname} FORCE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS qm_tenant_isolation ON absurd.${relname}`);
    await client.query(`CREATE POLICY qm_tenant_isolation ON absurd.${relname}
      USING (tenant_id = qm_tenant_id()) WITH CHECK (tenant_id = qm_tenant_id())`);
  }
}

export async function prepareTenancy(pool: Pool): Promise<boolean> {
  const { rows: roles } = await pool.query(
    "SELECT rolsuper OR rolbypassrls AS allowed FROM pg_roles WHERE rolname = current_user",
  );
  if (!roles[0]?.allowed) throw new Error("Database migrations require a separate BYPASSRLS role");
  return (await pool.query("SELECT COALESCE(to_regclass('qm_tenant'), to_regclass('sessions')) IS NOT NULL AS present"))
    .rows[0].present;
}

export async function applyTenancy(pool: Pool, existing: boolean): Promise<void> {
  const client = await pool.connect();
  let broken: Error | undefined;
  const discardOnFailure = (e: unknown) => {
    broken = e instanceof Error ? e : new Error(String(e));
  };
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('qm:tenantize'))");
    try {
      await client.query("BEGIN");
      for (const statement of TENANCY_FUNCTIONS) await client.query(statement);
      const present = (await client.query("SELECT to_regclass('qm_tenant') IS NOT NULL AS present")).rows[0].present;
      let owner = present ? (await client.query("SELECT id::text AS id FROM qm_tenant")).rows[0]?.id : undefined;
      if (owner) {
        if (!(await convertDatabaseTenant(client, owner, existing))) {
          owner = undefined;
          await client.query("DELETE FROM acl_grants_version WHERE only_row = true AND v = 0");
        }
      }
      for (const [table, primaryKey] of Object.entries(DEPLOYMENT_TABLES)) {
        const column = await client.query(
          "SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = 'tenant_id' AND NOT attisdropped",
          [table],
        );
        if (!column.rowCount) continue;
        if (table === "instance_heartbeats") await client.query("TRUNCATE instance_heartbeats");
        await client.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${table} DROP COLUMN tenant_id CASCADE`);
        if (table === "source_auth_replay")
          await client.query(
            "DELETE FROM source_auth_replay a USING source_auth_replay b WHERE a.event_id = b.event_id AND (a.expires_at, a.ctid) < (b.expires_at, b.ctid)",
          );
        await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY (${primaryKey})`);
      }
      await client.query("SELECT qm_tenantize($1::uuid)", [owner ?? null]);
      if ((await client.query("SELECT to_regnamespace('absurd') IS NOT NULL AS present")).rows[0].present)
        await tenantizeQueues(client, owner);
      if ((await client.query("SELECT to_regclass('absurd.t_jobs') IS NOT NULL AS present")).rows[0].present)
        await client.query(
          "SELECT absurd.cancel_task('jobs', task_id) FROM absurd.t_jobs WHERE task_name LIKE 'every:%' AND state IN ('pending', 'running', 'sleeping')",
        );
      await client.query("DROP FUNCTION IF EXISTS qm_tenant_bypass()");
      await client.query("DROP TABLE IF EXISTS qm_tenant");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(discardOnFailure);
      throw error;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('qm:tenantize'))").catch(discardOnFailure);
    }
  } finally {
    client.release(broken);
  }
}
