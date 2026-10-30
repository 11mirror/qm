import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createInsecureTestServer } from "../src/api/server.ts";
import { modelDisplayName } from "../src/model/pi-models.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { finnyTestStores } from "./support/finny-test-stores.ts";
import { testConfig } from "./support/test-config.ts";

const MODEL = "gpt-5.6-sol";
const SKILLS_DIR = fileURLToPath(new URL("../finny-skills", import.meta.url));
const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function setup() {
  const config = testConfig({
    harness: "pi",
    modelId: MODEL,
    finnyProfile: { id: "finny", modelId: MODEL, skillsDir: SKILLS_DIR },
  });
  const built = buildApp(config, finnyTestStores());
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  server.listen(0);
  return {
    built,
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("Finny runtime endpoints advertise only the pinned Pi model and reject mutations before persistence", async () => {
  const s = setup();
  try {
    await s.built.config.setApprovedHarnesses(["pi", "claude"]);
    const get = await fetch(`${s.base}/v1/runtime-config?principalId=alice&scopeId=personal:alice`);
    assert.equal(get.status, 200);
    const body = (await get.json()) as {
      approvedHarnesses: string[];
      modelsByHarness: Record<string, string[]>;
      effective: { harnessId: string; modelId: string };
    };
    assert.deepEqual(body.approvedHarnesses, ["pi"]);
    assert.deepEqual(body.modelsByHarness, { pi: [MODEL] });
    assert.deepEqual(body.effective, { harnessId: "pi", modelId: MODEL });

    const personal = await fetch(`${s.base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: "alice",
        scopeId: "personal:alice",
        harnessId: "claude",
        modelId: "claude-sonnet-5",
      }),
    });
    assert.equal(personal.status, 400);
    assert.equal(await s.built.config.getRuntimeSelectionDurable("personal:alice"), null);

    const baseModel = await fetch(`${s.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "claude-sonnet-5" }),
    });
    assert.equal(baseModel.status, 400);
    assert.equal(await s.built.config.getRuntimeSelectionDurable("org:default-org"), null);

    const runtime = await fetch(`${s.base}/v1/admin/scopes/org:default-org/runtime`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ harnessId: "claude", modelId: "claude-sonnet-5" }),
    });
    assert.equal(runtime.status, 400);
    assert.equal(await s.built.config.getRuntimeSelectionDurable("org:default-org"), null);
  } finally {
    await s.close();
    await s.built.runtime.stop();
  }
});

test("Finny Slack resolution ignores stored runtimes and refuses nonmatching dispatch choices", async () => {
  const s = setup();
  try {
    await s.built.config.setApprovedHarnesses(["pi", "claude"]);
    await s.built.config.setRuntimeSelection("channel:C1", {
      harnessId: "claude",
      modelId: "claude-sonnet-5",
    });
    assert.deepEqual(await s.built.slackCore.surfaceHeaderFacts("channel:C1"), {
      modelName: modelDisplayName(MODEL),
    });
    const result = await s.built.slackCore.submitTurn({
      actor: { externalId: "alice" },
      conversation: { kind: "channel", threadRef: "slack:C1:1", channelRef: "C1" },
      text: "hello",
      liveActor: true,
      harness: "claude",
      model: "claude-sonnet-5",
    });
    assert.deepEqual(result, { status: "refused", reason: "runtime_constraint_mismatch" });
    assert.equal(await s.built.runs.latestForThread("slack:C1:1"), null);
  } finally {
    await s.close();
    await s.built.runtime.stop();
  }
});

test("Finny steering uses the deployment account despite a durable personal selection", async () => {
  const s = setup();
  try {
    const submitted = await s.built.app.turn({
      surface: "slack",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: "dm:D1:finny-steer" },
      text: "start",
      liveActor: true,
      async: true,
    });
    assert.ok(submitted.runId, JSON.stringify(submitted));
    const queued = await s.built.runs.get(submitted.runId!);
    assert.ok(queued);
    assert.equal(await s.built.runs.withdraw(queued.id, { unstartedOnly: true }), true);
    const persisted = await s.built.runs.enqueue({
      sessionId: queued.sessionId,
      request: { ...queued.request, modelAccount: "openai" },
    });

    const followup = await s.built.app.turn({
      surface: "slack",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: "dm:D1:finny-steer" },
      text: "continue",
      liveActor: true,
      async: true,
    });
    assert.equal(followup.runId, persisted.run.id);
    assert.equal(followup.steered, true);
    assert.equal((await s.built.signals.takePending(persisted.run.id))[0]?.text, "continue");
  } finally {
    await s.close();
    await s.built.runtime.stop();
  }
});
