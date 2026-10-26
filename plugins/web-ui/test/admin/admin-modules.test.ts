import assert from "node:assert/strict";
import test from "node:test";
import { firstLine, plural, scopeKind } from "../../src/admin/format.ts";
import { humanCron, shortSchedule } from "../../src/admin/schedule.ts";
import { contextSections, sumCacheUsage, isStablePrefixMiss } from "../../src/admin/llm-context.ts";
import { stateToUrl } from "../../src/admin/routes.ts";

test("formatters work without an admin controller", () => {
  assert.equal(plural(1, "file"), "1 file");
  assert.equal(plural(1200, "file"), "1,200 files");
  assert.equal(firstLine("\n  first   line \nsecond"), "first line");
  assert.equal(scopeKind("channel:C1"), "channel");
});

test("cron schedules read as plain English where they can", () => {
  assert.equal(humanCron("0 9 * * 1-5"), "weekdays 9:00 AM");
  assert.equal(humanCron("30 * * * *"), "hourly at :30");
  assert.equal(humanCron("0 9 1 * *"), "cron 0 9 1 * *");
  assert.equal(shortSchedule({ everyMs: 900000 }), "every 15m");
});

test("model context splits a captured request into sections and flags cache misses", () => {
  const sections = contextSections({ system: "rules", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  assert.deepEqual(
    sections.map((s) => s.key),
    ["system", "messages", "params"],
  );
  const usage = sumCacheUsage([{ usage: { cacheRead: 0, cacheWrite: 4000, input: 10 } }]);
  assert.equal(isStablePrefixMiss(usage), true);
});

test("admin state round-trips into settings URLs", () => {
  assert.equal(
    stateToUrl({ view: "history", scope: "channel:C1" }, "/settings"),
    "/settings/history/scopes/channel%3AC1",
  );
  assert.equal(
    stateToUrl({ view: "files", scope: "org:o", own: "1" }, "/settings"),
    "/settings/files?scope=org%3Ao&own=1",
  );
  assert.equal(stateToUrl({ view: "general", scope: "org:o" }, "/settings"), "/settings");
});
