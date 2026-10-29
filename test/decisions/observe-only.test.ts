import { createPostgresDecisionStore } from "../../src/decisions/store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createDecisionHooks } from "../../src/decisions/hooks.ts";
import type { DecisionBackend, DecisionRule } from "../../src/decisions/decisions.ts";

const route: DecisionRule = {
  id: "router",
  hook: "turn_start",
  question: "Need a deeper model?",
  options: {
    keep: { description: "ordinary", action: "keep" },
    deep: { description: "hard", action: "use_runtime", runtime: { modelId: "m-deep" } },
  },
  model: { provider: "gw", model: "main" },
  mode: "enforce",
  onError: "keep",
};

test("separate observe-only classifiers are not launched outside durable execution", async () => {
  const records: { resource?: string }[] = [];
  const release = Promise.withResolvers<void>();
  const backend: DecisionBackend = {
    async choose({ questions, model }) {
      if (model.model === "shadow") await release.promise;
      return Object.fromEntries(Object.keys(questions).map((k) => [k, { keep: 0.2, deep: 0.8 }]));
    },
  };
  const decide = createDecisionHooks(
    {
      rules: async () => [
        route,
        { ...route, id: "shadow", mode: "observe", model: { ...route.model, model: "shadow" } },
      ],
    } as never,
    backend,
    { record: (record: { resource?: string }) => records.push(record) } as never,
  );
  const verdict = await decide("turn_start", "refactor", { scopeLabel: "personal:a", sessionId: "s1" });
  assert.equal(verdict?.ruleId, "router");
  assert.deepEqual(
    records.map((r) => r.resource),
    ["router"],
  );
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    records.map((r) => r.resource),
    ["router"],
  );
});

test("observe rules sharing an enforcing classifier stay in the same awaited request", async () => {
  const records: { resource?: string }[] = [];
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let settled = false;
  const backend: DecisionBackend = {
    async choose({ questions }) {
      calls += 1;
      await release.promise;
      return Object.fromEntries(Object.keys(questions).map((k) => [k, { keep: 0.2, deep: 0.8 }]));
    },
  };
  const decide = createDecisionHooks(
    { rules: async () => [route, { ...route, id: "observer", mode: "observe" }] } as never,
    backend,
    { record: (record: { resource?: string }) => records.push(record) } as never,
  );
  const pending = decide("turn_start", "refactor", { scopeLabel: "personal:a", sessionId: "s1" }).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(calls, 1);
  release.resolve();
  assert.equal((await pending)?.ruleId, "router");
  assert.deepEqual(
    records.map((r) => r.resource),
    ["router", "observer"],
  );
});

test("persisted observe-only rules do not launch detached classifiers or audit unexecuted work", async () => {
  const store = createPostgresDecisionStore(testDatabaseUrl());
  await store.saveProvider({ id: "gw", protocol: "chat-completions" }, { actorId: "admin" });
  await store.saveRule({ ...route, id: "shadow", mode: "observe" }, { actorId: "admin" });
  let calls = 0;
  let records = 0;
  const decide = createDecisionHooks(
    store,
    {
      choose: async () => {
        calls++;
        return {};
      },
    },
    {
      record: () => {
        records++;
      },
    } as never,
  );
  assert.equal(await decide("turn_start", "refactor", { scopeLabel: "personal:a", sessionId: "s1" }), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(records, 0);
});
