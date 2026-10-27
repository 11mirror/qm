import assert from "node:assert/strict";
import test from "node:test";
import { firstLine, plural, scopeKind } from "../../src/admin/format.ts";

test("formatters work without an admin controller", () => {
  assert.equal(plural(1, "file"), "1 file");
  assert.equal(plural(1200, "file"), "1,200 files");
  assert.equal(firstLine("\n  first   line \nsecond"), "first line");
  assert.equal(scopeKind("channel:C1"), "channel");
});
