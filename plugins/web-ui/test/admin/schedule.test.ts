import assert from "node:assert/strict";
import test from "node:test";
import { humanCron, shortSchedule } from "../../src/admin/schedule.ts";

test("cron schedules read as plain English where they can", () => {
  assert.equal(humanCron("0 9 * * 1-5"), "weekdays 9:00 AM");
  assert.equal(humanCron("30 * * * *"), "hourly at :30");
  assert.equal(humanCron("0 9 1 * *"), "cron 0 9 1 * *");
  assert.equal(shortSchedule({ everyMs: 900000 }), "every 15m");
});
