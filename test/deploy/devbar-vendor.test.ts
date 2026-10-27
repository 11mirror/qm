import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "../..");

test("the devbar build succeeds and reproduces the vendored bundle", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "devbar-"));
  try {
    await promisify(execFile)(process.execPath, [resolve(root, "scripts/build-app-devbar.mjs"), outDir], { cwd: root });
    for (const name of ["devbar.js", "devbar.css", "LICENSE"]) {
      assert.equal(
        await readFile(join(outDir, name), "utf8"),
        await readFile(resolve(root, "src/deploy/vendor", name), "utf8"),
        `${name} is stale: run npm run build:app-annotations and commit src/deploy/vendor`,
      );
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
