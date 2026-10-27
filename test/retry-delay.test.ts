import { test } from "node:test";
import assert from "node:assert/strict";
import { retryDelay } from "../src/runs/retry-delay.ts";

test("retry delays grow with bounded jitter and stay capped", (t) => {
  for (const random of [0, 0.5, 0.999999]) {
    t.mock.method(Math, "random", () => random);
    for (const [attempt, base] of [
      [0, 15000],
      [1, 30000],
      [2, 60000],
      [100, 60000],
    ]) {
      assert.equal(retryDelay(attempt!), Math.min(60000, Math.round(base! * (1 + random * 0.2))));
    }
    t.mock.restoreAll();
  }
});
