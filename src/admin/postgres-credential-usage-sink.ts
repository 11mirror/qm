import { createPostgresEventSink, type EventColumn } from "./scoped-event-sink.ts";
import {
  CREDENTIAL_USAGE_WINDOW,
  utcDayStart,
  type CredentialUsageSample,
  type CredentialUsageSink,
} from "./credential-usage-sink.ts";
import { tenantCols } from "../persistence/pg-pool.ts";

const COLUMNS: readonly EventColumn<keyof CredentialUsageSample & string>[] = [
  ["ts", "ts", "number", true],
  ["slug", "slug", "string", true],
  ["host", "host", "string", true],
  ["status", "status", "string", true],
  ["upstream_status", "upstreamStatus", "number"],
  ["scope_label", "scopeLabel", "string", true],
  ["principal_id", "principalId", "string", true],
];

export function createPostgresCredentialUsageSink(connectionString: string): CredentialUsageSink {
  const sink = createPostgresEventSink<CredentialUsageSample>({
    connectionString,
    table: "credential_usage",
    columns: COLUMNS,
    defaultLimit: CREDENTIAL_USAGE_WINDOW,
    equalityFilters: { scopeId: "scope_label", slug: "slug" },
    persistErrorMessage: "[credential-usage] failed to persist broker call:",
  });
  return {
    ...sink,
    async admitDailyCall(slug, cap) {
      const rows = await sink.q(
        `INSERT INTO credential_daily_calls(slug, day, sent) VALUES ($1, $2, 1)
         ON CONFLICT (${tenantCols("slug, day")}) DO UPDATE SET sent = credential_daily_calls.sent + 1
         WHERE credential_daily_calls.sent < $3
         RETURNING sent`,
        [slug, utcDayStart(Date.now()), cap],
      );
      return rows.length > 0;
    },
    async summary(slugs) {
      if (!slugs.length) return [];
      const rows = await sink.q(
        `SELECT requested.slug, summary.*
         FROM unnest($1::text[]) AS requested(slug)
         CROSS JOIN LATERAL (
           WITH recent AS (
             SELECT id, ts, status, principal_id FROM credential_usage
             WHERE slug = requested.slug ORDER BY ts DESC, id DESC LIMIT $2
           )
           SELECT count(*) FILTER (WHERE status = 'ok') AS usage_count,
             count(*) = $2 AS usage_truncated,
             min(ts) FILTER (WHERE status = 'ok') AS usage_since,
             max(ts) FILTER (WHERE status = 'ok') AS last_used_at,
             ARRAY(SELECT principal_id FROM (
               SELECT DISTINCT ON (principal_id) principal_id, ts, id FROM recent WHERE status = 'ok'
               ORDER BY principal_id, ts DESC, id DESC
             ) AS latest ORDER BY ts DESC, id DESC LIMIT 12) AS principals
           FROM recent
         ) AS summary`,
        [[...new Set(slugs)], CREDENTIAL_USAGE_WINDOW],
      );
      return rows.map((row) => ({
        slug: String(row.slug),
        usageCount: Number(row.usage_count),
        usageTruncated: Boolean(row.usage_truncated),
        usageSince: row.usage_since == null ? null : Number(row.usage_since),
        lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
        recentUsagePrincipals: row.principals as string[],
      }));
    },
  };
}
