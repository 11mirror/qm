import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { tenantCols } from "../persistence/pg-pool.ts";
import { SECURITY_SCREEN_STEP, screenPayloadFromEnvelope } from "../security/security-screen.ts";
import { promptEnvelopeBody } from "./session-store.ts";
import type { LlmRequestRecord, NewLlmRequest, ScreenSample, SessionStore } from "./session-store.ts";

const LLM_CAPTURE_PURGE_BATCH = 100;
const ENVELOPE_TOUCH_MS = 24 * 60 * 60_000;

function rowToLlmRequest(r: Record<string, unknown>): LlmRequestRecord {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    turnSeq: r.turn_seq == null ? null : Number(r.turn_seq),
    step: Number(r.step),
    model: r.model as string,
    scopeLabel: r.scope_label as ScopeId,
    createdAt: Number(r.created_at),
    promptHash: r.prompt_hash == null ? null : (r.prompt_hash as string),
    ...(r.prompt_body != null ? { promptEnvelope: JSON.parse(r.prompt_body as string) } : {}),
    truncated: Boolean(r.truncated),
    ttftMs: r.ttft_ms == null ? null : Number(r.ttft_ms),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    usage: r.usage_json != null ? (JSON.parse(r.usage_json as string) as LlmRequestRecord["usage"]) : null,
    transport:
      r.transport_json != null ? (JSON.parse(r.transport_json as string) as LlmRequestRecord["transport"]) : null,
  };
}

export function createLlmCapture(
  db: Pick<PgPool, "q" | "query">,
  now: () => number,
): Pick<SessionStore, "recordLlmRequest" | "listLlmRequests" | "listScreenSamples" | "purgeLlmCaptures"> {
  const { q, query } = db;
  return {
    async recordLlmRequest(sessionId, rec: NewLlmRequest, signal?: AbortSignal): Promise<LlmRequestRecord> {
      const envelope = promptEnvelopeBody(rec.promptEnvelope);
      if (envelope) {
        await q(
          `INSERT INTO llm_prompt_envelopes(hash, body, created_at) VALUES ($1,$2,$3)
           ON CONFLICT (${tenantCols("hash")}) DO UPDATE SET created_at = EXCLUDED.created_at
            WHERE llm_prompt_envelopes.created_at < EXCLUDED.created_at - ${ENVELOPE_TOUCH_MS}`,
          [envelope.hash, envelope.body, now()],
          { signal },
        );
      }
      const full: LlmRequestRecord = {
        id: randomUUID(),
        sessionId,
        turnSeq: rec.turnSeq,
        step: rec.step,
        model: rec.model,
        scopeLabel: rec.scopeLabel as ScopeId,
        createdAt: now(),
        promptHash: envelope?.hash ?? null,
        ...(rec.promptEnvelope !== undefined ? { promptEnvelope: rec.promptEnvelope } : {}),
        truncated: rec.truncated ?? false,
        ttftMs: rec.ttftMs ?? null,
        durationMs: rec.durationMs ?? null,
        usage: rec.usage ?? null,
        transport: rec.transport ?? null,
      };
      await q(
        "INSERT INTO session_llm_requests(id, session_id, turn_seq, step, model, scope_label, prompt_hash, truncated, created_at, ttft_ms, duration_ms, usage_json, transport_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          full.id,
          full.sessionId,
          full.turnSeq,
          full.step,
          full.model,
          full.scopeLabel,
          full.promptHash,
          full.truncated,
          full.createdAt,
          full.ttftMs,
          full.durationMs,
          full.usage ? JSON.stringify(full.usage) : null,
          full.transport ? JSON.stringify(full.transport) : null,
        ],
        { signal },
      );
      return full;
    },
    async listLlmRequests(sessionId, opts): Promise<LlmRequestRecord[]> {
      const cols = opts?.omitRequest
        ? "r.id, r.session_id, r.turn_seq, r.step, r.model, r.scope_label, r.created_at, r.truncated, r.prompt_hash, r.ttft_ms, r.duration_ms, r.usage_json, r.transport_json"
        : "r.*, e.body AS prompt_body";
      const from = opts?.omitRequest
        ? "session_llm_requests r"
        : "session_llm_requests r LEFT JOIN llm_prompt_envelopes e ON e.hash = r.prompt_hash";
      const conds = ["r.session_id = $1"];
      const args: unknown[] = [sessionId];
      const turnSeqs = opts?.turnSeqs;
      if (turnSeqs) {
        args.push(turnSeqs);
        conds.push(
          opts?.orphans
            ? `(r.turn_seq = ANY($${args.length}) OR r.turn_seq IS NULL)`
            : `r.turn_seq = ANY($${args.length})`,
        );
      } else if (opts?.orphans) {
        conds.push("r.turn_seq IS NULL");
      }
      const rows = await q(
        `SELECT ${cols} FROM ${from} WHERE ${conds.join(" AND ")} ORDER BY r.created_at ASC, r.step ASC`,
        args,
      );
      return rows.map(rowToLlmRequest);
    },
    async listScreenSamples(limit): Promise<ScreenSample[]> {
      const wanted = Math.max(0, Math.trunc(limit));
      const pageSize = Math.max(wanted, 100);
      const samples: ScreenSample[] = [];
      let beforeAt: number | null = null;
      let beforeId: string | null = null;
      while (samples.length < wanted) {
        const rows = await q(
          `SELECT r.id, r.session_id, r.scope_label, r.created_at, r.model, e.body AS prompt_body
             FROM session_llm_requests r JOIN llm_prompt_envelopes e ON e.hash = r.prompt_hash
            WHERE r.step = $1
              AND ($3::bigint IS NULL OR (r.created_at, r.id) < ($3::bigint, $4::text))
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT $2`,
          [SECURITY_SCREEN_STEP, pageSize, beforeAt, beforeId],
        );
        for (const r of rows) {
          const payload = screenPayloadFromEnvelope(JSON.parse(r.prompt_body as string));
          if (!payload) continue;
          samples.push({
            id: r.id as string,
            sessionId: r.session_id as string,
            scopeLabel: r.scope_label as ScopeId,
            createdAt: Number(r.created_at),
            model: r.model as string,
            payload,
          });
          if (samples.length === wanted) return samples;
        }
        if (rows.length < pageSize) break;
        const last = rows.at(-1)!;
        beforeAt = Number(last.created_at);
        beforeId = last.id as string;
      }
      return samples;
    },
    async purgeLlmCaptures(cutoff, opts) {
      const deadline = opts?.deadline ?? Infinity;
      let envelopes = 0;
      while (Date.now() < deadline && !opts?.stop?.()) {
        const deleted = await query(
          `DELETE FROM llm_prompt_envelopes
            WHERE hash IN (SELECT hash FROM llm_prompt_envelopes WHERE created_at < $1
                            ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
              AND created_at < $1`,
          [cutoff, LLM_CAPTURE_PURGE_BATCH],
        );
        envelopes += deleted.rowCount;
        if (deleted.rowCount < LLM_CAPTURE_PURGE_BATCH) break;
      }
      return envelopes;
    },
  };
}
