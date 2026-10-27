import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
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

const SESSION_MAILBOX_MIGRATION = mapToTableMigration("sessions/mailbox/0001-typed", SESSION_MAILBOX, {
  statements: [`CREATE INDEX IF NOT EXISTS session_mailbox_recipient ON session_mailbox (recipient_id)`],
});

const SESSION_MAILBOX_UNREAD_MIGRATION = {
  id: "sessions/mailbox/0002-unread",
  statements: [
    `CREATE INDEX IF NOT EXISTS session_mailbox_unread ON session_mailbox (created_at) WHERE consumed IS NOT TRUE`,
  ],
};

export interface MailDelivery {
  wake?: boolean;
}

export function createSessionMailbox(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [SESSION_MAILBOX_MIGRATION, SESSION_MAILBOX_UNREAD_MIGRATION]);
  const { codec, ...table } = typedTable<SessionMessage>(pg, SESSION_MAILBOX);
  const delivered: Array<(recipientId: string) => Promise<void>> = [];
  return {
    onDelivered(listener: (recipientId: string) => Promise<void>): void {
      delivered.push(listener);
    },
    async send(message: SessionMessage, delivery: MailDelivery = {}): Promise<void> {
      await table.insert(message.id, message);
      if (delivery.wake === false) return;
      for (const listener of delivered) await listener(message.recipientId);
    },
    async unreadRecipients(sinceMs: number): Promise<string[]> {
      const rows = await pg.q(
        `SELECT DISTINCT recipient_id FROM session_mailbox WHERE consumed IS NOT TRUE AND created_at >= $1`,
        [sinceMs],
      );
      return rows.map((row) => String(row.recipient_id));
    },
    async pending(recipientId: string): Promise<SessionMessage[]> {
      return codec.rows(
        await pg.q(
          `SELECT ${codec.columns} FROM session_mailbox
           WHERE recipient_id = $1 AND consumed IS NOT TRUE ORDER BY created_at, id`,
          [recipientId],
        ),
      );
    },
    async acknowledge(recipientId: string, ids: string[]): Promise<void> {
      await pg.q(`UPDATE session_mailbox SET consumed = true WHERE recipient_id = $1 AND id = ANY($2::text[])`, [
        recipientId,
        ids,
      ]);
    },
  };
}

export type SessionMailbox = ReturnType<typeof createSessionMailbox>;
