import test from "node:test";
import assert from "node:assert/strict";
import { cleanupAll } from "../../src/util/errors.ts";

test("cleanup failures neither skip later cleanup nor mask the original turn error", async () => {
  const original = new Error("turn failed");
  const calls: string[] = [];
  await assert.rejects(
    cleanupAll(
      [
        () => {
          calls.push("signals");
          throw new Error("signal release failed");
        },
        () => {
          calls.push("persistence");
          throw new Error("persistence drain failed");
        },
        () => {
          calls.push("telemetry");
        },
        () => {
          calls.push("abort");
        },
      ],
      original,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.equal(error.errors[0], original);
      assert.equal(error.errors.length, 3);
      return true;
    },
  );
  assert.deepEqual(calls, ["signals", "persistence", "telemetry", "abort"]);
});
