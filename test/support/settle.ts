import type { CronStore } from "../../src/cron/cron-store.ts";
import type { Scheduler } from "../../src/cron/scheduler.ts";

export async function fireSettled(
  crons: Pick<CronStore, "listFires">,
  cronId: string,
  fireKey: string,
  timeoutMs?: number,
): Promise<void> {
  await eventually(
    async () => (await crons.listFires(cronId)).runs.find((run) => run.fireKey === fireKey)?.status,
    {
      until: (status) => status !== undefined && status !== "running",
      label: `fire ${fireKey}`,
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  );
}

export async function runNowSettled(
  scheduler: Pick<Scheduler, "runNow">,
  crons: Pick<CronStore, "listFires">,
  cronId: string,
): Promise<void> {
  const r = await scheduler.runNow(cronId);
  if (r.started) await fireSettled(crons, cronId, r.fireKey);
}

export async function eventually<T>(
  read: () => T | Promise<T>,
  opts: { until?: (value: T) => unknown; timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const { until = Boolean, timeoutMs = 15_000, label = "condition" } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await read();
      if (until(value)) return value;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) throw new Error(`${label} did not hold within ${timeoutMs}ms`, { cause: lastError });
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const settle = async (check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  await eventually(check, { timeoutMs });
};
