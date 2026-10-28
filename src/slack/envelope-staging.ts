import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import type { AckGate } from "./deferred-ack.ts";

export interface StagedEnvelope {
  body: Record<string, unknown>;
  account: string;
  receivedAt: number;
  attempts: number;
  claimedUntil?: number;
}

export interface EnvelopeStaging {
  keyFor(body: Record<string, unknown>): string | null;
  stage(key: string, body: Record<string, unknown>): Promise<boolean>;
  accepted(key: string): void;
  sweep(replay: (body: Record<string, unknown>, gate: AckGate) => Promise<void>): Promise<number>;
}

export function envelopeKey(account: string, body: Record<string, unknown>): string | null {
  const event = body.event as { type?: string; channel?: string; ts?: string; event_ts?: string } | undefined;
  if (body.type !== "event_callback" || !event?.type || !event.channel) return null;
  const ts = event.ts ?? event.event_ts;
  return ts ? `slack:${account}:${event.type}:${event.channel}:${ts}` : null;
}

const STAGED_ENVELOPES: TableSpec = {
  table: "slack_staged_envelopes",
  key: "id",
  columns: cols(`body jsonb!, account text!, receivedAt bigint!, attempts bigint!, claimedUntil bigint`),
};

export const STAGED_ENVELOPES_MIGRATION = mapToTableMigration("slack/staged-envelopes/0001-typed", STAGED_ENVELOPES);

export function createStagedEnvelopes(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [STAGED_ENVELOPES_MIGRATION]);
  const { insert, delete: remove, codec } = typedTable<StagedEnvelope>(pg, STAGED_ENVELOPES);
  return {
    stage: insert,
    delete: remove,
    async pending(): Promise<boolean> {
      return (await pg.q(`SELECT 1 FROM slack_staged_envelopes LIMIT 1`)).length > 0;
    },
    async deleteReceivedBefore(at: number): Promise<void> {
      await pg.q(`DELETE FROM slack_staged_envelopes WHERE received_at < $1`, [at]);
    },
    async replayable(opts: { account: string; receivedBefore: number; at: number; maxAttempts: number }) {
      const rows = await pg.q(
        `SELECT ${codec.columns} FROM slack_staged_envelopes
         WHERE account = $1 AND received_at <= $2 AND coalesce(claimed_until, 0) <= $3 AND attempts < $4
         ORDER BY received_at, id`,
        [opts.account, opts.receivedBefore, opts.at, opts.maxAttempts],
      );
      return rows.map((r): [string, StagedEnvelope] => [String(r.id), codec.row(r)]);
    },
    async claim(key: string, at: number, claimedUntil: number): Promise<StagedEnvelope | null> {
      const rows = await pg.q(
        `UPDATE slack_staged_envelopes SET attempts = attempts + 1, claimed_until = $3
         WHERE id = $1 AND coalesce(claimed_until, 0) <= $2 RETURNING ${codec.columns}`,
        [key, at, claimedUntil],
      );
      return rows[0] ? codec.row(rows[0]) : null;
    },
  };
}

export type StagedEnvelopes = ReturnType<typeof createStagedEnvelopes>;

export function createEnvelopeStaging(
  map: StagedEnvelopes,
  opts: {
    account: string;
    now?: () => number;
    stageTimeoutMs?: number;
    staleAfterMs?: number;
    maxAttempts?: number;
    replayWaitMs?: number;
  },
): EnvelopeStaging {
  const now = opts.now ?? Date.now;
  const { stageTimeoutMs = 300, staleAfterMs = 3 * 60_000, maxAttempts = 5, replayWaitMs = 10_000 } = opts;
  const inflight = new Map<string, Promise<boolean>>();
  const clear = (key: string): void => {
    void (inflight.get(key) ?? Promise.resolve())
      .then(() => map.delete(key))
      .catch(swallowAs("slack: clear staged envelope", undefined));
  };
  return {
    keyFor: (body) => envelopeKey(opts.account, body),
    async stage(key, body) {
      const write = map
        .stage(key, { body, account: opts.account, receivedAt: now(), attempts: 0 })
        .then(() => true)
        .catch(swallowAs("slack: stage envelope", false));
      inflight.set(key, write);
      void write.finally(() => {
        if (inflight.get(key) === write) inflight.delete(key);
      });
      return Promise.race([write, sleep(stageTimeoutMs, { unref: true }).then(() => false)]);
    },
    accepted: clear,
    async sweep(replay) {
      const at = now();
      let replayed = 0;
      await map.deleteReceivedBefore(at - 24 * 60 * 60_000);
      const candidates = await map.replayable({
        account: opts.account,
        receivedBefore: at - staleAfterMs,
        at,
        maxAttempts,
      });
      for (const [key, staged] of candidates) {
        const claimed = await map.claim(key, at, at + 5 * 60_000);
        if (!claimed) continue;
        if (claimed.attempts >= maxAttempts)
          console.error(
            `[slack-plugin] last replay of staged envelope ${key}; it stays until the daily sweep drops it`,
          );
        replayed++;
        let failed = false;
        const gate: AckGate = {
          persisted: () => clear(key),
          failed: () => {
            failed = true;
          },
        };
        const settled = replay(staged.body, gate)
          .then(() => {
            if (!failed) clear(key);
          })
          .catch(swallowAs(`slack: replay staged envelope ${key}`, undefined));
        await Promise.race([settled, sleep(replayWaitMs, { unref: true })]);
      }
      return replayed;
    },
  };
}
