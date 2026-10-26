import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentDir, readDeploymentState } from "../src/state.ts";

test("a corrupt state.json fails loudly instead of reading as a fresh deployment", () => {
  const home = mkdtempSync(join(tmpdir(), "qm-state-"));
  const prior = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  try {
    assert.equal(readDeploymentState("acme"), undefined, "no state yet");
    mkdirSync(deploymentDir("acme"), { recursive: true });
    writeFileSync(join(deploymentDir("acme"), "state.json"), "{not json");
    assert.throws(() => readDeploymentState("acme"), /state\.json is not valid JSON/);
  } finally {
    if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior;
    rmSync(home, { recursive: true, force: true });
  }
});
