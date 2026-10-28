import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { baseModelProviders, configuredModel, providerKeysPresent } from "../../src/config.ts";
import { validateWebTurnModelOptions } from "../../src/core/turn-options.ts";
import {
  auxiliaryModelFor,
  auxiliaryModelForProvider,
  defaultModel,
  defaultModelForProvider,
  modelServiceable,
  onlyProvider,
  resolveModel,
  getRequiredModel,
  MODEL_PROVIDERS,
  contextTokenBudgetForModel,
  codexProviderModelId,
  codexSubscriptionModelId,
  modelSupportsFastMode,
  MODEL_REGISTRY,
  FAST_MODE_MODEL_IDS,
  modelSupported,
  safeModelMetadata,
  serviceableModelIds,
  selectableBaseModels,
  defaultWebuiModelIds,
} from "../../src/model/pi-models.ts";
import { buildApp, serverDeps } from "../../src/wiring.ts";
import { stopAtEnd } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { listenLocal } from "../support/listen-local.ts";

test("every selectable base model resolves against the pi-ai registry", () => {
  for (const m of selectableBaseModels()) {
    const model = getRequiredModel(m.id);
    assert.equal(model.id, m.id);
    assert.ok(
      ["anthropic", "openai", "openrouter"].includes(String(model.provider)),
      `${m.id} has unexpected provider ${model.provider}`,
    );
  }
});

test("selectable models span providers (multi-provider is wired)", () => {
  const providers = new Set(selectableBaseModels().map((m) => getRequiredModel(m.id).provider));
  assert.ok(providers.has("anthropic"), "expected at least one Anthropic model");
  assert.ok(providers.has("openai"), "expected at least one OpenAI model (gpt-5.6)");
  assert.ok(providers.has("openrouter"), "expected an OpenRouter-hosted open-model option");
});

test("codex subscription ids stay namespaced inside QM and bare toward the provider", () => {
  assert.equal(codexSubscriptionModelId("gpt-5.6-sol"), "codex/gpt-5.6-sol");
  assert.equal(codexSubscriptionModelId("codex/gpt-5.6-sol"), "codex/gpt-5.6-sol");
  assert.equal(codexProviderModelId("codex/gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(codexProviderModelId("gpt-5.6-sol"), "gpt-5.6-sol");
  const subscription = getRequiredModel("codex/gpt-5.6-sol");
  assert.equal(subscription.id, "codex/gpt-5.6-sol");
  assert.equal(String(subscription.provider), "openai-codex");
  assert.equal(getRequiredModel(codexProviderModelId(subscription.id)).provider, "openai");
});

test("unknown models are not silently accepted", () => {
  assert.equal(resolveModel("claude-not-a-real-model"), undefined);
  assert.throws(() => getRequiredModel("claude-not-a-real-model"), /Unsupported model/);
});

test("the default base model follows the providers a deployment can actually bill", () => {
  for (const provider of MODEL_PROVIDERS) {
    const only = onlyProvider(provider);
    const chosen = defaultModel(undefined, only);
    assert.equal(
      modelServiceable(chosen, only),
      true,
      `a ${provider}-only deployment must default to a model ${provider} can serve, got ${chosen}`,
    );
  }
  assert.equal(defaultModel(undefined, onlyProvider("openrouter")), "openrouter/auto");
  assert.equal(defaultModel(undefined, onlyProvider("openai")), "gpt-5.6-sol");
});

test("provider-blind callers and explicit pins keep the shipped default", () => {
  assert.equal(defaultModel(), "claude-opus-5");
  assert.equal(defaultModel(undefined, onlyProvider("anthropic")), "claude-opus-5");
  assert.equal(
    defaultModel("claude-sonnet-5", onlyProvider("openrouter")),
    "claude-sonnet-5",
    "an explicit pin is never silently swapped — the mismatch is rejected at config load instead",
  );
  assert.equal(
    defaultModel(undefined, { anthropic: false, openai: false, openrouter: false }),
    "claude-opus-5",
    "with no provider at all the shipped default stands rather than an arbitrary pick",
  );
});

test("each provider has a default model", () => {
  assert.equal(defaultModelForProvider("openrouter"), "openrouter/auto");
  assert.equal(defaultModelForProvider("anthropic"), "claude-opus-5");
});

test("the curated catalog contains only current model families", () => {
  assert.deepEqual(
    selectableBaseModels().map((model) => model.id),
    [
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-haiku-5-5",
      "claude-haiku-4-5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-astra",
      "gpt-6-astra-ultrafast",
      "gpt-6.1-sol",
      "gpt-6.1-sol-ultrafast",
      "gpt-6.1-terra",
      "gpt-6-sol",
      "gpt-6-luna",
      "openrouter/auto",
    ],
  );
  assert.equal(getRequiredModel("gpt-5.6-sol").contextWindow, 1_050_000);
  assert.equal(getRequiredModel("gpt-6-astra").contextWindow, 1_050_000);
  assert.equal(getRequiredModel("gpt-6-sol").contextWindow, 1_050_000);
  assert.equal(getRequiredModel("gpt-6-luna").contextWindow, 1_050_000);
  const sol61 = getRequiredModel("gpt-6.1-sol");
  assert.equal(sol61.contextWindow, 1_050_000);
  assert.equal(sol61.maxTokens, 128_000);
  assert.equal(String(sol61.provider), "openai");
  assert.equal(sol61.api, "openai-responses");
  assert.deepEqual(sol61.cost, {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
  });
  assert.equal(sol61.thinkingLevelMap?.off, null);
  assert.equal(sol61.thinkingLevelMap?.minimal, null);
  assert.equal(sol61.thinkingLevelMap?.max, "max");
  assert.equal(modelSupportsFastMode("gpt-6.1-sol"), true);
  assert.equal(contextTokenBudgetForModel("gpt-6.1-sol"), 150_000);
  assert.deepEqual(getRequiredModel("gpt-6-sol").cost, {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
  });
  assert.deepEqual(getRequiredModel("gpt-6-luna").cost, {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [{ inputTokensAbove: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }],
  });
});

test("auxiliary models come from the configured base model's own provider", () => {
  assert.equal(
    auxiliaryModelFor("claude-opus-5"),
    "claude-haiku-5-5",
    "the deployment default resolves an Anthropic auxiliary",
  );
  assert.equal(auxiliaryModelFor("claude-opus-5-5"), "claude-haiku-5-5");
  assert.equal(auxiliaryModelFor("claude-opus-4-8"), "claude-haiku-5-5");
  assert.equal(auxiliaryModelFor("claude-fable-5-1"), "claude-haiku-5-5");
  assert.equal(auxiliaryModelFor("claude-fable-5"), "claude-haiku-5-5");
  assert.equal(
    auxiliaryModelFor("gpt-5.6-sol"),
    "gpt-5.6-luna",
    "an OpenAI deployment gets an OpenAI auxiliary, never Haiku",
  );
  assert.equal(auxiliaryModelFor("gpt-5.6-terra"), "gpt-5.6-luna");
});

test("the Anthropic auxiliary is resolvable by provider, so Anthropic-only surfaces keep working", () => {
  assert.equal(auxiliaryModelForProvider("anthropic"), "claude-haiku-5-5");
  assert.equal(auxiliaryModelForProvider("openai"), "gpt-5.6-luna");
  assert.equal(auxiliaryModelForProvider("nope"), undefined);
});

test("auxiliary selection falls back to the base model when its provider has no cheaper sibling", () => {
  assert.equal(
    auxiliaryModelFor("openrouter/auto"),
    "openrouter/auto",
    "the only OpenRouter entry is its own auxiliary",
  );
  assert.equal(
    auxiliaryModelFor("claude-not-a-real-model"),
    "claude-not-a-real-model",
    "an unresolvable base is returned untouched",
  );
});

test("an auxiliary is never less serviceable than the base model it was derived from", () => {
  const providerSets = [
    { anthropic: true, openai: false, openrouter: false },
    { anthropic: false, openai: true, openrouter: false },
    { anthropic: false, openai: false, openrouter: true },
    { anthropic: false, openai: false, openrouter: false },
  ];
  for (const m of selectableBaseModels()) {
    const auxiliary = auxiliaryModelFor(m.id);
    assert.equal(
      getRequiredModel(auxiliary).provider,
      getRequiredModel(m.id).provider,
      `${m.id} resolved a cross-provider auxiliary (${auxiliary})`,
    );
    for (const providers of providerSets) {
      assert.equal(
        modelServiceable(auxiliary, providers),
        modelServiceable(m.id, providers),
        `${m.id} -> ${auxiliary} changed serviceability under ${JSON.stringify(providers)}`,
      );
    }
  }
});

test("context token budget is half of each model's real input room", () => {
  const fable51 = getRequiredModel("claude-fable-5-1");
  assert.equal(fable51.contextWindow, 1_000_000);
  assert.equal(fable51.maxTokens, 128_000);
  assert.deepEqual(fable51.cost, {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
    tiers: undefined,
  });
  assert.equal(contextTokenBudgetForModel("claude-fable-5-1"), 150_000, "a 1M window is capped, not halved");
  const opus55 = getRequiredModel("claude-opus-5-5");
  assert.equal(opus55.contextWindow, 1_000_000);
  assert.equal(opus55.maxTokens, 128_000);
  assert.equal(String(opus55.provider), "anthropic");
  assert.deepEqual(opus55.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, tiers: undefined });
  assert.equal(contextTokenBudgetForModel("claude-opus-5-5"), 150_000);
  const sonnet55 = getRequiredModel("claude-sonnet-5-5");
  assert.equal(sonnet55.contextWindow, 1_000_000);
  assert.equal(sonnet55.maxTokens, 128_000);
  assert.deepEqual(sonnet55.cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: undefined });
  const haiku55 = getRequiredModel("claude-haiku-5-5");
  assert.equal(haiku55.contextWindow, 1_000_000);
  assert.equal(haiku55.maxTokens, 128_000);
  assert.deepEqual(haiku55.cost, {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
  });
  assert.equal(contextTokenBudgetForModel("claude-haiku-5-5"), 150_000);
  assert.equal(getRequiredModel("claude-fable-5").contextWindow, 1_000_000);
  assert.equal(contextTokenBudgetForModel("claude-fable-5"), 150_000);
  assert.equal(contextTokenBudgetForModel("gpt-5.6-sol"), 150_000);
  assert.equal(contextTokenBudgetForModel("claude-not-a-real-model"), undefined);
  for (const m of selectableBaseModels()) {
    const budget = contextTokenBudgetForModel(m.id);
    assert.ok(budget !== undefined && budget >= 60_000, `${m.id} budget ${budget} suspiciously small`);
    assert.ok(budget <= 150_000, `${m.id} budget ${budget} exceeds the cap`);
  }
});

test("registered OpenAI clones retain exact model identity on the Codex subscription transport", () => {
  for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"]) {
    const api = getRequiredModel(id);
    const subscription = getRequiredModel(codexSubscriptionModelId(id));
    assert.equal(subscription.id, `codex/${id}`);
    assert.equal(subscription.provider, "openai-codex");
    assert.equal(subscription.api, "openai-codex-responses");
    assert.equal(subscription.baseUrl, getRequiredModel("codex/gpt-5.6-sol").baseUrl);
    assert.equal(subscription.contextWindow, api.contextWindow);
    assert.equal(subscription.maxTokens, api.maxTokens);
    assert.deepEqual(subscription.cost, api.cost);
  }
  assert.equal(resolveModel("codex/claude-opus-5"), undefined);
  assert.equal(resolveModel("codex/unregistered-model"), undefined);
});

test("registry model identifiers are unique", () => {
  const ids = MODEL_REGISTRY.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every registry model resolves via pi-ai (nothing offered that turns can't serve)", () => {
  for (const m of MODEL_REGISTRY) {
    assert.ok(resolveModel(m.id), `registry model ${m.id} must resolve`);
  }
});

test("every web-ui-enabled model passes the web-turn model gate (no 403 for an offered model)", () => {
  for (const id of defaultWebuiModelIds()) {
    assert.equal(
      validateWebTurnModelOptions({ model: id }, null),
      null,
      `${id} must not be refused by validateWebTurnModelOptions`,
    );
  }
});

test("regression: gpt-5.6-sol is web-ui-enabled (the reported 403)", () => {
  assert.ok(defaultWebuiModelIds().includes("gpt-5.6-sol"));
  assert.equal(validateWebTurnModelOptions({ model: "gpt-5.6-sol" }, null), null);
});

test("gpt-6-astra is offered with its published context, output ceiling, and rates", () => {
  const model = resolveModel("gpt-6-astra");
  assert.ok(model, "gpt-6-astra must resolve");
  assert.equal(model.provider, "openai");
  assert.equal(model.contextWindow, 1_050_000);
  assert.equal(model.maxTokens, 128_000);
  assert.deepEqual(
    {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  );
  assert.deepEqual((model.cost as { tiers?: unknown }).tiers, [
    { inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
  ]);
  assert.ok(defaultWebuiModelIds().includes("gpt-6-astra"));
  assert.equal(validateWebTurnModelOptions({ model: "gpt-6-astra" }, null), null);
});

test("Opus 5.5 inherits adaptive thinking without off, with its own rates and limits", () => {
  const model = resolveModel("claude-opus-5-5");
  assert.ok(model);
  assert.equal(model.provider, "anthropic");
  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 128_000);
  assert.deepEqual(model.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, tiers: undefined });
  assert.deepEqual(model.thinkingLevelMap, { xhigh: "xhigh", max: "max", off: null });
  assert.deepEqual(model.compat, {
    forceAdaptiveThinking: true,
    supportsTemperature: false,
    supportsStrictTools: true,
  });
  assert.equal(resolveModel("claude-opus-4-8")?.thinkingLevelMap?.off, undefined);
  assert.equal(resolveModel("claude-opus-5")?.thinkingLevelMap?.off, undefined);
  model.thinkingLevelMap!.xhigh = "high";
  assert.equal(resolveModel("claude-opus-5-5")?.thinkingLevelMap?.xhigh, "xhigh");
  assert.equal(resolveModel("claude-opus-4-8")?.thinkingLevelMap?.xhigh, "xhigh");
});

test("Opus 5.5 is selectable with compatible credentials, without changing defaults", () => {
  const id = "claude-opus-5-5";
  assert.ok(selectableBaseModels().some((model) => model.id === id));
  assert.ok(defaultWebuiModelIds().includes(id));
  assert.ok(FAST_MODE_MODEL_IDS.includes(id));
  assert.equal(safeModelMetadata(id)?.label, "Opus 5.5");
  assert.equal(modelSupported(id), true);
  assert.equal(defaultModel(), "claude-opus-5");
  assert.match(
    validateWebTurnModelOptions({ model: id }, null, { anthropic: false, openai: true, openrouter: false }) ?? "",
    /provider isn't configured/,
  );
  assert.equal(
    validateWebTurnModelOptions({ model: id }, null, { anthropic: true, openai: false, openrouter: false }),
    null,
  );
});

test("Sonnet 5.5 never turns thinking off, rejects temperature and fast mode, and leaves defaults alone", () => {
  const id = "claude-sonnet-5-5";
  const model = resolveModel(id);
  assert.ok(model);
  assert.deepEqual(model.thinkingLevelMap, { xhigh: "xhigh", max: "max", off: null });
  assert.equal((model.compat as { supportsTemperature?: boolean }).supportsTemperature, false);
  assert.deepEqual(model.cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: undefined });
  assert.equal(safeModelMetadata(id)?.label, "Sonnet 5.5");
  assert.ok(defaultWebuiModelIds().includes(id));
  assert.ok(!FAST_MODE_MODEL_IDS.includes(id));
  assert.equal(modelSupported(id), true);
  assert.equal(defaultModel(), "claude-opus-5");
});

test("Haiku 5.5 offers every effort, keeps thinking off available, rejects temperature and fast mode, and leaves defaults alone", () => {
  const id = "claude-haiku-5-5";
  const model = resolveModel(id);
  assert.ok(model);
  assert.equal(String(model.provider), "anthropic");
  assert.equal(model.api, "anthropic-messages");
  assert.deepEqual(model.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
  assert.equal((model.compat as { forceAdaptiveThinking?: boolean }).forceAdaptiveThinking, true);
  assert.equal((model.compat as { supportsTemperature?: boolean }).supportsTemperature, false);
  assert.equal(safeModelMetadata(id)?.label, "Haiku 5.5");
  assert.deepEqual(safeModelMetadata(id)?.effortLevels, [
    "auto",
    "default",
    "adaptive",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultracode",
  ]);
  assert.ok(defaultWebuiModelIds().includes(id));
  assert.ok(!FAST_MODE_MODEL_IDS.includes(id));
  assert.equal(modelSupported(id), true);
  assert.equal(defaultModel(), "claude-opus-5");
});

test("FAST_MODE_MODEL_IDS derives from the registry — the web-ui client reads this, keeps no copy", () => {
  assert.deepEqual(
    [...FAST_MODE_MODEL_IDS].sort(),
    MODEL_REGISTRY.filter((m) => m.fastMode)
      .map((m) => m.id)
      .sort(),
  );
  for (const id of FAST_MODE_MODEL_IDS) assert.equal(modelSupportsFastMode(id), true);
});

test("exposure is provider-key-aware: a model whose provider is unconfigured is not serviceable", () => {
  const noOpenai = { anthropic: true, openai: false, openrouter: false };
  assert.equal(modelServiceable("gpt-5.6-sol", noOpenai), false);
  assert.equal(modelServiceable("claude-opus-4-8", noOpenai), true);
  assert.deepEqual(serviceableModelIds(["claude-opus-4-8", "gpt-5.6-sol"], noOpenai), ["claude-opus-4-8"]);
});

test("a company ChatGPT subscription serves OpenAI models that have a subscription alias", () => {
  const subscription = { anthropic: false, openai: false, openrouter: false, codexOAuth: true };
  const apiKey = { anthropic: false, openai: true, openrouter: false };
  assert.equal(modelServiceable("gpt-5.6-sol", subscription), true);
  assert.equal(modelServiceable("codex/gpt-5.6-sol", subscription), true);
  assert.equal(modelServiceable("gpt-6-astra-ultrafast", subscription), false);
  assert.equal(modelServiceable("claude-opus-4-8", subscription), false);
  assert.equal(modelServiceable("gpt-6-astra-ultrafast", apiKey), true);
  assert.equal(modelServiceable("codex/gpt-5.6-sol", apiKey), false);
  assert.equal(modelServiceable("codex/gpt-5.6-sol", { ...apiKey, modelIds: new Set(["codex/gpt-5.6-sol"]) }), true);
});

test("web-turn gate refuses a keyless model cleanly, accepts it once the provider is configured", () => {
  const noOpenai = { anthropic: true, openai: false, openrouter: false };
  const refused = validateWebTurnModelOptions({ model: "gpt-5.6-sol" }, null, noOpenai);
  assert.match(refused ?? "", /provider isn't configured/);
  assert.equal(
    validateWebTurnModelOptions({ model: "gpt-5.6-sol" }, null, { anthropic: true, openai: true, openrouter: false }),
    null,
  );
});

test("fast-mode support is registry-driven", () => {
  assert.equal(modelSupportsFastMode("claude-opus-4-8"), true);
  assert.equal(modelSupportsFastMode("gpt-5.6-sol"), true);
  assert.equal(modelSupportsFastMode(undefined), false);
  assert.equal(modelSupportsFastMode("nonexistent-model"), false);
});

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const MODEL_ID = "unregistered-future-model";

test("unknown builtin-provider model fails resolution and a live runtime selection request", async () => {
  assert.throws(() => getRequiredModel(MODEL_ID), /Unsupported model/);
  const config = testConfig();
  const built = stopAtEnd(
    buildApp(config, {
      modelCredentialFetch: async () => Response.json({ data: [] }),
    }),
  );
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/v1/runtime-config`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        principalId: "admin-alice@default-org",
        scopeId: "personal:admin-alice@default-org",
        modelId: MODEL_ID,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(JSON.stringify(body), /model|supported/);
    console.log(`Baseline: unknown model resolution throws; live runtime selection HTTP ${response.status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function start(overrides: Parameters<typeof testConfig>[0] = { anthropicApiKey: "deployment-anthropic-key" }) {
  const config = testConfig({ ...overrides });
  const built = stopAtEnd(buildApp(config));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    acl: built.acl,
    modelCredentials: built.modelCredentials,
    baseModelDefault: defaultModel(configuredModel(config), baseModelProviders(config)),
    providerKeys: providerKeysPresent(config),
  });
  const base = listenLocal(server);
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function effectiveModel(base: string): Promise<string> {
  const res = await fetch(`${base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { effective: { modelId: string } }).effective.modelId;
}

test("base-model set rejects a model whose provider key is absent (would fail provider-side)", async () => {
  const srv = start();
  try {
    const bad = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "gpt-5.6-sol" }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { message?: string }).message ?? "", /serviceable|provider key/i);

    const ok = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "claude-opus-4-8" }),
    });
    assert.equal(ok.status, 200, "an Anthropic model stays selectable when the Anthropic key is present");
  } finally {
    await srv.close();
  }
});

test("ChatGPT OAuth stays separate from OpenAI API-key availability", () => {
  const config = testConfig({ codexAuthCredential: "company-chatgpt" });
  const configured = providerKeysPresent(config);
  assert.equal(configured.openai, false);
  assert.equal(configured.codexOAuth, true);
});

test("a deployment that declares a provider runs that provider's base model", async () => {
  for (const [modelProvider, key, expected] of [
    ["anthropic", "anthropicApiKey", "claude-opus-5"],
    ["openai", "openaiApiKey", "gpt-5.6-sol"],
    ["openrouter", "openrouterApiKey", "openrouter/auto"],
  ] as const) {
    const srv = start({ modelProvider, [key]: `deployment-${modelProvider}-key` });
    try {
      assert.equal(
        await effectiveModel(srv.base),
        expected,
        `modelProvider "${modelProvider}" must land on a model that provider can bill`,
      );
    } finally {
      await srv.close();
    }
  }
});

test("an undeclared deployment keeps the shipped default, whatever keys it holds", async () => {
  for (const overrides of [{}, { openrouterApiKey: "k" }, { openaiApiKey: "k" }] as const) {
    const srv = start(overrides);
    try {
      assert.equal(
        await effectiveModel(srv.base),
        "claude-opus-5",
        "upgrading must not move an existing deployment's model or its billing",
      );
    } finally {
      await srv.close();
    }
  }
});

test("the declaration outranks a stray key from another vendor", async () => {
  const srv = start({
    modelProvider: "openrouter",
    openrouterApiKey: "deployment-openrouter-key",
    anthropicApiKey: "stray-anthropic-key",
  });
  try {
    assert.equal(await effectiveModel(srv.base), "openrouter/auto");
  } finally {
    await srv.close();
  }
});

test("company ChatGPT-only deployments offer their plain GPT default through managed availability", async () => {
  const srv = start({ codexAuthCredential: "company-chatgpt" });
  try {
    const res = await fetch(`${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      effective: { modelId: string };
      models: string[];
      unavailableReason?: string;
    };
    assert.equal(body.effective.modelId, "gpt-5.6-sol");
    assert.ok(body.models.includes("gpt-5.6-sol"));
    assert.equal(body.unavailableReason, undefined);
  } finally {
    await srv.close();
  }
});

test("gpt-6.1-terra pricing context and fast mode match OpenAI's model page", () => {
  const terra = getRequiredModel("gpt-6.1-terra");
  assert.equal(terra.contextWindow, 1_050_000);
  assert.equal(terra.maxTokens, 128_000);
  assert.equal(modelSupportsFastMode("gpt-6.1-terra"), true);
  assert.deepEqual(
    {
      input: terra.cost.input,
      output: terra.cost.output,
      cacheRead: terra.cost.cacheRead,
      cacheWrite: terra.cost.cacheWrite,
    },
    { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
  );
});
