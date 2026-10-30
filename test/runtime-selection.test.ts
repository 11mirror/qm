import { availableRuntimeError, requestedRuntimeError, runtimeConfigBody } from "../src/api/runtime-config.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryConfigStore,
  type PersistedApprovedHarnesses,
  type PersistedBaseModel,
} from "../src/resolution/config-store.ts";
import { resolveRuntimeChoice, resolveRuntimeChoiceDurable } from "../src/harness/harness-router.ts";
import { runtimeConstraintError } from "../src/harness/runtime-types.ts";
import { registerOpenRouterCatalogModel } from "../src/model/pi-models.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const ORG = "org:default-org" as const;
const PERSONAL = "personal:alice" as const;

test("runtime constraints reject only explicit harness or model mismatches", () => {
  const constraint = { harnessId: "pi" as const, modelId: "gpt-5.6-sol" };

  assert.equal(runtimeConstraintError(constraint, {}), null);
  assert.equal(runtimeConstraintError(constraint, { harnessId: "pi" }), null);
  assert.equal(runtimeConstraintError(constraint, { modelId: "gpt-5.6-sol" }), null);
  assert.equal(runtimeConstraintError(constraint, { harnessId: "claude" }), "runtime_constraint_mismatch");
  assert.equal(runtimeConstraintError(constraint, { modelId: "claude-opus-5" }), "runtime_constraint_mismatch");
});

test("runtime selection is sparse, revisioned, and acknowledges a changed org default", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setApprovedHarnesses(["pi", "claude"]);
  await config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  await config.setRuntimeSelection(PERSONAL, { harnessId: "claude", modelId: "claude-sonnet-5" });

  assert.equal(config.getRuntimeSelection(ORG)?.revision, 1);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  await config.setRuntimeSelection(ORG, { harnessId: "claude", modelId: "claude-opus-4-8" });
  assert.equal(config.getRuntimeSelection(ORG)?.revision, 2);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  await config.acknowledgeRuntimeSelection(PERSONAL);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 2);

  await config.setRuntimeSelection(PERSONAL, null);
  assert.equal(config.getRuntimeSelection(PERSONAL), null);
});

test("runtime resolution uses explicit choice, then scope, then org and rejects unapproved requests", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setApprovedHarnesses(["pi", "claude"]);
  await config.setRuntimeSelection(ORG, { harnessId: "claude", modelId: "claude-opus-4-8" });
  await config.setRuntimeSelection(PERSONAL, { harnessId: "pi", modelId: "gpt-5.5" });
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, fallback), { harnessId: "pi", modelId: "gpt-5.5" });
  assert.deepEqual(
    resolveRuntimeChoice(config, ORG, PERSONAL, fallback, { harnessId: "pi", modelId: "claude-sonnet-4-6" }),
    { harnessId: "pi", modelId: "claude-sonnet-4-6" },
  );
  await config.setApprovedHarnesses(["pi"]);
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, PERSONAL, fallback, { harnessId: "claude", modelId: "claude-opus-4-8" }),
    /not approved/,
  );
});

test("runtime resolution carries reasoning and fast-mode defaults into turns", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setApprovedHarnesses(["pi", "claude"]);
  await config.setRuntimeSelection(ORG, {
    harnessId: "pi",
    modelId: "claude-opus-5",
    effortLevel: "high",
    fastMode: true,
  });
  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, { harnessId: "pi", modelId: "claude-fable-5" }), {
    harnessId: "pi",
    modelId: "claude-opus-5",
    effortLevel: "high",
    fastMode: true,
  });
  assert.deepEqual(
    resolveRuntimeChoice(
      config,
      ORG,
      PERSONAL,
      { harnessId: "pi", modelId: "claude-fable-5" },
      {
        harnessId: "pi",
        modelId: "gpt-5.5",
      },
    ),
    {
      harnessId: "pi",
      modelId: "gpt-5.5",
      effortLevel: "high",
      fastMode: false,
    },
  );
  assert.deepEqual(
    resolveRuntimeChoice(
      config,
      ORG,
      PERSONAL,
      { harnessId: "pi", modelId: "claude-fable-5" },
      {
        harnessId: "claude",
        modelId: "claude-opus-5",
      },
    ),
    { harnessId: "claude", modelId: "claude-opus-5", effortLevel: "high", fastMode: true },
  );
});

test("runtime resolution falls back to the first approved harness when deployment defaults are not approved", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setApprovedHarnesses(["claude"]);
  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, { harnessId: "pi", modelId: "gpt-5.6-sol" }), {
    harnessId: "claude",
    modelId: "claude-opus-5",
  });
});

test("runtime resolution reads approvals and selections from shared durable state on every turn", async () => {
  const baseModels = createMemoryMap<PersistedBaseModel>();
  const approvedHarnesses = createMemoryMap<PersistedApprovedHarnesses>();
  const writer = createMemoryConfigStore("default-org", { baseModels, approvedHarnesses });
  const reader = createMemoryConfigStore("default-org", { baseModels, approvedHarnesses });
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

  await writer.setApprovedHarnesses(["pi"]);
  await writer.setRuntimeSelection(ORG, fallback);
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback), fallback);

  await writer.setApprovedHarnesses(["claude"]);
  await writer.setRuntimeSelection(ORG, { harnessId: "claude", modelId: "claude-sonnet-5" });
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback), {
    harnessId: "claude",
    modelId: "claude-sonnet-5",
  });
  await assert.rejects(
    resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback, { harnessId: "pi", modelId: "claude-opus-4-8" }),
    /not approved/,
  );
});

test("every write that changes a scope's served model notifies listeners", async () => {
  const config = createMemoryConfigStore("default-org");
  const seen: string[] = [];
  config.onRuntimeSelectionChanged((id) => seen.push(id));
  await config.setApprovedHarnesses(["pi"]);

  await config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  await config.setRuntimeSelection(PERSONAL, { harnessId: "pi", modelId: "gpt-5.5" });
  await config.setBaseModel(PERSONAL, "gpt-5.6-sol");
  await config.setRuntimeSelection(PERSONAL, null);
  await config.acknowledgeRuntimeSelection(PERSONAL);
  assert.deepEqual(seen, [ORG, PERSONAL, PERSONAL, PERSONAL]);
});

test("a listener that throws cannot break the write that notified it", async () => {
  const config = createMemoryConfigStore("default-org");
  config.onRuntimeSelectionChanged(() => {
    throw new Error("surface unreachable");
  });
  await config.setApprovedHarnesses(["pi"]);
  await config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  assert.equal((await config.getRuntimeSelectionDurable(ORG))?.modelId, "claude-opus-4-8");
});

test("durable runtime resolution hydrates the model catalog before rejecting an unknown dynamic model", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setApprovedHarnesses(["pi"]);
  await config.setRuntimeSelection(PERSONAL, { harnessId: "pi", modelId: "testvendor/cold-router-model" });
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

  assert.deepEqual(await resolveRuntimeChoiceDurable(config, ORG, PERSONAL, fallback), fallback);

  let hydrations = 0;
  const hydrate = async () => {
    hydrations += 1;
    registerOpenRouterCatalogModel({
      id: "testvendor/cold-router-model",
      name: "Cold Router Model",
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      input: ["text"],
      reasoning: true,
      cost: { input: 0, output: 0 },
    });
  };
  assert.deepEqual(await resolveRuntimeChoiceDurable(config, ORG, PERSONAL, fallback, undefined, hydrate), {
    harnessId: "pi",
    modelId: "testvendor/cold-router-model",
  });
  assert.equal(hydrations, 1);

  assert.deepEqual(
    await resolveRuntimeChoiceDurable(
      config,
      ORG,
      PERSONAL,
      fallback,
      { modelId: "testvendor/cold-router-model" },
      hydrate,
    ),
    { harnessId: "pi", modelId: "testvendor/cold-router-model" },
  );

  const before = hydrations;
  await resolveRuntimeChoiceDurable(config, ORG, PERSONAL, fallback, undefined, hydrate);
  assert.equal(hydrations, before);
});

test("explicit runtime validation rejects a revoked scoped model and unsupported fast mode", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setApprovedHarnesses(["pi"]);
  await config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-sonnet-5" });
  await config.setRuntimeSelection(PERSONAL, { harnessId: "pi", modelId: "gpt-6-astra" });
  await config.setWebuiModels(ORG, ["claude-sonnet-5"]);
  const ctx = { deps: { config, harnessId: "pi" } };
  assert.match(
    (await availableRuntimeError(ctx, PERSONAL, { harnessId: "pi", modelId: "gpt-6-astra" }))!,
    /no longer available/,
  );
  assert.equal(
    await availableRuntimeError(ctx, PERSONAL, { harnessId: "pi", modelId: "claude-sonnet-5", fastMode: true }),
    "fast_mode_not_supported",
  );
});

test("runtime availability preserves the existing harness normalization of inherited scheduled effort", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setApprovedHarnesses(["claude"]);
  await config.setWebuiModels(ORG, ["claude-sonnet-5"]);
  const choice = {
    harnessId: "claude" as const,
    modelId: "claude-sonnet-5",
    effortLevel: "ultracode",
    fastMode: false,
  };
  assert.equal(await availableRuntimeError({ deps: { config, harnessId: "claude" } }, PERSONAL, choice), null);
  const resolved = resolveRuntimeChoice(config, ORG, PERSONAL, choice, choice);
  assert.equal(resolved.modelId, choice.modelId);
  assert.equal(resolved.effortLevel, undefined);
});

test("a deployment runtime constraint is the only advertised and effective runtime", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setApprovedHarnesses(["pi", "claude"]);
  await config.setRuntimeSelection(ORG, { harnessId: "claude", modelId: "claude-opus-5" });
  await config.setRuntimeSelection(PERSONAL, { harnessId: "pi", modelId: "gpt-6-astra" });
  await config.setPurposeRuntime("subagent", { harnessId: "claude", modelId: "claude-sonnet-5" });
  const runtimeConstraint = { harnessId: "pi" as const, modelId: "gpt-5.6-sol" };

  const body = await runtimeConfigBody(
    { deps: { config, harnessId: "claude", runtimeConstraint } },
    PERSONAL,
    async () => "account_runtime_unavailable",
    "subagent",
    { effortLevel: "high", fastMode: true },
  );

  assert.deepEqual(body.approvedHarnesses, ["pi"]);
  assert.deepEqual(body.modelsByHarness, { pi: ["gpt-5.6-sol"] });
  assert.deepEqual(Object.keys(body.modelCatalog), ["gpt-5.6-sol"]);
  assert.deepEqual(body.orgDefault, { ...runtimeConstraint, revision: 0 });
  assert.equal(body.scopeOverride, null);
  assert.deepEqual(body.effective, { ...runtimeConstraint, effortLevel: "high", fastMode: true });
});

test("a deployment runtime constraint rejects other runtimes while preserving effort and fast validation", async () => {
  const config = createMemoryConfigStore("default-org");
  const runtimeConstraint = { harnessId: "pi" as const, modelId: "gpt-5.6-sol" };
  const ctx = { deps: { config, runtimeConstraint } };

  assert.equal(
    await availableRuntimeError(ctx, PERSONAL, { harnessId: "claude", modelId: "claude-opus-5" }, "cron"),
    "runtime_constraint_mismatch",
  );
  assert.equal(
    await requestedRuntimeError(ctx, PERSONAL, { modelId: "gpt-6-astra" }, "subagent"),
    "runtime_constraint_mismatch",
  );
  assert.equal(
    await requestedRuntimeError(ctx, PERSONAL, { effortLevel: "impossible" }, "subagent"),
    "effort_not_supported",
  );
  assert.equal(await requestedRuntimeError(ctx, PERSONAL, { effortLevel: "high", fastMode: true }, "subagent"), null);
});
