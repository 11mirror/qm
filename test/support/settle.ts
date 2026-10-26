import type { Scheduler } from "../../src/cron/scheduler.ts";

export async function runNowSettled(scheduler: Scheduler, cronId: string): Promise<void> {
  const r = await scheduler.runNow(cronId);
  if (r.started) await r.settled;
}

export const settle = async (check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition did not hold within ${timeoutMs}ms`, { cause: lastError });
};
