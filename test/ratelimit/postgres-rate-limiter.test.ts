import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createPostgresRateLimiter } from "../../src/ratelimit/postgres-rate-limiter.ts";
import { truncateTables, testDatabaseUrl } from "../support/test-database.ts";

const URL = process.env.DATABASE_URL!;

beforeEach(async () => {
  await truncateTables(URL, ["rate_limit_windows"]);
});

test("Postgres rate limits are shared across instances", async () => {
  const a = createPostgresRateLimiter(URL, { maxPerWindow: 2, windowMs: 60_000 });
  const b = createPostgresRateLimiter(URL, { maxPerWindow: 2, windowMs: 60_000 });
  assert.equal((await a.check("alice")).allowed, true);
  assert.equal((await b.check("alice")).allowed, true);
  assert.equal((await a.check("alice")).allowed, false);
  assert.equal((await b.check("bob")).allowed, true);
});

test("rate limits are principal-scoped and reset after the window", async () => {
  const windowMs = 1_000;
  const limiter = createPostgresRateLimiter(testDatabaseUrl(), { maxPerWindow: 2, windowMs });
  assert.equal((await limiter.check("alice")).allowed, true);
  assert.equal((await limiter.check("alice")).allowed, true);
  assert.equal((await limiter.check("alice")).allowed, false);
  assert.equal((await limiter.check("bob")).allowed, true);
  await sleep(windowMs + 50);
  assert.equal((await limiter.check("alice")).allowed, true);
});
