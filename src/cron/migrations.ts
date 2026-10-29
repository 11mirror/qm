const loopInboxSource = "substring(l.json ->> 'surface' from 7)";

function loopsToCrons(tenant: boolean): string {
  const col = tenant ? "tenant_id, " : "";
  const same = (a: string, b: string) => (tenant ? ` AND ${a}.tenant_id = ${b}.tenant_id` : "");
  return `INSERT INTO cron_items (${col}id, json)
     SELECT ${tenant ? "i.tenant_id, " : ""}i.id,
            (i.json - 'loopId' - 'previousLoopId' - 'triage' - 'attempts' - 'runIds' - 'outputIds' - 'claimedAt' - 'claimToken' - 'guidance')
            || jsonb_build_object('cronId', c.id, 'status', CASE WHEN i.json ->> 'status' = 'in_progress' THEN 'queued' ELSE i.json ->> 'status' END)
     FROM loop_items i
     JOIN loops l ON l.id = i.json ->> 'loopId'${same("l", "i")}
     JOIN crons c ON c.id = l.json ->> 'cronId' AND c.json ->> 'loopId' = l.id${same("c", "l")}
     WHERE l.json ->> 'state' <> 'archived'
     ON CONFLICT DO NOTHING;
    UPDATE crons c SET json = (c.json - 'loopId') || jsonb_build_object(
       'enabled', COALESCE((c.json ->> 'enabled')::boolean, false) AND l.json ->> 'state' = 'enabled',
       'title', CASE WHEN l.json ->> 'surface' LIKE 'inbox:%' THEN c.json ->> 'title' ELSE l.json ->> 'name' END,
       'action', CASE
         WHEN l.json ->> 'surface' LIKE 'inbox:%' THEN c.json ->> 'action'
         ELSE replace(replace(replace(l.json ->> 'playbook', '/v1/loops/$LOOP_ID', '/v1/crons/' || c.id), '/v1/loops/' || l.id, '/v1/crons/' || c.id), '$LOOP_ID', c.id)
       END,
       'inbox', CASE WHEN l.json ->> 'surface' LIKE 'inbox:%' THEN jsonb_build_object('source', ${loopInboxSource}) ELSE '{}'::jsonb END)
     FROM loops l
     WHERE c.json ->> 'loopId' = l.id${same("c", "l")} AND l.json ->> 'state' <> 'archived';`;
}

export const LOOPS_TO_CRONS_MIGRATION = {
  id: "durable-map/crons/0002-loops-to-crons",
  acceptedChecksums: [
    "61ac2ad5d1909cfbe1119e0e16519a0f6e551a653d154b132349305ac12cd20a",
    "97a042fb7fe422c0e82045d2641f9f62f588eaf12908733252f7e7af777093f0",
  ],
  statements: [
    ...["crons", "loops", "loop_items", "cron_items"].map(
      (table) => `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    ),
    `DO $loops_to_crons$
     BEGIN
       IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'loops'::regclass AND attname = 'tenant_id' AND NOT attisdropped) THEN
         ALTER TABLE cron_items ADD COLUMN IF NOT EXISTS tenant_id uuid;
         IF EXISTS (SELECT 1 FROM cron_items i WHERE i.tenant_id IS NULL AND
           (SELECT count(DISTINCT c.tenant_id) FROM crons c WHERE c.id = i.json->>'cronId') <> 1) THEN
           RAISE EXCEPTION 'Cron item ownership is missing or ambiguous; repair inbox state before migrating';
         END IF;
         UPDATE cron_items i SET tenant_id = c.tenant_id FROM crons c WHERE i.tenant_id IS NULL AND c.id = i.json->>'cronId';
         ALTER TABLE cron_items ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT qm_tenant_id();
         PERFORM qm_tenantize();
         ${loopsToCrons(true)}
       ELSE
         ${loopsToCrons(false)}
       END IF;
     END
     $loops_to_crons$`,
    "DELETE FROM crons WHERE json ? 'loopId'",
  ],
};
