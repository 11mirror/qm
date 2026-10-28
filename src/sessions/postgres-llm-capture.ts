import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import type { LlmRequestRecord, NewLlmRequest, SessionStore } from "./session-store.ts";

const COLUMNS =
  "id, session_id, turn_seq, step, model, scope_label, created_at, ttft_ms, duration_ms, usage_json, transport_json";

function rowToLlmRequest(r: Record<string, unknown>): LlmRequestRecord {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    turnSeq: r.turn_seq == null ? null : Number(r.turn_seq),
    step: Number(r.step),
    model: r.model as string,
    scopeLabel: r.scope_label as ScopeId,
    createdAt: Number(r.created_at),
    ttftMs: r.ttft_ms == null ? null : Number(r.ttft_ms),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    usage: r.usage_json != null ? (JSON.parse(r.usage_json as string) as LlmRequestRecord["usage"]) : null,
    transport:
      r.transport_json != null ? (JSON.parse(r.transport_json as string) as LlmRequestRecord["transport"]) : null,
  };
}

export function createLlmCapture(
  db: Pick<PgPool, "q">,
  now: () => number,
): Pick<SessionStore, "recordLlmRequest" | "listLlmRequests"> {
  const { q } = db;
  return {
    async recordLlmRequest(sessionId, rec: NewLlmRequest, signal?: AbortSignal): Promise<LlmRequestRecord> {
      const full: LlmRequestRecord = {
        id: randomUUID(),
        sessionId,
        turnSeq: rec.turnSeq,
        step: rec.step,
        model: rec.model,
        scopeLabel: rec.scopeLabel as ScopeId,
        createdAt: now(),
        ttftMs: rec.ttftMs ?? null,
        durationMs: rec.durationMs ?? null,
        usage: rec.usage ?? null,
        transport: rec.transport ?? null,
      };
      await q(
        `INSERT INTO session_llm_requests(${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          full.id,
          full.sessionId,
          full.turnSeq,
          full.step,
          full.model,
          full.scopeLabel,
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
      const conds = ["session_id = $1"];
      const args: unknown[] = [sessionId];
      const turnSeqs = opts?.turnSeqs;
      if (turnSeqs) {
        args.push(turnSeqs);
        conds.push(
          opts?.orphans ? `(turn_seq = ANY($${args.length}) OR turn_seq IS NULL)` : `turn_seq = ANY($${args.length})`,
        );
      } else if (opts?.orphans) {
        conds.push("turn_seq IS NULL");
      }
      const rows = await q(
        `SELECT ${COLUMNS} FROM session_llm_requests WHERE ${conds.join(" AND ")} ORDER BY created_at ASC, step ASC`,
        args,
      );
      return rows.map(rowToLlmRequest);
    },
  };
}
