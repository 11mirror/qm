import { USER_KINDS } from "./items.ts";

export const TENANT = "qm_tenant_id()";
export const tsOf = (ms: string): string => `to_timestamp((${ms})::double precision / 1000)`;

export const SPEND_FIELDS = [
  ["spend_cost_usd", "costUsd", "double precision"],
  ["spend_input", "input", "bigint"],
  ["spend_output", "output", "bigint"],
  ["spend_cache_read", "cacheRead", "bigint"],
  ["spend_cache_write", "cacheWrite", "bigint"],
] as const;
export const spendValue = (usage: string, key: string, type: string): string =>
  `COALESCE((${usage} ->> '${key}')::${type}, 0)`;

export const userTurn = (col: string): string =>
  `${col}.kind IN ${USER_KINDS} AND NOT (${col}.body @> '{"overheard":true}')`;

export const withinParticipantWindow = (entry: string, participant: string): string =>
  `(${entry}.seq >= ${participant}.valid_from_seq AND (${participant}.valid_to_seq IS NULL OR ${entry}.seq < ${participant}.valid_to_seq))`;

export const nextSeq = (sessionId: string): string =>
  `GREATEST(COALESCE((SELECT MAX(seq) FROM items WHERE tenant_id = ${TENANT} AND session_id = ${sessionId}), -1) + 1,
            COALESCE((SELECT messages FROM sessions WHERE id = ${sessionId}), 0))`;
