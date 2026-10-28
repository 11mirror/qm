import type { InstanceRegistry } from "./instance-registry.ts";
import { reportFailureAs } from "../util/errors.ts";

export interface DrainController {
  start(): void;
  stop(): Promise<void>;
  canClaim(): boolean;
}

const DRAIN_SWEEP_MS = 10_000;

export function createDrainController(opts: { registry: InstanceRegistry }): DrainController {
  let superseded = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let beating: Promise<void> = Promise.resolve();
  const beat = async () => {
    const wasSuperseded = superseded;
    superseded = await opts.registry.beat();
    if (superseded !== wasSuperseded) {
      console.error(
        `[drain] ${superseded ? "newer build is live — draining: no new run claims, finishing in-flight turns" : "newer build gone — resuming run claims"}`,
      );
    }
  };
  const tick = () => void (beating = beat().catch(reportFailureAs("deploy-drain", undefined)));
  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, DRAIN_SWEEP_MS);
      timer.unref();
      tick();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await beating;
    },
    canClaim: () => !superseded,
  };
}
