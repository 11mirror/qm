import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";
import { reportFailureAs } from "../util/errors.ts";
import { likeContains } from "../persistence/like.ts";

function rowToEvent(r: Record<string, unknown>): AuditEvent {
  return {
    at: Number(r.at),
    principalId: String(r.principal_id),
    action: String(r.action),
    resource: String(r.resource),
    scopeLabel: r.scope_label as ScopeId,
    ...(r.status == null ? {} : { status: String(r.status) }),
    ...(r.detail == null ? {} : { detail: String(r.detail) }),
  };
}

const COLS = "at, principal_id, action, resource, scope_label, status, detail";
const MAX = 50000;

export function createPostgresAuditLog(connectionString: string): AuditLog {
  const { q } = createPgPool(connectionString, []);

  const pendingWrites = new Set<Promise<void>>();
  return {
    record(e) {
      const write = q(`INSERT INTO audit_log(${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        e.at,
        e.principalId,
        e.action,
        e.resource,
        e.scopeLabel,
        e.status ?? null,
        e.detail ?? null,
      ])
        .then(() => undefined)
        .catch(reportFailureAs("audit: persist event", undefined));
      pendingWrites.add(write);
      void write.finally(() => pendingWrites.delete(write));
    },
    async recordOnce(key, e) {
      await q(
        `INSERT INTO audit_log(${COLS}, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (${tenantCols("idempotency_key")}) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [e.at, e.principalId, e.action, e.resource, e.scopeLabel, e.status ?? null, e.detail ?? null, key],
      );
    },
    async events() {
      await Promise.allSettled(pendingWrites);
      const rows = await q(`SELECT ${COLS} FROM audit_log ORDER BY at DESC, id DESC LIMIT $1`, [MAX]);
      return rows.map(rowToEvent).reverse();
    },
    async tail({ limit, scopeLabel, action, since, resourceContains }) {
      await Promise.allSettled(pendingWrites);
      const params: unknown[] = [];
      const conds: string[] = [];
      if (scopeLabel !== undefined) {
        params.push(scopeLabel);
        conds.push(`scope_label = $${params.length}`);
      }
      if (action !== undefined) {
        params.push(action);
        conds.push(typeof action === "string" ? `action = $${params.length}` : `action = ANY($${params.length})`);
      }
      if (since !== undefined) {
        params.push(since);
        conds.push(`at >= $${params.length}`);
      }
      if (resourceContains !== undefined) {
        params.push(likeContains(resourceContains));
        conds.push(`resource LIKE $${params.length} ESCAPE '\\'`);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      params.push(limit);
      const rows = await q(
        `SELECT ${COLS} FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToEvent);
    },
  };
}
