import { createPostgresEventSink, type EventColumn } from "./scoped-event-sink.ts";
import type { ErrorEvent, ErrorLog } from "./error-log.ts";

const COLUMNS: readonly EventColumn<keyof ErrorEvent & string>[] = [
  ["ts", "ts", "number", true],
  ["scope_label", "scopeLabel", "string", true],
  ["category", "category", "string", true],
  ["code", "code", "string", true],
  ["message", "message", "string", true],
  ["session_id", "sessionId", "string"],
];

export function createPostgresErrorLog(connectionString: string): ErrorLog {
  return createPostgresEventSink<ErrorEvent>({
    connectionString,
    table: "error_events",
    columns: COLUMNS,
    defaultLimit: 200,
    equalityFilters: { scopeId: "scope_label", sessionId: "session_id" },
    persistErrorMessage: "[errors] failed to persist error event:",
  });
}
