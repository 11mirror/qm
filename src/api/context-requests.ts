import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";
import type { SurfaceContextRequest, SurfaceContextResult } from "../types.ts";

const CONTEXT_REQUESTS: TableSpec = {
  table: "context_requests",
  key: "id",
  keyIsField: true,
  columns: cols(`source text!, createdAt bigint!, status text!, query jsonb!, result jsonb, error text,
    sealedViewerToken text`),
};

export const CONTEXT_REQUESTS_MIGRATION = mapToTableMigration("api/context-requests/0001-typed", CONTEXT_REQUESTS);

const codec = tableCodec<SurfaceContextRequest>(CONTEXT_REQUESTS);

export type ContextOutcome = { status: "done"; result: SurfaceContextResult } | { status: "failed"; error: string };

export function createContextRequests(databaseUrl: string) {
  const { q } = createPgPool(databaseUrl, [CONTEXT_REQUESTS_MIGRATION]);
  return {
    async create(request: SurfaceContextRequest): Promise<void> {
      await q(
        `INSERT INTO context_requests (${codec.columns}) VALUES (${codec.placeholders}) ON CONFLICT DO NOTHING`,
        codec.values(request.id, request),
      );
    },
    async get(id: string): Promise<SurfaceContextRequest | null> {
      return codec.rows(await q(`SELECT ${codec.columns} FROM context_requests WHERE id = $1`, [id]))[0] ?? null;
    },
    async delete(id: string): Promise<void> {
      await q(`DELETE FROM context_requests WHERE id = $1`, [id]);
    },
    async settle(id: string, outcome: ContextOutcome, opts: { unseal: boolean }): Promise<boolean> {
      const rows = await q(
        `UPDATE context_requests SET status = $2, result = COALESCE($3::jsonb, result), error = COALESCE($4, error)
         ${opts.unseal ? ", sealed_viewer_token = NULL" : ""} WHERE id = $1 RETURNING id`,
        [
          id,
          outcome.status,
          outcome.status === "done" ? jsonbStringify(outcome.result) : null,
          outcome.status === "failed" ? pgTextSafe(outcome.error) : null,
        ],
      );
      return rows.length > 0;
    },
    async pending(source: string, createdAfter: number): Promise<SurfaceContextRequest[]> {
      await q(`DELETE FROM context_requests WHERE status = 'pending' AND created_at < $1`, [createdAfter]);
      return codec.rows(
        await q(
          `SELECT ${codec.columns} FROM context_requests
           WHERE source = $1 AND status = 'pending' AND created_at >= $2 ORDER BY created_at, id`,
          [source, createdAfter],
        ),
      );
    },
  };
}

export type ContextRequests = ReturnType<typeof createContextRequests>;
