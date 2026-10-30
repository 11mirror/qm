import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadFinnyKnowledgeIndex } from "../src/finny/knowledge-index.ts";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

test("public Finny knowledge contains only synthetic host-verification guidance", async () => {
  const index = await loadFinnyKnowledgeIndex(resolve("finny-skills"));
  const selected = index.select("host verified finance evidence", { maxChunks: 2, maxChars: 2_000 });

  assert.equal(index.fileCount, 1);
  assert.ok(selected.length > 0);
  assert.equal(
    selected.every((chunk) => chunk.path === "finance-proof/SKILL.md"),
    true,
  );
  assert.match(selected[0]?.content ?? "", /host-verified finance evidence/i);
});

test("reviewed Finny knowledge is indexed by manifest and selected with provenance", async (t) => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "finny-knowledge-")));
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const receipts = [
    "# NetSuite receipts",
    "",
    "Customer receipts use transaction dates and must retain unapplied customer payments separately.",
    "Synthetic legacy-ERP migrated invoices require a reviewed migration-source marker before inclusion.",
  ].join("\n");
  const leases = ["# Lease accounting", "", "Ind AS 116 covers right-of-use assets and lease liabilities."].join("\n");
  await mkdir(join(root, "synthetic-receivables-policy"), { recursive: true });
  await mkdir(join(root, "ind-as-116"), { recursive: true });
  await writeFile(join(root, "synthetic-receivables-policy", "SKILL.md"), receipts);
  await writeFile(join(root, "ind-as-116", "SKILL.md"), leases);
  const helper = "print('reviewed helper, not prompt knowledge')\n";
  await writeFile(join(root, "ind-as-116", "helper.py"), helper);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      classification: "reviewed-finance-knowledge",
      skills: ["synthetic-accounting-policy", "synthetic-receivables-policy"],
      files: [
        { path: "ind-as-116/SKILL.md", size: Buffer.byteLength(leases), sha256: sha256(leases) },
        {
          path: "synthetic-receivables-policy/SKILL.md",
          size: Buffer.byteLength(receipts),
          sha256: sha256(receipts),
        },
        { path: "ind-as-116/helper.py", size: Buffer.byteLength(helper), sha256: sha256(helper) },
      ],
    }),
  );

  const index = await loadFinnyKnowledgeIndex(root);
  const selected = index.select("receipts including synthetic legacy-ERP migrated invoices", {
    maxChunks: 2,
    maxChars: 2_000,
  });

  assert.equal(index.fileCount, 2);
  assert.match(index.bundleDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.path, "synthetic-receivables-policy/SKILL.md");
  assert.match(selected[0]?.content ?? "", /unapplied customer payments/i);
  assert.match(selected[0]?.content ?? "", /migration-source marker/i);
  assert.match(selected[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    selected.some((chunk) => chunk.path.endsWith(".py")),
    false,
  );
});

test("large reviewed documents are selected by relevant section instead of being skipped by the context budget", async (t) => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "finny-knowledge-")));
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const filler = "General accounting controls and review evidence. ".repeat(500);
  const content = `# Finance operations\n\n${filler}\n\n## Synthetic legacy-ERP migrated receipts\n\nUse the reviewed migration-source marker and retain unapplied receipts.\n`;
  await mkdir(join(root, "large-skill"), { recursive: true });
  await writeFile(join(root, "large-skill", "SKILL.md"), content);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      files: [{ path: "large-skill/SKILL.md", size: Buffer.byteLength(content), sha256: sha256(content) }],
    }),
  );

  const index = await loadFinnyKnowledgeIndex(root);
  const selected = index.select("synthetic legacy-ERP migrated receipts", { maxChunks: 2, maxChars: 2_000 });

  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.heading, "Synthetic legacy-ERP migrated receipts");
  assert.match(selected[0]?.content ?? "", /migration-source marker/i);
  assert.ok((selected[0]?.content.length ?? 0) < 2_000);
});

test("knowledge loading rejects files whose reviewed manifest digest does not match", async (t) => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "finny-knowledge-")));
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await mkdir(join(root, "synthetic-intent-policy"), { recursive: true });
  await writeFile(join(root, "synthetic-intent-policy", "SKILL.md"), "# Intent\n\nResolve population first.\n");
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      classification: "reviewed-finance-knowledge",
      skills: ["synthetic-intent-policy"],
      files: [{ path: "synthetic-intent-policy/SKILL.md", size: 36, sha256: "0".repeat(64) }],
    }),
  );

  await assert.rejects(loadFinnyKnowledgeIndex(root), /digest mismatch/i);
});
