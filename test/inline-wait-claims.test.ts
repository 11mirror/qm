import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";

const databaseUrl = process.env.DATABASE_URL;

for (const backend of ["memory", "postgres"] as const) {
  test(
    `${backend}: a synchronous turn waiting on a run another worker holds does not poll claims`,
    { skip: backend === "postgres" && !databaseUrl, timeout: 30_000 },
    async () => {
      const built = buildApp(
        testConfig({
          runWaitMs: 5_000,
          ...(backend === "postgres"
            ? {
                databaseUrl: databaseUrl!,
                sessionStore: "postgres" as const,
                runStore: "postgres" as const,
                dataDir: mkdtempSync(join(tmpdir(), "inline-wait-")),
              }
            : {}),
        }),
      );
      try {
        const request: TurnRequest = {
          surface: "test",
          actor: { externalId: "U1" },
          conversation: { kind: "dm", threadRef: `inline-wait-${randomUUID()}` },
          text: "hello",
          idempotencyKey: `held-${randomUUID()}`,
        };
        const queued = await built.app.turn({ ...request, async: true });
        const held = await built.runs.claimById(queued.runId!, "other-worker", 60_000);
        assert.ok(held?.leaseToken);
        let claims = 0;
        const claimForSession = built.runs.claimForSession.bind(built.runs);
        built.runs.claimForSession = async (...args) => {
          claims += 1;
          return claimForSession(...args);
        };
        const waiting = built.app.turn(request);
        await sleep(500);
        assert.equal(claims, 0);
        await built.runs.complete(held.id, held.leaseToken, { status: "ok", reply: "done elsewhere" });
        const result = await waiting;
        assert.equal(result.status, "ok");
        assert.equal(result.reply, "done elsewhere");
      } finally {
        await built.runtime.stop();
      }
    },
  );
}

test("an edge process leaves a queued run for the harness and waits for its result", { timeout: 30_000 }, async () => {
  const built = buildApp(testConfig({ runWaitMs: 5_000, role: "edge" }));
  try {
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `edge-wait-${randomUUID()}` },
      text: "hello",
      idempotencyKey: `edge-${randomUUID()}`,
    };
    const queued = await built.app.turn({ ...request, async: true });
    let claims = 0;
    const claimForSession = built.runs.claimForSession.bind(built.runs);
    built.runs.claimForSession = async (...args) => {
      claims += 1;
      return claimForSession(...args);
    };
    const waiting = built.app.turn(request);
    await sleep(500);
    assert.equal(claims, 0);
    assert.equal((await built.runs.get(queued.runId!))?.status, "pending");
    const held = await built.runs.claimById(queued.runId!, "harness", 60_000);
    assert.ok(held?.leaseToken);
    await built.runs.complete(held.id, held.leaseToken, { status: "ok", reply: "done by the harness" });
    const result = await waiting;
    assert.equal(result.reply, "done by the harness");
  } finally {
    await built.runtime.stop();
  }
});
