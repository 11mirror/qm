import type { TestContext } from "node:test";

export function retryClock(t: TestContext): () => void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  return () => t.mock.timers.tick(60_000);
}
