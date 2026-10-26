import { randomUUID } from "node:crypto";
import { sleep } from "../util/async.ts";
import { reportFailure, swallow } from "../util/errors.ts";
import type { EventBus } from "../util/event-bus.ts";
import { MAX_PREEMPTIONS, type Run, type RunStop } from "../runs/run-store.ts";
import type { TurnQueue } from "./absurd-schema.ts";
import { parkTurn, runTurn, type HeldTurn, type TurnDeps } from "./turn.ts";

const FALLBACK_POLL_MS = 1_000;
const HANDBACK_SETTLE_MS = 2_000;
const CLAIM_FAIL_REPORT_CONSECUTIVE = 20;

export interface TurnRunnerDeps extends TurnDeps {
  queues: readonly TurnQueue[];
  slots: number;
  capacity?: () => number;
  ready?: EventBus<string>;
  cancels?: EventBus<string>;
  yields?: EventBus<string>;
  canClaim?: () => boolean;
  processId?: string;
  pollMs?: number;
}

export interface TurnRunner {
  start(): void;
  stopClaims(): Promise<void>;
  releaseInFlight(): Promise<void>;
  held(): readonly Run[];
}

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  const processId = deps.processId ?? `h-${randomUUID().slice(0, 8)}`;
  const pollMs = deps.pollMs ?? FALLBACK_POLL_MS;
  const inFlight = new Map<string, HeldTurn>();
  const overcommit = Math.max(1, Math.floor(deps.slots / 4));
  const capacity = (): number => Math.min(deps.slots, deps.capacity?.() ?? deps.slots);
  const mayClaim = (): boolean => !stopped && (!deps.canClaim || deps.canClaim());

  function parkForCapacity(): void {
    const victim = [...inFlight.values()]
      .filter(
        (held) =>
          held.run.absurdQueue === "turns_background" &&
          held.run.preemptions < MAX_PREEMPTIONS &&
          !held.yielding &&
          !held.shutdown.signal.aborted,
      )
      .at(-1);
    if (victim)
      void parkTurn(victim, "capacity", deps).catch((error: unknown) =>
        swallow(`turns: capacity parking failed turn=${victim.run.id}`, error),
      );
  }
  let stopped = true;
  let loopDone: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  let generation = 0;
  const unsubscribe: Array<() => void> = [];

  const notify = (): void => {
    generation++;
    wake?.();
  };

  async function waitForWork(observed: number): Promise<void> {
    if (stopped || observed !== generation) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, pollMs);
      function done(): void {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  }

  function launch(run: Run, token: string): void {
    let settle!: () => void;
    const held: HeldTurn = {
      run,
      token,
      cancel: new AbortController(),
      shutdown: new AbortController(),
      cancelled: false,
      yielding: false,
      done: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      onCancel: () => {
        held.cancelled = true;
      },
    };
    inFlight.set(run.id, held);
    console.log(`[turns] claimed process=${processId} turn=${run.id} thread=${run.sessionId} attempt=${run.attempts}`);
    void runTurn(held, deps)
      .catch((error: unknown) => swallow(`turns: turn ${run.id} crashed`, error))
      .finally(() => {
        inFlight.delete(run.id);
        settle();
        notify();
      });
  }

  async function loop(): Promise<void> {
    let failures = 0;
    while (!stopped) {
      const observed = generation;
      if (deps.canClaim && !deps.canClaim()) {
        await sleep(pollMs);
        continue;
      }
      try {
        for (const queue of deps.queues) {
          while (mayClaim()) {
            const limit = capacity();
            const people = queue === "turns_people";
            if (inFlight.size >= limit + (people ? overcommit : 0)) break;
            const token = `${processId}:${randomUUID()}`;
            const { claimed, run } = await deps.ledger.claim(queue, token, processId);
            if (!claimed) break;
            if (!run) continue;
            if (!mayClaim()) {
              await deps.ledger.handBack(run, token, { unstarted: true });
              break;
            }
            launch(run, token);
            if (people && inFlight.size > limit) parkForCapacity();
          }
        }
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures === CLAIM_FAIL_REPORT_CONSECUTIVE) reportFailure("turns: persistent claim failure", error);
        swallow("turns: claim failed (transient, retrying)", error);
        await sleep(Math.min(pollMs * 2 ** Math.min(failures, 5), 5_000));
        continue;
      }
      await waitForWork(observed);
    }
  }

  async function stopClaims(): Promise<void> {
    stopped = true;
    for (const off of unsubscribe.splice(0)) off();
    notify();
    await loopDone;
  }

  return {
    start() {
      if (loopDone) return;
      stopped = false;
      if (deps.ready) unsubscribe.push(deps.ready.subscribe(notify, { onResync: notify }));
      if (deps.cancels)
        unsubscribe.push(
          deps.cancels.subscribe((turnId) => {
            inFlight.get(turnId)?.onCancel();
          }),
        );
      if (deps.yields)
        unsubscribe.push(
          deps.yields.subscribe((turnId) => {
            const held = inFlight.get(turnId);
            if (held?.run.priority === 2)
              void parkTurn(held, "person", deps).catch((error: unknown) =>
                swallow(`turns: yield to a person failed turn=${turnId}`, error),
              );
          }),
        );
      loopDone = loop().finally(() => {
        loopDone = null;
      });
    },
    stopClaims,
    async releaseInFlight() {
      await stopClaims();
      const held = [...inFlight.values()];
      await Promise.all(
        held.map(async (turn) => {
          turn.shutdown.abort();
          turn.cancel.abort();
          const stop: RunStop = { kind: "shutdown" };
          await deps.ledger
            .handBack(turn.run, turn.token, { stop })
            .catch((error: unknown) =>
              swallow(`turns: shutdown handback failed turn=${turn.run.id}; the claim will expire`, error),
            );
        }),
      );
      await Promise.race([Promise.all(held.map((turn) => turn.done)), sleep(HANDBACK_SETTLE_MS, { unref: true })]);
    },
    held: () => [...inFlight.values()].map((turn) => turn.run),
  };
}
