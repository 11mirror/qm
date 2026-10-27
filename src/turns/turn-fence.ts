import pg from "pg";
import { TURN_QUEUES, tenantQueue } from "./absurd-schema.ts";

export interface FenceQueryable {
  query(text: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

// A turn holds its fence while its row is running under the token and its Absurd run is still claimed by that token
// (or was cancelled, so it may wrap up). The Absurd tables are per tenant; tenantQueue is the one place that names them.
function fenceSql(): string {
  const held = TURN_QUEUES.map(
    (queue) => `WHEN '${queue}' THEN EXISTS (
      SELECT 1 FROM absurd.${pg.escapeIdentifier(`r_${tenantQueue(queue)}`)} r WHERE r.run_id = t.absurd_run_id
        AND ((r.state = 'running' AND r.claimed_by = $2) OR r.state = 'cancelled') FOR SHARE)`,
  ).join("\n");
  return `SELECT CASE t.absurd_queue ${held} ELSE false END AS ok FROM runs t
    WHERE t.id = $1 AND t.status = 'running' AND t.lease_token = $2 AND t.absurd_run_id IS NOT NULL FOR SHARE OF t`;
}

export async function turnFenceHeld(db: FenceQueryable, turnId: string, token: string): Promise<boolean> {
  const { rows } = await db.query(fenceSql(), [turnId, token]);
  return rows[0]?.ok === true;
}
