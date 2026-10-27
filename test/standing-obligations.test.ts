import test from "node:test";
import assert from "node:assert/strict";
import { renderStandingObligations } from "../src/core/orchestrator/prompt-blocks.ts";
import type { Cron } from "../src/types.ts";

test("scheduled work in the prompt is capped with a pointer to the full inventories", () => {
  const crons = Array.from(
    { length: 32 },
    (_, i) =>
      ({
        id: `c${String(i).padStart(2, "0")}`,
        title: `Job ${i}`,
        schedule: { everyMs: 60_000 },
        createdAt: 0,
      }) as unknown as Cron,
  );
  const block = renderStandingObligations(crons, [], []);
  assert.equal(block.split("\n").filter((line) => line.startsWith("- ")).length, 30);
  assert.match(block, /…and 2 more — list crons, webhooks or job watches to see them all\.$/);
});
