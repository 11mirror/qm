import { test } from "node:test";
import assert from "node:assert/strict";
import { startLeaseKeepalive } from "../../../src/core/orchestrator/turn-lease.ts";
import { wallClockTurnFailure } from "../../../src/harness/pi-turn-clock.ts";
import type { Lease } from "../../../src/sessions/session-store.ts";
import { settle } from "../../support/settle.ts";

const lease: Lease = { sessionId: "s1", token: "t1" };

test("a transient renew failure does not kill the keepalive", async () => {
  let calls = 0;
  const stop = startLeaseKeepalive(
    {
      renewLease: async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset");
        return true;
      },
    },
    lease,
    10,
    () => false,
    () => {},
  );
  await settle(() => calls >= 3);
  stop();
});

test("a genuinely lost lease stops the keepalive and aborts the turn", async () => {
  let calls = 0;
  let lost = 0;
  const stop = startLeaseKeepalive(
    {
      renewLease: async () => {
        calls += 1;
        return false;
      },
    },
    lease,
    10,
    () => false,
    () => lost++,
  );
  await settle(() => lost === 1);
  const after = calls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, after, "no further renewals after the lease is lost");
  assert.equal(lost, 1, "the abort fires exactly once");
  stop();
});

test("an expected release is not reported as a lost lease", async () => {
  let lost = 0;
  let calls = 0;
  const stop = startLeaseKeepalive(
    {
      renewLease: async () => {
        calls += 1;
        return false;
      },
    },
    lease,
    10,
    () => true,
    () => lost++,
  );
  await settle(() => calls === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(lost, 0);
  stop();
});

test("a turn that stays alive on its lease is never aborted, however long it makes no visible progress", async () => {
  let renewals = 0;
  let lost = 0;
  const stop = startLeaseKeepalive(
    {
      renewLease: async () => {
        renewals += 1;
        return true;
      },
    },
    lease,
    2,
    () => false,
    () => lost++,
  );
  await settle(() => renewals >= 40);
  assert.equal(lost, 0);
  stop();
  const after = renewals;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(renewals, after, "stop() ends renewal");
});

test("wall-clock failure survives a cancel only for abandoned turns", () => {
  assert.equal(wallClockTurnFailure("ok", false, false), false);
  assert.equal(wallClockTurnFailure("ok", false, true), false);
  assert.equal(wallClockTurnFailure("aborted", false, false), true);
  assert.equal(wallClockTurnFailure("aborted", true, false), false);
  assert.equal(wallClockTurnFailure("aborted", false, true), false);
  assert.equal(wallClockTurnFailure("abandoned", false, true), true);
  assert.equal(wallClockTurnFailure("abandoned", false, false), true);
});

test("revision lookup failure releases a newly acquired turn lease", async () => {
  const { holdTurnLease } = await import("../../../src/core/orchestrator/turn-lease.ts");
  let released = false;
  const ctx = {
    deps: {
      surfaceCache: {},
      sessions: {
        acquireLease: async () => ({ lease }),
        getContextWindow: async () => {
          throw new Error("revision lookup failed");
        },
        releaseLease: async () => {
          released = true;
        },
      },
    },
    input: { surface: "slack" },
  };
  await assert.rejects(holdTurnLease(ctx as never, { id: "s1" } as never), /revision lookup failed/);
  assert.equal(released, true);
});
