import type { Pool } from "pg";

export const TENANT_BYPASS_OPTION = "-c qm.tenant_bypass=on";

export const TENANCY_EXCLUDED_TABLES = ["qm_tenant", "tenants", "qm_schema_migrations"];

const EXCLUDED = TENANCY_EXCLUDED_TABLES.map((t) => `'${t}'`).join(", ");

const TENANCY_FUNCTIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS qm_tenant(id UUID PRIMARY KEY)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS qm_tenant_singleton ON qm_tenant((true))`,
  `INSERT INTO qm_tenant(id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM qm_tenant)`,
  `CREATE TABLE IF NOT EXISTS tenants(
     id UUID PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     org_id TEXT NOT NULL,
     hosts TEXT[] NOT NULL DEFAULT '{}',
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
     env JSONB NOT NULL DEFAULT '{}',
     secret_env BYTEA,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE OR REPLACE FUNCTION qm_tenant_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
   AS $qm_tenant_id$
     SELECT COALESCE(NULLIF(current_setting('qm.tenant_id', true), '')::uuid, (SELECT id FROM qm_tenant))
   $qm_tenant_id$`,
  `CREATE OR REPLACE FUNCTION qm_tenant_bypass() RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE
   AS $qm_tenant_bypass$ SELECT COALESCE(current_setting('qm.tenant_bypass', true), '') = 'on' $qm_tenant_bypass$`,
  `CREATE OR REPLACE FUNCTION qm_tenantize() RETURNS integer LANGUAGE plpgsql AS $qm_tenantize$
DECLARE
  t record;
  ix record;
  fk record;
  fn record;
  fks text[] := '{}';
  fk_tables text[] := '{}';
  def text;
  tmp text;
  changed integer := 0;
  tenant_att smallint;
BEGIN
  -- 1. tenant_id column on every table.
  FOR t IN
    SELECT c.oid, c.relname FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
      AND c.relname NOT IN (${EXCLUDED}) AND c.relname NOT LIKE 'pg\\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id uuid NOT NULL DEFAULT qm_tenant_id()', t.relname);
    changed := changed + 1;
  END LOOP;

  -- 2. Drop foreign keys between tenant tables that do not lead with tenant_id; they are recreated below.
  FOR fk IN
    SELECT con.conname, con.conrelid::regclass::text AS tbl, con.conrelid, con.conkey,
           pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class dst ON dst.oid = con.confrelid
    WHERE con.contype = 'f'
      AND src.relnamespace = current_schema()::regnamespace AND dst.relnamespace = current_schema()::regnamespace
      AND src.relname NOT IN (${EXCLUDED}) AND dst.relname NOT IN (${EXCLUDED})
      AND (SELECT attname FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = con.conkey[1]) <> 'tenant_id'
  LOOP
    def := regexp_replace(fk.def, '^FOREIGN KEY \\(', 'FOREIGN KEY (tenant_id, ');
    def := regexp_replace(def, ' REFERENCES ([^(]+)\\(', ' REFERENCES \\1(tenant_id, ');
    IF def ~ 'ON DELETE SET NULL' AND def !~ 'ON DELETE SET NULL \\(' THEN
      def := replace(def, 'ON DELETE SET NULL', 'ON DELETE SET NULL (' ||
        (SELECT string_agg(quote_ident(attname), ', ' ORDER BY array_position(fk.conkey, attnum))
           FROM pg_attribute WHERE attrelid = fk.conrelid AND attnum = ANY(fk.conkey)) || ')');
    END IF;
    fks := fks || format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.tbl, fk.conname, def);
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
    changed := changed + 1;
  END LOOP;

  -- 3. Primary keys, unique constraints and unique indexes lead with tenant_id.
  FOR ix IN
    SELECT i.indexrelid, i.indrelid, ic.relname AS index_name, tc.relname AS table_name,
           con.conname, con.contype, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class tc ON tc.oid = i.indrelid
    LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid AND con.contype IN ('p', 'u')
    WHERE i.indisunique AND tc.relnamespace = current_schema()::regnamespace AND tc.relkind = 'r'
      AND tc.relname NOT IN (${EXCLUDED})
      AND COALESCE((SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[0]), '') <> 'tenant_id'
  LOOP
    def := regexp_replace(ix.def, ' USING (\\w+) \\(', ' USING \\1 (tenant_id, ');
    IF ix.conname IS NULL THEN
      EXECUTE format('DROP INDEX %I', ix.index_name);
      EXECUTE def;
    ELSE
      tmp := left('qm_tnt_' || md5(ix.index_name), 60);
      def := regexp_replace(def, '^CREATE UNIQUE INDEX \\S+ ON ', 'CREATE UNIQUE INDEX ' || quote_ident(tmp) || ' ON ');
      EXECUTE def;
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', ix.table_name, ix.conname);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s USING INDEX %I', ix.table_name, ix.conname,
        CASE ix.contype WHEN 'p' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END, tmp);
    END IF;
    changed := changed + 1;
  END LOOP;

  -- 4. Recreate the foreign keys with tenant_id leading.
  FOREACH def IN ARRAY fks LOOP
    EXECUTE def;
  END LOOP;

  -- 5. Row-level security on every tenant table.
  FOR t IN
    SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
      AND c.relname NOT IN (${EXCLUDED}) AND c.relname NOT LIKE 'pg\\_%'
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
           OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'qm_tenant_isolation'))
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.relname);
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid AND p.polname = 'qm_tenant_isolation') THEN
      EXECUTE format('CREATE POLICY qm_tenant_isolation ON %I USING (tenant_id = qm_tenant_id() OR qm_tenant_bypass()) '
        'WITH CHECK (tenant_id = qm_tenant_id() OR qm_tenant_bypass())', t.relname);
    END IF;
    changed := changed + 1;
  END LOOP;

  -- 6. Stored functions and triggers that upsert name tenant_id in their conflict target.
  FOR fn IN
    SELECT p.oid FROM pg_proc p
    WHERE p.pronamespace = current_schema()::regnamespace AND p.prokind = 'f'
      AND p.proname NOT IN ('qm_tenantize', 'qm_tenant_id', 'qm_tenant_bypass')
      AND p.prosrc ~* 'ON CONFLICT\\s*\\((?!\\s*tenant_id)'
  LOOP
    EXECUTE regexp_replace(pg_get_functiondef(fn.oid), 'ON CONFLICT(\\s*)\\((?!\\s*tenant_id)', 'ON CONFLICT\\1(tenant_id, ', 'gi');
    changed := changed + 1;
  END LOOP;
  RETURN changed;
END
$qm_tenantize$`,
];

export async function applyTenancy(pool: Pool): Promise<void> {
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
      await client.query("SELECT qm_tenantize()");
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
