import { likeContains } from "../persistence/like.ts";
import { createPgPool, withPgTransaction, tenantCols, type PgPool } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { DurableByteStore } from "./durable-byte-store.ts";
import {
  FileArtifactDeletedError,
  clampLimit,
  decodeCursor,
  encodeCursor,
  type FileArtifact,
  type FileArtifactRef,
  type FileArtifactStore,
  type FileDirection,
  type FilePage,
  type FileSource,
  type ListOwnedOptions,
} from "./file-artifact-store.ts";

function rowToArtifact(r: Record<string, unknown>): FileArtifact {
  return {
    id: r.id as string,
    ownerScopeId: r.owner_scope_id as ScopeId,
    createdBy: r.created_by as string,
    name: r.name as string,
    path: r.path as string,
    mimetype: r.mimetype as string,
    sizeBytes: Number(r.size_bytes),
    blobKey: (r.blob_key as string | null) ?? null,
    sha256: (r.sha256 as string | null) ?? null,
    direction: r.direction as FileDirection,
    source: r.source as FileSource,
    ...(r.created_in_scope != null ? { createdInScope: r.created_in_scope as ScopeId } : {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    enabled: r.enabled as boolean,
  };
}

async function listFiles(
  q: PgPool["q"],
  scopes: readonly ScopeId[],
  opts?: ListOwnedOptions,
  sharedRefs?: readonly FileArtifactRef[],
): Promise<FilePage> {
  if (scopes.length === 0 && !sharedRefs?.length) return { files: [] };
  const limit = clampLimit(opts?.limit);
  const cursor = opts?.cursor ? decodeCursor(opts.cursor) : null;
  const params: unknown[] = [scopes as string[]];
  let access = (t: string) => `${t}.owner_scope_id = ANY($1::text[])`;
  if (sharedRefs !== undefined) {
    params.push(
      sharedRefs.map((r) => r.ownerScopeId),
      sharedRefs.map((r) => r.id),
    );
    const own = access;
    access = (t) =>
      `(${own(t)} OR (${t}.enabled = TRUE AND (${t}.owner_scope_id, ${t}.id) IN (SELECT * FROM unnest($2::text[], $3::text[]))))`;
  }
  const filters: Array<(t: string) => string> = [access];
  if (!opts?.includeDisabled) filters.push((t) => `${t}.enabled = TRUE`);
  if (opts?.createdInScope != null) {
    params.push(opts.createdInScope);
    const n = params.length;
    filters.push((t) => `${t}.created_in_scope = $${n}::text`);
  }
  if (opts?.nameQuery != null) {
    params.push(likeContains(opts.nameQuery));
    const n = params.length;
    filters.push((t) => `${t}.name ILIKE $${n}::text ESCAPE '\\'`);
  }
  const visibleTo = (t: string) => filters.map((f) => f(t)).join(" AND ");
  const owned = (t: string) => `(${t}.owner_scope_id = ANY($1::text[]))`;
  const representative =
    sharedRefs === undefined
      ? ""
      : ` AND (f.sha256 IS NULL OR NOT EXISTS (
      SELECT 1 FROM file_artifacts c
      WHERE ${visibleTo("c")}
        AND c.sha256 = f.sha256
        AND COALESCE(c.created_in_scope, c.owner_scope_id) = COALESCE(f.created_in_scope, f.owner_scope_id)
        AND c.id <> f.id
        AND (${owned("c")} > ${owned("f")}
             OR (${owned("c")} = ${owned("f")} AND (c.created_at, c.id) < (f.created_at, f.id)))))`;
  let pageFilter = "";
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    pageFilter = ` AND (f.created_at, f.id) < ($${params.length - 1}::bigint, $${params.length}::text)`;
  }
  params.push(limit + 1);
  const rows = await q(
    `SELECT f.* FROM file_artifacts f WHERE ${visibleTo("f")}${representative}${pageFilter}
    ORDER BY f.created_at DESC, f.id DESC LIMIT $${params.length}`,
    params,
  );
  const all = rows.map(rowToArtifact);
  const files = all.slice(0, limit);
  const nextCursor = all.length > limit && files.length > 0 ? encodeCursor(files[files.length - 1]!) : undefined;
  return { files, ...(nextCursor ? { nextCursor } : {}) };
}

export function createPostgresFileArtifactStore(
  connectionString: string,
  byteStore: DurableByteStore,
): FileArtifactStore {
  const { q, query, pool } = createPgPool(connectionString, [
    {
      id: "files/artifacts/0003",
      statements: [
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS file_artifacts_document
           ON file_artifacts ((COALESCE(created_in_scope, owner_scope_id)), sha256) WHERE sha256 IS NOT NULL`,
      ],
    },
  ]);

  async function getRow(id: string): Promise<FileArtifact | null> {
    const rows = await q("SELECT * FROM file_artifacts WHERE id = $1", [id]);
    return rows.length ? rowToArtifact(rows[0]!) : null;
  }

  return {
    async put(input) {
      const existing = await getRow(input.id);
      if (existing) return { artifact: existing, created: false };

      const { blobKey, sizeBytes, sha256 } = await byteStore.put(
        input.data,
        input.maxBytes != null ? { maxBytes: input.maxBytes } : {},
      );
      return this.publish({ ...input, blobKey, sizeBytes, sha256 });
    },

    async publish(input) {
      const { blobKey, sizeBytes, sha256 } = input;
      const at = input.createdAt ?? Date.now();
      return withPgTransaction(await pool(), async (client) => {
        if (input.reuseExistingPath) {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            `file-path:${input.ownerScopeId}:${input.path}`,
          ]);
          const existing = await client.query(
            "SELECT * FROM file_artifacts WHERE owner_scope_id=$1 AND path=$2 AND enabled=TRUE ORDER BY created_at DESC,id DESC LIMIT 1",
            [input.ownerScopeId, input.path],
          );
          if (existing.rows[0]) return { artifact: rowToArtifact(existing.rows[0]), created: false };
        }
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`file-artifact:${input.id}`]);
        const deleted = await client.query("SELECT id FROM file_artifact_deletions WHERE id=$1", [input.id]);
        if (deleted.rows.length) throw new FileArtifactDeletedError();
        const ins = await client.query(
          `INSERT INTO file_artifacts
           (id, kind, owner_scope_id, path, name, mimetype, size_bytes, blob_key, sha256,
            direction, created_by, created_in_scope, created_at, updated_at, enabled, source)
         VALUES ($1,'file',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,TRUE,'live')
         ON CONFLICT (${tenantCols("id")}) DO NOTHING`,
          [
            input.id,
            input.ownerScopeId,
            input.path,
            input.name,
            input.mimetype,
            sizeBytes,
            blobKey,
            sha256,
            input.direction,
            input.createdBy,
            input.createdInScope ?? null,
            at,
          ],
        );
        const result = await client.query("SELECT * FROM file_artifacts WHERE id=$1", [input.id]);
        return { artifact: rowToArtifact(result.rows[0]), created: (ins.rowCount ?? 0) > 0 };
      });
    },

    async get(id, opts) {
      const r = await getRow(id);
      if (!r) return null;
      if (!r.enabled && !opts?.includeDisabled) return null;
      return r;
    },

    async open(id) {
      const r = await getRow(id);
      if (!r || !r.enabled || !r.blobKey) return null;
      const bytes = await byteStore.open(r.blobKey);
      if (!bytes) return null;
      return { artifact: r, sizeBytes: bytes.sizeBytes, stream: bytes.stream };
    },

    listOwnedByScopes: (scopes, opts) => listFiles(q, scopes, opts),

    listDocuments: (scopes, sharedRefs, opts) => listFiles(q, scopes, opts, sharedRefs),

    async resolveByIds(refs) {
      if (refs.length === 0) return [];
      const owners = refs.map((r) => r.ownerScopeId as string);
      const ids = refs.map((r) => r.id);
      const rows = await q(
        `SELECT * FROM file_artifacts
           WHERE enabled = TRUE
             AND (owner_scope_id, id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
        [owners, ids],
      );
      return rows.map(rowToArtifact);
    },

    async setEnabled(id, enabled) {
      await query("UPDATE file_artifacts SET enabled = $2, updated_at = $3 WHERE id = $1", [id, enabled, Date.now()]);
    },

    async delete(id) {
      await withPgTransaction(await pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`file-artifact:${id}`]);
        await client.query(
          `INSERT INTO file_artifact_deletions(id,deleted_at) VALUES($1,$2) ON CONFLICT (${tenantCols("id")}) DO NOTHING`,
          [id, Date.now()],
        );
        await client.query("DELETE FROM file_artifacts WHERE id=$1", [id]);
      });
    },
  };
}
