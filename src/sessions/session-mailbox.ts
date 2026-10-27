import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";

export interface SessionMessage {
  id: string;
  recipientId: string;
  senderId: string;
  actor: OrchestratorInput["actor"];
  text: string;
  sourceEntrySeq?: number;
  audience: OrchestratorInput["conversation"]["audience"];
  createdAt: number;
  consumed?: boolean;
}

const SESSION_MAILBOX: TableSpec = {
  table: "session_mailbox",
  key: "id",
  keyIsField: true,
  columns: cols(`recipientId text!, senderId text!, actor jsonb!, text text!, sourceEntrySeq bigint,
    audience jsonb!, createdAt bigint!, consumed boolean`),
};

export const SESSION_MAILBOX_MIGRATION = mapToTableMigration("sessions/mailbox/0001-typed", SESSION_MAILBOX, {
  statements: [`CREATE INDEX IF NOT EXISTS session_mailbox_recipient ON session_mailbox (recipient_id)`],
});

const codec = tableCodec<SessionMessage>(SESSION_MAILBOX);

export function createSessionMailbox(databaseUrl: string) {
  const { q } = createPgPool(databaseUrl, [SESSION_MAILBOX_MIGRATION]);
  return {
    async send(message: SessionMessage): Promise<void> {
      await q(
        `INSERT INTO session_mailbox (${codec.columns}) VALUES (${codec.placeholders}) ON CONFLICT DO NOTHING`,
        codec.values(message.id, message),
      );
    },
    async pending(recipientId: string): Promise<SessionMessage[]> {
      return codec.rows(
        await q(
          `SELECT ${codec.columns} FROM session_mailbox
           WHERE recipient_id = $1 AND consumed IS NOT TRUE ORDER BY created_at, id`,
          [recipientId],
        ),
      );
    },
    async acknowledge(recipientId: string, ids: string[]): Promise<void> {
      await q(`UPDATE session_mailbox SET consumed = true WHERE recipient_id = $1 AND id = ANY($2::text[])`, [
        recipientId,
        ids,
      ]);
    },
  };
}

export type SessionMailbox = ReturnType<typeof createSessionMailbox>;
