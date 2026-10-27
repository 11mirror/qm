import { randomUUID } from "node:crypto";
import type { Monitor } from "../types.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { pgTextSafe } from "../util/text.ts";
import { columnName, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  TRIGGER_COLUMNS,
  type CreateTriggerInput,
} from "../triggers/trigger-store.ts";

interface CreateMonitorInput extends CreateTriggerInput {
  processId: string;
  command: string;
  purpose?: string;
  threadRef: string;
  instructions?: string;
  pattern?: string;
  cursor?: number;
  expiresAt: number;
}

export interface MonitorStore {
  create(input: CreateMonitorInput): Promise<Monitor>;
  get(id: string): Promise<Monitor | null>;
  list(): Promise<Monitor[]>;
  enabled(): Promise<Monitor[]>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  delete(id: string): Promise<void>;
  deleteDefunct(now: number): Promise<number>;
  advance(id: string, fields: { cursor: number; tail?: string; firedAt?: number }): Promise<void>;
  update(id: string, fields: { instructions?: string; pattern?: string; cursor?: number }): Promise<void>;
  recordError(id: string, error: string): Promise<void>;
}

const DEFUNCT_MONITOR_GRACE_MS = 7 * 24 * 60 * 60_000;

const MONITORS: TableSpec = {
  table: "monitors",
  key: "id",
  keyIsField: true,
  columns: {
    ...TRIGGER_COLUMNS,
    processId: { type: "text", required: true },
    command: { type: "text", required: true },
    purpose: { type: "text" },
    threadRef: { type: "text", required: true },
    instructions: { type: "text" },
    pattern: { type: "text" },
    cursor: { type: "bigint", required: true },
    tail: { type: "text" },
    expiresAt: { type: "bigint" },
    lastError: { type: "text" },
  },
};

export const MONITORS_MIGRATION = mapToTableMigration("triggers/monitors/0001-typed", MONITORS);

const codec = tableCodec<Monitor>(MONITORS);

export function createMonitorStore(databaseUrl: string): MonitorStore {
  const { q } = createPgPool(databaseUrl, [MONITORS_MIGRATION]);
  const select = async (where: string, params: unknown[] = []) =>
    codec.rows(await q(`SELECT ${codec.columns} FROM monitors ${where} ORDER BY id`, params));
  const set = async (id: string, fields: Partial<Monitor>) => {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    await q(
      `UPDATE monitors SET ${entries.map(([field], i) => `${columnName(field)} = $${i + 2}`).join(", ")} WHERE id = $1`,
      [id, ...entries.map(([, value]) => (typeof value === "string" ? pgTextSafe(value) : (value ?? null)))],
    );
  };
  return {
    async create(input) {
      assertNoEscalation(input);
      const monitor: Monitor = {
        ...buildTriggerBase(input, randomUUID(), Date.now()),
        processId: input.processId,
        command: input.command,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        threadRef: input.threadRef,
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
        cursor: input.cursor ?? 0,
        expiresAt: input.expiresAt,
      };
      await q(
        `INSERT INTO monitors (${codec.columns}) VALUES (${codec.placeholders})`,
        codec.values(monitor.id, monitor),
      );
      return monitor;
    },
    get: async (id) => (await select(`WHERE id = $1`, [id]))[0] ?? null,
    list: () => select(""),
    enabled: () => select(`WHERE enabled`),
    setEnabled: (id, enabled) => set(id, { enabled }),
    async delete(id) {
      await q(`DELETE FROM monitors WHERE id = $1`, [id]);
    },
    async deleteDefunct(now) {
      const result = await q(
        `DELETE FROM monitors WHERE NOT enabled
           AND GREATEST(COALESCE(expires_at, 0), COALESCE(last_fired_at, 0), created_at) <= $1 RETURNING id`,
        [now - DEFUNCT_MONITOR_GRACE_MS],
      );
      return result.length;
    },
    advance: (id, fields) =>
      set(id, {
        cursor: fields.cursor,
        tail: fields.tail,
        ...(fields.firedAt !== undefined ? { lastFiredAt: fields.firedAt } : {}),
      }),
    update: (id, fields) =>
      set(id, {
        ...(fields.instructions !== undefined ? { instructions: fields.instructions } : {}),
        ...(fields.pattern !== undefined ? { pattern: fields.pattern } : {}),
        ...(fields.cursor !== undefined ? { cursor: fields.cursor, tail: undefined } : {}),
      }),
    recordError: (id, error) => set(id, { lastError: error }),
  };
}
