import { isReply, isUserMessage, type Item } from "./items.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";

export interface SharedAttachment {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
}

export interface SharedMessage {
  role: "user" | "assistant";
  text: string;
  attachments?: SharedAttachment[];
}

export interface SessionShare {
  token: string;
  sessionId: string;
  audience: "internal" | "external";
  createdBy: string;
  createdAt: number;
  visibility: { minSeq: number; maxSeq: number; minCreatedAt: number; maxCreatedAt: number };
  messages: SharedMessage[];
  files: Array<SharedAttachment & { blobKey: string }>;
}

const SESSION_SHARES: TableSpec = {
  table: "session_shares",
  key: "token",
  keyIsField: true,
  columns: {
    sessionId: { type: "text", required: true },
    audience: { type: "text", required: true },
    createdBy: { type: "text", required: true },
    createdAt: { type: "bigint", required: true },
    visibility: { type: "jsonb", required: true },
    messages: { type: "jsonb", required: true },
    files: { type: "jsonb", required: true },
  },
};

export const SESSION_SHARES_MIGRATION = mapToTableMigration("sessions/shares/0001-typed", SESSION_SHARES);

const codec = tableCodec<SessionShare>(SESSION_SHARES);

export function createSessionShareStore(databaseUrl: string) {
  const { q } = createPgPool(databaseUrl, [SESSION_SHARES_MIGRATION]);
  return {
    async create(share: SessionShare): Promise<void> {
      await q(
        `INSERT INTO session_shares (${codec.columns}) VALUES (${codec.placeholders}) ON CONFLICT DO NOTHING`,
        codec.values(share.token, share),
      );
    },
    async get(token: string): Promise<SessionShare | null> {
      return codec.rows(await q(`SELECT ${codec.columns} FROM session_shares WHERE token = $1`, [token]))[0] ?? null;
    },
  };
}

export type SessionShareStore = ReturnType<typeof createSessionShareStore>;

interface ProjectedMessage {
  role: "user" | "assistant";
  text: string;
  attachmentIds?: string[];
}

function attachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) =>
    file && typeof file === "object" && typeof file.artifactId === "string" ? [file.artifactId] : [],
  );
}

export function sharedMessages(
  entries: Item[],
  deliveredAttachments: ReadonlyMap<number, string[]> = new Map(),
): ProjectedMessage[] {
  const messages: ProjectedMessage[] = [];
  const posts = new Map<string, string>();
  let posted = false;
  const emit = (role: "user" | "assistant", text: string, files: string[]) => {
    if (!text.trim() && !files.length) return;
    messages.push({ role, text, ...(files.length ? { attachmentIds: [...new Set(files)] } : {}) });
  };
  for (const entry of entries) {
    const body = entry.body;
    if (isUserMessage(entry)) {
      posted = false;
      posts.clear();
      if (entry.hidden || body.overheard) continue;
      const text = typeof body.display === "string" && body.display.trim() ? body.display : entry.text;
      emit("user", text ?? "", attachmentIds(body.attachments));
    } else if (entry.kind === "ToolCall" && body.action === "post") {
      if (entry.callId) posts.set(entry.callId, typeof body.text === "string" ? body.text : "");
    } else if (entry.kind === "ToolResult") {
      const callId = entry.callId ?? "";
      const text = posts.get(callId);
      posts.delete(callId);
      if (entry.isError === true || body.ok === false) continue;
      if (text !== undefined) {
        emit("assistant", text, attachmentIds(body.files));
        posted = true;
      }
    } else if (isReply(entry)) {
      emit("assistant", !posted ? (entry.text ?? "") : "", deliveredAttachments.get(entry.seq) ?? []);
      posted = false;
      posts.clear();
    } else if (entry.kind === "AgentMessage" && entry.variant === "files_delivered") {
      const ids = attachmentIds(body.files);
      const last = messages.at(-1);
      if (ids.length && last?.role === "assistant")
        last.attachmentIds = [...new Set([...(last.attachmentIds ?? []), ...ids])];
      else emit("assistant", "", ids);
    }
  }
  return messages;
}
