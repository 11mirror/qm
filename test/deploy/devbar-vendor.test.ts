import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "../..");
const vendored = resolve(root, "src/deploy/vendor/devbar.js");

test("the devbar build succeeds and reproduces the vendored bundle", async () => {
  const committed = await readFile(vendored, "utf8");
  try {
    await promisify(execFile)(process.execPath, [resolve(root, "scripts/build-app-devbar.mjs")], { cwd: root });
    assert.equal(
      await readFile(vendored, "utf8"),
      committed,
      "run npm run build:app-annotations and commit the bundle",
    );
  } finally {
    await writeFile(vendored, committed);
  }
});
