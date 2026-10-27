import assert from "node:assert/strict";
import test from "node:test";
import { featureFlags, NAME_RULES, names } from "../scripts/code-ratchets.ts";

const [legacy, mode, flag] = NAME_RULES;

test("legacy identifiers count, legacy inside string literals does not", () => {
  const code = `const legacyRuns = db.where("engine = 'legacy'");\nif (run.engine === 'legacy-runner') LEGACY_SLOTS++;`;
  assert.deepEqual([...names(code, legacy!)], ["legacyRuns", "LEGACY_SLOTS"]);
});

test("mode and flag env names count wherever they appear", () => {
  const config = `SLACK_EVENTS_MODE: "socket"\nprocess.env.DEPLOYMENTS_ENABLED\nENABLE_X=1 DISABLE_Y=1 storage_mode`;
  assert.deepEqual([...names(config, mode!)], ["SLACK_EVENTS_MODE"]);
  assert.deepEqual([...names(config, flag!)], ["DEPLOYMENTS_ENABLED", "ENABLE_X", "DISABLE_Y"]);
});

test("feature flags are the top-level keys of FEATURES", () => {
  const source = `export const FEATURES = {\n  team_scopes: { label: "Team" },\n  ui_canvas: {\n    label: "UI",\n    hint: "x",\n  },\n} as const;\nconst OTHER = {\n  not_a_flag: 1,\n};`;
  assert.deepEqual([...featureFlags(source)], ["team_scopes", "ui_canvas"]);
});
