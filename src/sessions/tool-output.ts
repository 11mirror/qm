import { createHash } from "node:crypto";
import type { DurableByteStore } from "../files/durable-byte-store.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { headSlice, tailSlice } from "../util/text.ts";
import { collectBytes } from "../util/bytes.ts";
import { swallowAs } from "../util/errors.ts";
import { perTenant } from "../tenant.ts";

const TOOL_OUTPUT_SETTING = "tool_result_inline_tokens";
export const DEFAULT_INLINE_TOKENS = 4096;
const CHARS_PER_TOKEN = 4;
export const TOOL_OUTPUT_RETENTION_DAYS = 30;
const TOOL_OUTPUT_RETENTION_MS = TOOL_OUTPUT_RETENTION_DAYS * 24 * 60 * 60_000;
const SETTING_CACHE_MS = 30_000;
const TOOL_OUTPUT_PATH = "tool-output/";
const DIGEST_DIR = "md5/";

export interface ToolOutputRef {
  blob: string;
  chars: number;
  shownChars: number;
}

export interface ParkedOutputKey {
  digest: string;
}

export interface ToolOutputStore {
  inlineTokens(): Promise<number>;
  save(text: string): Promise<string>;
  read(sessionId: string, key: ParkedOutputKey): Promise<{ text: string } | { expired: true } | null>;
}

export function inlineTokensFrom(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_INLINE_TOKENS;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_INLINE_TOKENS;
}

const md5Hex = (text: string): string => createHash("md5").update(text, "utf8").digest("hex");

export function parkedOutputKey(path: string): ParkedOutputKey | null {
  const prefix = `${TOOL_OUTPUT_PATH}${DIGEST_DIR}`;
  if (!path.startsWith(prefix)) return null;
  const digest = path.slice(prefix.length);
  return digest.length === 32 && Buffer.from(digest, "hex").toString("hex") === digest ? { digest } : null;
}

function cutMarker(text: string, head: string, tail: string, kept: string): string {
  return `\n…[output cut: showing the first ${head.length} and last ${tail.length} of ${text.length} chars. ${kept}]…\n`;
}

function headAndTail(text: string, inlineTokens: number): { head: string; tail: string } | null {
  if (inlineTokens <= 0) return null;
  const budget = inlineTokens * CHARS_PER_TOKEN;
  if (text.length <= budget) return null;
  return { head: headSlice(text, Math.floor(budget / 2)), tail: tailSlice(text, Math.floor(budget / 2)) };
}

export function cutToolOutput(
  text: string,
  inlineTokens: number,
  callId: string,
): { text: string; shownChars: number } | null {
  const parts = headAndTail(text, inlineTokens);
  if (!parts) return null;
  const { head, tail } = parts;
  const kept = `The full output is in ${TOOL_OUTPUT_PATH}${DIGEST_DIR}${md5Hex(callId)}; reading it with the files tool copies it onto the computer (kept ${TOOL_OUTPUT_RETENTION_DAYS} days)`;
  return { text: head + cutMarker(text, head, tail, kept) + tail, shownChars: head.length + tail.length };
}

export function cutUnparkedToolOutput(text: string, inlineTokens: number): string {
  const parts = headAndTail(text, inlineTokens);
  if (!parts) return text;
  const { head, tail } = parts;
  const kept =
    "The middle was dropped and the full output was not kept; refetch narrower (filter or paginate the call, or redirect to a file and read it in pieces) if you need it";
  return head + cutMarker(text, head, tail, kept) + tail;
}

export async function parkIfOverCap(
  store: Pick<ToolOutputStore, "inlineTokens" | "save"> | undefined,
  text: string,
  callId: string,
): Promise<{ text: string; inlineTokens: number; output?: ToolOutputRef }> {
  const inlineTokens = store
    ? await store.inlineTokens().catch(swallowAs("tool output: inline cap", DEFAULT_INLINE_TOKENS))
    : DEFAULT_INLINE_TOKENS;
  const cut = cutToolOutput(text, inlineTokens, callId);
  if (!cut) return { text, inlineTokens };
  const blob = store ? await store.save(text).catch(swallowAs("tool output: park full text", null)) : null;
  if (!blob) return { text: cutUnparkedToolOutput(text, inlineTokens), inlineTokens };
  return { text: cut.text, inlineTokens, output: { blob, chars: text.length, shownChars: cut.shownChars } };
}

async function readText(bytes: DurableByteStore, blobKey: string): Promise<string | null> {
  const opened = await bytes.open(blobKey);
  if (!opened) return null;
  const { data } = await collectBytes(opened.stream, {});
  return data.toString("utf8");
}

export function createPostgresToolOutputStore(opts: {
  pool: Pick<PgPool, "q">;
  bytesFor: (prefix: string) => DurableByteStore;
  now?: () => number;
}): ToolOutputStore {
  const now = opts.now ?? (() => Date.now());
  const state = perTenant(() => ({
    setting: null as { value: number; at: number } | null,
    bytes: null as Promise<{ id: string; bytes: DurableByteStore }> | null,
  }));
  const tenantBytes = (): Promise<{ id: string; bytes: DurableByteStore }> => {
    const s = state();
    return (s.bytes ??= opts.pool.q("SELECT qm_tenant_id()::text AS id").then((rows) => {
      const id = rows[0]?.id as string;
      return { id, bytes: opts.bytesFor(`${TOOL_OUTPUT_PATH}${id}/`) };
    })).catch((err: unknown) => {
      s.bytes = null;
      throw err;
    });
  };
  return {
    async inlineTokens() {
      const s = state();
      if (s.setting && now() - s.setting.at < SETTING_CACHE_MS) return s.setting.value;
      const rows = await opts.pool.q("SELECT value FROM qm_settings WHERE key = $1", [TOOL_OUTPUT_SETTING]);
      s.setting = { value: inlineTokensFrom(rows[0]?.value), at: now() };
      return s.setting.value;
    },
    async save(text) {
      const { id, bytes } = await tenantBytes();
      const put = await bytes.put(Buffer.from(text, "utf8"));
      await opts.pool.q(
        `INSERT INTO blobs(tenant_id, sha256, size, mime, storage_key, created_at, expires_at)
         VALUES ($1::uuid, decode($2, 'hex'), $3, 'text/plain; charset=utf-8', $4,
                 to_timestamp($5::double precision / 1000), to_timestamp($6::double precision / 1000))
         ON CONFLICT (tenant_id, sha256) DO NOTHING`,
        [
          id,
          put.sha256,
          put.sizeBytes,
          `${TOOL_OUTPUT_PATH}${id}/${put.blobKey}`,
          now(),
          now() + TOOL_OUTPUT_RETENTION_MS,
        ],
      );
      return put.sha256;
    },
    async read(sessionId, ref) {
      const rows = await opts.pool.q(
        `SELECT b.storage_key, i.created_at <= now() - make_interval(days => $3) AS expired
           FROM items i
      LEFT JOIN blobs b ON b.tenant_id = i.tenant_id AND b.sha256 = i.blob_sha
          WHERE i.tenant_id = qm_tenant_id() AND i.session_id = $1 AND i.kind = 'ToolResult'
            AND md5(i.call_id) = $2 AND i.blob_sha IS NOT NULL`,
        [sessionId, ref.digest, TOOL_OUTPUT_RETENTION_DAYS],
      );
      const row = rows[0];
      if (!row) return null;
      if (row.expired === true) return { expired: true };
      if (typeof row.storage_key !== "string")
        throw new Error(`tool output ${ref.digest}: the result names a parked blob with no blobs row`);
      const { bytes, id } = await tenantBytes();
      const key = String(row.storage_key).slice(`${TOOL_OUTPUT_PATH}${id}/`.length);
      const text = await readText(bytes, key);
      if (text === null)
        throw new Error(`tool output ${ref.digest}: parked bytes ${row.storage_key} are missing from storage`);
      return { text };
    },
  };
}
