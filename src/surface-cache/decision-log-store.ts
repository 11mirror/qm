import { createPgPool } from "../persistence/pg-pool.ts";
import { tenant } from "../tenant.ts";

export interface DecisionLogStore<Row, Outcome extends string, Summary = Row> {
  record(row: Row): Promise<void>;
  list(opts?: {
    scope?: string;
    outcomes?: Outcome[];
    before?: number;
    beforeId?: number;
    limit?: number;
  }): Promise<Summary[]>;
  get(id: number): Promise<Row | null>;
  counts(opts?: { scope?: string }): Promise<Record<Outcome, number>>;
  close(): Promise<void>;
}

type ColumnType = "text" | "int";

export interface DecisionLogSpec<Outcome extends string> {
  table: string;
  scopeColumn: string;
  outcomeColumn: string;
  outcomes: readonly Outcome[];
  columns: ReadonlyArray<readonly [column: string, key: string, type: ColumnType, required?: true]>;
  omitFromList: readonly string[];
}

export function createDecisionLogStore<Row extends { createdAt: number }, Outcome extends string, Summary = Row>(
  connectionString: string,
  spec: DecisionLogSpec<Outcome>,
): DecisionLogStore<Row, Outcome, Summary> {
  const { q, close } = createPgPool(connectionString, []);
  const { table, scopeColumn, outcomeColumn } = spec;
  const listColumns = spec.columns.filter(([, key]) => !spec.omitFromList.includes(key)).map(([column]) => column);
  const toRow = (r: Record<string, unknown>): Row => {
    const out: Record<string, unknown> = { id: Number(r.id), orgId: r.org_id };
    for (const [column, key, type, required] of spec.columns) {
      const value = r[column];
      if (value == null && !required) continue;
      out[key] = type === "int" ? Number(value) : value;
    }
    out.createdAt = Number(r.created_at);
    return out as Row;
  };
  return {
    async record(row) {
      const fields = row as unknown as Record<string, unknown>;
      const columns = [...spec.columns.map(([column]) => column), "created_at"];
      await q(
        `INSERT INTO ${table}(org_id, ${columns.join(", ")}) VALUES (${[tenant().orgId, ...columns].map((_, i) => `$${i + 1}`).join(",")})`,
        [tenant().orgId, ...spec.columns.map(([, key]) => fields[key] ?? null), row.createdAt],
      );
    },
    async list(opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100));
      const where = ["org_id = $1"];
      const args: unknown[] = [tenant().orgId];
      if (opts?.scope) {
        args.push(opts.scope);
        where.push(`${scopeColumn} = $${args.length}`);
      }
      if (opts?.outcomes?.length) {
        args.push(opts.outcomes);
        where.push(`${outcomeColumn} = ANY($${args.length}::text[])`);
      }
      if (opts?.before != null) {
        args.push(opts.before);
        const c = `$${args.length}`;
        if (opts.beforeId != null) {
          args.push(opts.beforeId);
          where.push(`(created_at < ${c} OR (created_at = ${c} AND id < $${args.length}))`);
        } else {
          where.push(`created_at < ${c}`);
        }
      }
      args.push(limit);
      const rows = await q(
        `SELECT id, org_id, ${listColumns.join(", ")}, created_at
         FROM ${table} WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`,
        args,
      );
      return rows.map(toRow) as unknown as Summary[];
    },
    async get(id) {
      const rows = await q(`SELECT * FROM ${table} WHERE org_id = $1 AND id = $2`, [tenant().orgId, id]);
      return rows[0] ? toRow(rows[0]) : null;
    },
    async counts(opts) {
      const args: unknown[] = [tenant().orgId];
      let where = "org_id = $1";
      if (opts?.scope) {
        args.push(opts.scope);
        where += ` AND ${scopeColumn} = $${args.length}`;
      }
      const rows = await q(
        `SELECT ${outcomeColumn} AS outcome, COUNT(*)::int AS n FROM ${table} WHERE ${where} GROUP BY ${outcomeColumn}`,
        args,
      );
      const out = Object.fromEntries(spec.outcomes.map((o) => [o, 0])) as Record<Outcome, number>;
      for (const r of rows) if ((r.outcome as string) in out) out[r.outcome as Outcome] = Number(r.n);
      return out;
    },
    close,
  };
}
