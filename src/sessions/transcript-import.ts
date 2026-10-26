import { personalScope } from "../types.ts";
import type { ImportedEntry, SessionStore, TranscriptImport, TranscriptImportResult } from "./session-store.ts";

const ROLES = new Set(["user", "assistant"]);
const MAX_DATE_MS = 8_640_000_000_000_000;

export function parseTranscriptImport(line: string): TranscriptImport {
  const raw = JSON.parse(line) as Record<string, unknown>;
  const principalId = raw.principalId;
  if (typeof principalId !== "string" || !principalId.trim())
    throw new Error("transcript import: principalId is required");
  const threadRef = raw.threadRef;
  if (
    typeof threadRef !== "string" ||
    !threadRef.startsWith(`web:${principalId}:`) ||
    threadRef.length <= principalId.length + 5
  )
    throw new Error("transcript import: threadRef must be a web thread owned by principalId");
  if (raw.title !== undefined && typeof raw.title !== "string")
    throw new Error("transcript import: title must be text");
  if (!Array.isArray(raw.entries) || !raw.entries.length) throw new Error("transcript import: entries are required");
  const scope = personalScope(principalId);
  let previous = -Infinity;
  const entries = raw.entries.map((value: unknown): ImportedEntry => {
    const entry = value as { role?: unknown; text?: unknown; createdAt?: unknown };
    if (typeof entry.role !== "string" || !ROLES.has(entry.role))
      throw new Error("transcript import: entry role must be user or assistant");
    if (typeof entry.text !== "string" || !entry.text.trim())
      throw new Error("transcript import: entry text is required");
    if (
      typeof entry.createdAt !== "number" ||
      !Number.isSafeInteger(entry.createdAt) ||
      entry.createdAt < 0 ||
      entry.createdAt > MAX_DATE_MS ||
      entry.createdAt < previous
    )
      throw new Error("transcript import: entry times must be ascending epoch milliseconds");
    previous = entry.createdAt;
    return entry.role === "user"
      ? {
          type: "user",
          payload: { text: entry.text },
          scopeLabel: scope,
          author: principalId,
          createdAt: entry.createdAt,
        }
      : { type: "assistant", payload: { text: entry.text }, scopeLabel: scope, createdAt: entry.createdAt };
  });
  return {
    threadRef,
    type: "dm",
    scopeId: scope,
    surface: "web",
    principalId,
    ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
    entries,
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
