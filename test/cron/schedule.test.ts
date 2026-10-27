import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSchedule, validateUserSchedule } from "../../src/cron/schedule.ts";

const now = Date.UTC(2026, 6, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

test("accepts elapsed-time intervals of a day or longer", () => {
  for (const everyMs of [DAY, 7 * DAY]) {
    const r = normalizeSchedule({ everyMs }, now);
    assert.equal(r.schedule.everyMs, everyMs);
    assert.equal(r.nextFireAt, now + everyMs);
  }
});

test("accepts a sub-minute recurring interval", () => {
  assert.doesNotThrow(() => validateUserSchedule({ everyMs: 1_000 }));
});

test("allows a sub-day polling interval", () => {
  const r = normalizeSchedule({ everyMs: 15 * 60 * 1000 }, now);
  assert.equal(r.schedule.everyMs, 15 * 60 * 1000);
  assert.equal(r.nextFireAt, now + 15 * 60 * 1000);
});

test("allows an interval just under 24h", () => {
  const r = normalizeSchedule({ everyMs: DAY - 1 }, now);
  assert.equal(r.schedule.everyMs, DAY - 1);
});

test("a calendar schedule with timezone is unaffected", () => {
  const r = normalizeSchedule({ cron: "30 7 * * 1-5", timezone: "America/Los_Angeles" }, now);
  assert.equal(r.schedule.cron, "30 7 * * 1-5");
  assert.equal(r.schedule.timezone, "America/Los_Angeles");
  assert.ok(r.nextFireAt && r.nextFireAt > now);
});

test("rejects a one-shot firstFireAt in the past, naming the current clock", () => {
  assert.throws(
    () => validateUserSchedule({ firstFireAt: now - 60 * 60 * 1000 }, now),
    /firstFireAt .* is in the past — it is now 2026-07-01T12:00:00\.000Z/,
  );
});

test("rejects a recurring schedule whose firstFireAt is in the past", () => {
  assert.throws(() => validateUserSchedule({ everyMs: 60_000, firstFireAt: now - DAY }, now), /in the past/);
});

test("a firstFireAt too far back for Date to format still gets the past-time error", () => {
  assert.throws(
    () => validateUserSchedule({ firstFireAt: -9e15 }, now),
    /firstFireAt \(-9000000000000000\) is in the past/,
  );
});

test("defaults the clock to the real now when none is given", () => {
  assert.throws(() => validateUserSchedule({ firstFireAt: 1 }), /in the past/);
});

test('allows a firstFireAt a few seconds ago so a stale-by-one-turn "send now" still works', () => {
  assert.doesNotThrow(() => validateUserSchedule({ firstFireAt: now - 30_000 }, now));
});

test("allows a future firstFireAt", () => {
  assert.doesNotThrow(() => validateUserSchedule({ firstFireAt: now + DAY }, now));
});

test("the past-time check ignores schedules without firstFireAt", () => {
  assert.doesNotThrow(() => validateUserSchedule({ everyMs: 60_000 }, now));
  assert.doesNotThrow(() => validateUserSchedule({ cron: "30 7 * * 1-5", timezone: "America/Los_Angeles" }, now));
});
