import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { stageFinnySkillBundle } from "../scripts/finny-skill-bundle.ts";

async function fixture(): Promise<{ sourceRoot: string; targetRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "finny-skills-"));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  await mkdir(join(sourceRoot, "synthetic-finance-source", "references"), { recursive: true });
  await mkdir(join(sourceRoot, "ignored-skill"), { recursive: true });
  await writeFile(join(sourceRoot, "synthetic-finance-source", "SKILL.md"), "# Synthetic source\n", "utf8");
  await writeFile(join(sourceRoot, "synthetic-finance-source", "references", "rules.json"), '{"b":2,"a":1}\n', "utf8");
  await writeFile(join(sourceRoot, "ignored-skill", "SKILL.md"), "# Ignore me\n", "utf8");
  return { sourceRoot, targetRoot };
}

test("stages only allowlisted skill trees and writes a stable content-addressed manifest", async () => {
  const { sourceRoot, targetRoot } = await fixture();

  const first = await stageFinnySkillBundle({
    sourceRoot,
    targetRoot,
    allowlist: ["synthetic-finance-source"],
    sourceRevision: "synthetic-export-2026-10-30",
    classification: "internal-finance",
  });

  assert.deepEqual(
    first.manifest.files.map((file) => file.path),
    ["synthetic-finance-source/SKILL.md", "synthetic-finance-source/references/rules.json"],
  );
  assert.equal(first.manifest.source.root, sourceRoot);
  assert.equal(first.manifest.source.revision, "synthetic-export-2026-10-30");
  assert.equal(first.manifest.classification, "internal-finance");
  assert.match(first.manifest.files[0]!.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    await readFile(join(targetRoot, "synthetic-finance-source", "SKILL.md"), "utf8"),
    "# Synthetic source\n",
  );
  await assert.rejects(lstat(join(targetRoot, "ignored-skill")));
  assert.equal(await readFile(join(targetRoot, "manifest.json"), "utf8"), first.manifestJson);

  const secondTarget = join(targetRoot, "../target-two");
  const second = await stageFinnySkillBundle({
    sourceRoot,
    targetRoot: secondTarget,
    allowlist: ["synthetic-finance-source"],
    sourceRevision: "synthetic-export-2026-10-30",
    classification: "internal-finance",
  });
  assert.equal(second.manifestJson, first.manifestJson);
});

test("inventory mode reports copy decisions without creating the target", async () => {
  const { sourceRoot, targetRoot } = await fixture();

  const result = await stageFinnySkillBundle({
    sourceRoot,
    targetRoot,
    allowlist: ["synthetic-finance-source"],
    sourceRevision: "rev-1",
    classification: "internal",
    dryRun: true,
  });

  assert.deepEqual(result.decisions, [
    { name: "ignored-skill", decision: "skip", reason: "not_allowlisted" },
    { name: "synthetic-finance-source", decision: "stage", reason: "allowlisted" },
  ]);
  await assert.rejects(lstat(targetRoot));
});

test("rejects credential-like names before reading or copying them", async () => {
  const { sourceRoot, targetRoot } = await fixture();
  const secretPath = join(sourceRoot, "synthetic-finance-source", ".env.production");
  await writeFile(secretPath, "SHOULD_NEVER_BE_EXPOSED=sentinel-value\n", "utf8");
  await chmod(secretPath, 0o000);

  await assert.rejects(
    stageFinnySkillBundle({
      sourceRoot,
      targetRoot,
      allowlist: ["synthetic-finance-source"],
      sourceRevision: "rev-1",
      classification: "internal",
    }),
    (error: Error) => {
      assert.match(error.message, /credential-like filename/i);
      assert.doesNotMatch(error.message, /sentinel-value/);
      return true;
    },
  );
  await assert.rejects(lstat(targetRoot));
});

test("rejects symlinks, executable files, binary content, and invalid allowlist names", async (t) => {
  await t.test("symlink", async () => {
    const { sourceRoot, targetRoot } = await fixture();
    await symlink("/etc/passwd", join(sourceRoot, "synthetic-finance-source", "escape.md"));
    await assert.rejects(
      stageFinnySkillBundle({
        sourceRoot,
        targetRoot,
        allowlist: ["synthetic-finance-source"],
        sourceRevision: "r",
        classification: "c",
      }),
      /symlink/i,
    );
  });

  await t.test("executable", async () => {
    const { sourceRoot, targetRoot } = await fixture();
    const executable = join(sourceRoot, "synthetic-finance-source", "run.sh");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    await assert.rejects(
      stageFinnySkillBundle({
        sourceRoot,
        targetRoot,
        allowlist: ["synthetic-finance-source"],
        sourceRevision: "r",
        classification: "c",
      }),
      /executable/i,
    );
  });

  await t.test("binary", async () => {
    const { sourceRoot, targetRoot } = await fixture();
    await writeFile(join(sourceRoot, "synthetic-finance-source", "payload.dat"), Buffer.from([0x41, 0x01, 0x42]));
    await assert.rejects(
      stageFinnySkillBundle({
        sourceRoot,
        targetRoot,
        allowlist: ["synthetic-finance-source"],
        sourceRevision: "r",
        classification: "c",
      }),
      /binary/i,
    );
  });

  await t.test("path escape and case-folded duplicates", async () => {
    const { sourceRoot, targetRoot } = await fixture();
    await assert.rejects(
      stageFinnySkillBundle({
        sourceRoot,
        targetRoot,
        allowlist: ["../synthetic-finance-source"],
        sourceRevision: "r",
        classification: "c",
      }),
      /skill directory name/i,
    );
    await assert.rejects(
      stageFinnySkillBundle({
        sourceRoot,
        targetRoot,
        allowlist: ["Synthetic-Finance-Source", "synthetic-finance-source"],
        sourceRevision: "r",
        classification: "c",
      }),
      /duplicate/i,
    );
  });
});
