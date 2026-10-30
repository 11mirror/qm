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

test("FINNY_SKILLS_DIR installs reviewed Finny skills into QM's durable skill store", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "finny-skills-wire-"));
  const skillsDir = join(root, "skills");
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
  const built = buildApp(
    testConfig({
      dataDir: join(root, "data"),
      harness: "pi",
      modelId: "gpt-5.6-sol",
      finnyProfile: { id: "finny", modelId: "gpt-5.6-sol", providerTimeoutMs: 120_000, skillsDir },
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
