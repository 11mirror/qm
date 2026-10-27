import type { DurableMap } from "../persistence/durable-map.ts";
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

export function createEnvelopeStaging(
  map: DurableMap<StagedEnvelope>,
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
        .putIfAbsent(key, { body, account: opts.account, receivedAt: now(), attempts: 0 })
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
      for (const [key, staged] of await map.entries()) {
        if (staged.receivedAt < at - 24 * 60 * 60_000) {
          await map.delete(key);
          continue;
        }
        if (staged.account !== opts.account) continue;
        if (staged.receivedAt > at - staleAfterMs || (staged.claimedUntil ?? 0) > at) continue;
        if (staged.attempts >= maxAttempts) continue;
        let won = false;
        const claim = { attempts: staged.attempts + 1, claimedUntil: at + 5 * 60_000 };
        const claimed = await map.update(key, (v) => {
          if ((v.claimedUntil ?? 0) > at) return v;
          won = true;
          return { ...v, ...claim };
        });
        if (!claimed || !won) continue;
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
