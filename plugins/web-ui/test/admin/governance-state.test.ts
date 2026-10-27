import assert from "node:assert/strict";
import test from "node:test";
import { GovernanceState, load, states } from "../../src/admin/governance-state.ts";
import { governanceData } from "../support/admin-governance.ts";

test("governance saves refresh only the saved card", () => {
  load({ orgAmbient: true, autoFlagger: { modelId: "a", rubric: "r" } }, "org:test");
  states.get("org-ambient")!.change("governance-org-ambient", false);
  load({ orgAmbient: true, autoFlagger: { modelId: "a", rubric: "saved" } }, "org:test", "auto-flagger");
  assert.equal(states.get("org-ambient")!.draft.on, false);
  assert.equal(states.get("org-ambient")!.dirty, true);
});

test("the org ambient reply policy collects exactly the toggled value", () => {
  const state = new GovernanceState("org-ambient");
  state.load({ on: true });
  for (const on of [false, true]) {
    state.change("governance-org-ambient", on);
    assert.deepEqual(state.collect(), { on });
  }
});

test("governance disables egress controls when agent computers cannot enforce them", () => {
  load({ egress: {}, egressEnforcement: { active: false } }, "org:test");
  assert.equal(states.get("egress")!.disabled, true);
  load({ egress: {}, egressEnforcement: { active: true } }, "org:test");
  assert.equal(states.get("egress")!.disabled, false);
});

test("egress hides empty host editors", () => {
  const state = new GovernanceState("egress");
  state.load({ allowedHosts: [], deniedHosts: [] });
  assert.equal(state.allowEditor, false);
  assert.equal(state.denyEditor, false);
  state.load({ allowedHosts: ["example.com"], deniedHosts: [] });
  assert.equal(state.allowEditor, true);
  assert.equal(state.denyEditor, false);
});

test("egress validation follows programmatic reloads and successful saves", () => {
  const state = new GovernanceState("egress");
  state.load({ allowedHosts: ["https://invalid"], deniedHosts: [] });
  assert.equal(state.warnings.length, 1);
  state.load({ allowedHosts: ["example.com"], deniedHosts: [] });
  assert.deepEqual(state.warnings, []);
  state.change("egress-deny", "example.com");
  assert.match(state.warnings[0], /both lists/);
});

test("command policy collects its mode and rules", () => {
  const state = new GovernanceState("command-policy");
  state.load({ mode: "allowlist", rules: [{ pattern: "^safe$", decision: "allow" }] });
  assert.deepEqual(state.collect(), { mode: "allowlist", rules: [{ pattern: "^safe$", decision: "allow" }] });
});

test("loading defaults replaces a previous model selection", () => {
  load(governanceData, "org:example");
  const state = states.get("auto-flagger")!;
  state.change("auto-flagger-model", "model-b");
  load(governanceData, "org:example");
  assert.equal(state.draft.modelId, "model-a");
});

test("unavailable configured flagger stays selectable", () => {
  load({ ...governanceData, autoFlagger: { modelId: "saved-model", rubric: "Saved" } }, "org:example");
  const state = states.get("auto-flagger")!;
  assert.equal(state.draft.modelId, "saved-model");
  assert.ok(state.models.some((model) => model.id === "saved-model"));
});

test("flagger is visible only for org payloads that support it", () => {
  load(governanceData, "personal:example");
  assert.equal(states.get("auto-flagger")!.available, false);
  load({}, "org:example");
  assert.equal(states.get("auto-flagger")!.available, false);
});

test("saving an older submitted draft preserves edits made during the request", () => {
  const state = new GovernanceState("org-ambient");
  state.load({ on: true });
  state.change("governance-org-ambient", false);
  const submitted = state.collect();
  state.saving = true;
  state.change("governance-org-ambient", true);
  state.commit(submitted);
  assert.equal(state.draft.on, true);
  assert.equal(state.dirty, true);
  assert.equal(state.message, "Unsaved changes");
});

test("policy validation detects duplicate bots and overlapping hosts", () => {
  const bots = new GovernanceState("ambient-policy");
  bots.load({ bots: { Build: { mode: "ignore" } } });
  bots.bots.push({ id: -1, name: "build", mode: "ignore", hours: "" });
  assert.throws(() => bots.collect(), /Duplicate bot/);
  const egress = new GovernanceState("egress");
  egress.load({ allowedHosts: ["example.com"], deniedHosts: ["example.com"] });
  assert.throws(() => egress.collect(), /both lists/);
});
