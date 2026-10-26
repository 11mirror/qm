import type { ImportedMessage, SessionStore, TranscriptImport, TranscriptImportResult } from "./session-store.ts";

export function parseTranscriptImport(line: string): TranscriptImport {
  const raw = JSON.parse(line) as Record<string, unknown>;
  if (typeof raw.principalId !== "string" || typeof raw.threadRef !== "string")
    throw new Error("transcript import: principalId and threadRef are required");
  if (raw.title !== undefined && typeof raw.title !== "string")
    throw new Error("transcript import: title must be text");
  if (!Array.isArray(raw.entries)) throw new Error("transcript import: entries are required");
  return {
    threadRef: raw.threadRef,
    principalId: raw.principalId,
    ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
    messages: raw.entries as ImportedMessage[],
  };
}

export async function* importTranscripts(
  sessions: Pick<SessionStore, "importTranscript">,
  lines: AsyncIterable<string> | Iterable<string>,
): AsyncGenerator<TranscriptImportResult & { threadRef: string }> {
  for await (const line of lines) {
    if (!line.trim()) continue;
    const spec = parseTranscriptImport(line);
    yield { threadRef: spec.threadRef, ...(await sessions.importTranscript(spec)) };
  }
}
