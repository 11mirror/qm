import { createPostgresEventSink, type EventColumn } from "./scoped-event-sink.ts";
import type { EgressAuditRecord, EgressAuditSink } from "./egress-audit-sink.ts";

const COLUMNS: readonly EventColumn<keyof EgressAuditRecord & string>[] = [
  ["ts", "ts", "number", true],
  ["source", "source", "string", true],
  ["host", "host", "string", true],
  ["allowed", "allowed", "boolean", true],
  ["scope_label", "scopeLabel", "string", true],
  ["port", "port", "number"],
  ["verdict", "verdict", "string"],
  ["via", "via", "string"],
  ["peer_ip", "peerIp", "string"],
  ["principal_id", "principalId", "string"],
];

export function createPostgresEgressAuditSink(connectionString: string): EgressAuditSink {
  return createPostgresEventSink<EgressAuditRecord>({
    connectionString,
    table: "egress_events",
    columns: COLUMNS,
    defaultLimit: 5000,
    equalityFilters: { scopeId: "scope_label", source: "source" },
    persistErrorMessage: "[egress-audit] failed to persist egress decision:",
  });
}
