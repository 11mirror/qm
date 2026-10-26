import { USER_KINDS } from "./items.ts";

/** SQL fragments shared by the session store, its migrations and its reports. */
export const TENANT = "qm_tenant_id()";
export const tsOf = (ms: string): string => `to_timestamp((${ms})::double precision / 1000)`;

/** The per-call spend numbers stored on session_llm_requests, with the usage JSON key each comes from. */
export const SPEND_FIELDS = [
  ["spend_cost_usd", "costUsd", "double precision"],
  ["spend_input", "input", "bigint"],
  ["spend_output", "output", "bigint"],
  ["spend_cache_read", "cacheRead", "bigint"],
  ["spend_cache_write", "cacheWrite", "bigint"],
] as const;
export const spendValue = (usage: string, key: string, type: string): string =>
  `COALESCE((${usage} ->> '${key}')::${type}, 0)`;

/** A user turn that counts as the person speaking (overheard channel messages do not). */
export const userTurn = (col: string): string =>
  `${col}.kind IN ${USER_KINDS} AND NOT (${col}.body @> '{"overheard":true}')`;

/** The [from, to) bounds of a participant window, as OR-groups over seq or (for older rows) time. */
export const participantWindowBounds = (entry: string, participant: string, item = true) => {
  const at = (ms: string): string => (item ? tsOf(ms) : ms);
  return [
    [
      `(${participant}.valid_from_seq IS NOT NULL AND ${entry}.seq >= ${participant}.valid_from_seq)`,
      `(${participant}.valid_from_seq IS NULL AND ${entry}.created_at >= ${at(`${participant}.valid_from`)})`,
    ],
    [
      `(${participant}.valid_to_seq IS NOT NULL AND ${entry}.seq < ${participant}.valid_to_seq)`,
      `(${participant}.valid_to_seq IS NULL AND ${participant}.valid_to IS NOT NULL AND ${entry}.created_at < ${at(`${participant}.valid_to`)})`,
      `(${participant}.valid_to_seq IS NULL AND ${participant}.valid_to IS NULL)`,
    ],
  ] as const;
};

export const withinParticipantWindow = (entry: string, participant: string, item = true): string =>
  participantWindowBounds(entry, participant, item)
    .map((bounds) => `(${bounds.join(" OR ")})`)
    .join(" AND ");
