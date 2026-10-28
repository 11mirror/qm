import "../../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signRequest } from "../../../plugins/chassis/src/source-auth-sign.ts";
import { createServer } from "../../../src/api/server.ts";
import { buildApp } from "../../support/build-app.ts";
import { testConfig } from "../../support/test-config.ts";
import { createPostgresReplayDedupe } from "../../../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";

const SECRET = "portal-cron-patch-secret".repeat(3);

test("the portal cron PATCH applies edits through the same path as the agent's patchCron", async (t) => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "portal-cron-patch-")) }));
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const cron = await built.app.createCron({
    ownerScopeId: "personal:owner",
    owner: "owner",
    createdBy: "owner",
    title: "Digest",
    action: "summarize",
    schedule: { everyMs: 60_000 },
  });
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const patch = async (body: unknown) => {
    const path = `/v1/crons/${cron.id}?principalId=owner`;
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`${base}${path}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `PATCH\n${path}\n${raw}`),
      },
      body: raw,
    });
    return {
      status: res.status,
      body: (await res.json()) as { cron?: { title?: string; action?: string }; error?: string },
    };
  };

  const edited = await patch({ title: "Morning digest", task: "summarize overnight" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.cron?.title, "Morning digest");
  assert.equal(edited.body.cron?.action, "summarize overnight");

  const updates: string[] = [];
  const updateCron = built.app.updateCron.bind(built.app);
  built.app.updateCron = async (id, p) => (updates.push(id), updateCron(id, p));
  assert.equal((await patch({ title: "Morning digest" })).status, 200);
  assert.deepEqual(updates, [], "an edit that changes nothing writes nothing");

  const grants = await patch({ unattendedGrants: ["admin.crons.read"] });
  assert.equal(grants.status, 400, "unattended grants are refused here instead of silently ignored");
  const session = await patch({ session: true });
  assert.equal(session.status, 400, "the portal has no live conversation to tie the cron to");
  assert.equal((await patch({})).status, 400);
  const typed = await patch({ title: 5 });
  assert.equal(typed.status, 400, "the route's body schema refuses a mistyped field before the handler runs");
  assert.match((typed.body as { message?: string }).message ?? "", /^body\.title: /);
});
