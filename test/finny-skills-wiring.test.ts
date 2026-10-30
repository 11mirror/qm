import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildApp } from "../src/wiring.ts";
import { finnyTestStores } from "./support/finny-test-stores.ts";
import { testConfig } from "./support/test-config.ts";

function writeFinnySkills(skillsDir: string): { capabilityPath: string; capability: string } {
  const skillDir = join(skillsDir, "finance-proof");
  mkdirSync(skillDir, { recursive: true });
  const body = `---\nname: finance-proof\ndescription: Require cited finance evidence.\n---\n\nOnly use host-verified evidence.\n`;
  writeFileSync(join(skillDir, "SKILL.md"), body);
  writeFileSync(
    join(skillsDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      files: [
        {
          path: "finance-proof/SKILL.md",
          size: Buffer.byteLength(body),
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      ],
    }),
  );
  const capabilitiesDir = join(skillsDir, "capabilities");
  mkdirSync(capabilitiesDir);
  const capabilityPath = join(capabilitiesDir, "synthetic-balance.json");
  const capability = JSON.stringify({
    schemaVersion: 1,
    capabilityId: "synthetic_balance",
    revisionId: "synthetic_balance.v1",
    semanticCapability: "synthetic_balance",
    semanticAliases: [],
    intent: { dimensions: {} },
    dimensions: { required: [], supported: {}, defaults: {} },
    operations: [
      { id: "synthetic_source", dependsOn: [], primitive: "suiteql_select", sql: "SELECT 1 AS value", parameters: [] },
      {
        id: "synthetic_repeat",
        dependsOn: ["synthetic_source"],
        primitive: "repeat_pull",
        operationId: "synthetic_source",
      },
      {
        id: "synthetic_reconciliation",
        dependsOn: ["synthetic_source", "synthetic_repeat"],
        primitive: "reconcile",
        leftField: "value",
        rightField: "value",
        tolerance: "0",
      },
    ],
    resultOperationId: "synthetic_source",
    parameterBindings: {},
    artifactPolicy: { allowedFormats: ["json"], defaultFormat: "json", attachment: "never" },
    approvalPolicy: {
      mode: "before_source",
      binds: ["capability_revision", "dimensions", "operation_graph"],
    },
    verificationPolicy: {
      requiredOperationIds: ["synthetic_repeat", "synthetic_reconciliation"],
      releaseGate: "delivery_eligible",
    },
  });
  writeFileSync(capabilityPath, capability);
  writeFileSync(
    join(capabilitiesDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      classification: "reviewed-finance-capability-pack",
      capabilities: ["synthetic-balance.json"],
      files: [
        {
          path: "synthetic-balance.json",
          size: Buffer.byteLength(capability),
          sha256: createHash("sha256").update(capability).digest("hex"),
        },
      ],
    }),
  );
  return { capabilityPath, capability };
}

test("FINNY_SKILLS_DIR installs reviewed Finny skills into QM's durable skill store", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "finny-skills-wire-"));
  const skillsDir = join(root, "skills");
  writeFinnySkills(skillsDir);
  const built = buildApp(
    testConfig({
      dataDir: join(root, "data"),
      harness: "pi",
      modelId: "gpt-5.6-sol",
      finnyProfile: { id: "finny", modelId: "gpt-5.6-sol", skillsDir },
      pluginSkillDirs: [],
    }),
    finnyTestStores(),
  );
  t.after(() => built.runtime.stop());

  await built.checkReadiness(AbortSignal.timeout(5_000));

  let installed = (await built.skills.list()).find((skill) => skill.manifest.name === "finance-proof");
  for (let attempt = 0; !installed && attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    installed = (await built.skills.list()).find((skill) => skill.manifest.name === "finance-proof");
  }

  assert.ok(installed);
  assert.equal(installed.status, "published");
  assert.equal(installed.createdBy, "system:finny-skills");
  assert.deepEqual(installed.approvals, ["system:finny-skills-reviewer"]);
});

test("Finny readiness rejects a capability pack whose reviewed digest does not match", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "finny-capability-wire-"));
  const skillsDir = join(root, "skills");
  const { capabilityPath, capability } = writeFinnySkills(skillsDir);
  writeFileSync(capabilityPath, `${capability} `);
  const built = buildApp(
    testConfig({
      dataDir: join(root, "data"),
      harness: "pi",
      modelId: "gpt-5.6-sol",
      finnyProfile: { id: "finny", modelId: "gpt-5.6-sol", skillsDir },
      pluginSkillDirs: [],
    }),
    finnyTestStores(),
  );
  t.after(() => built.runtime.stop());

  await assert.rejects(built.checkReadiness(AbortSignal.timeout(5_000)), /capability (?:size|digest) mismatch/i);
});
