import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const maxFor = (ttl?: string): number => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
  if (ttl === undefined) delete env.PORTAL_SESSION_TTL_S;
  else env.PORTAL_SESSION_TTL_S = ttl;
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import('./src/config.ts').then(m => console.log(m.SESSION_MAX_TTL_S))"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim());
};

test("a session's absolute life is the larger of 30 days and three idle TTLs", () => {
  assert.equal(maxFor(), 2_592_000, "default 7-day TTL keeps the 30-day cap");
  assert.equal(maxFor("604800"), 2_592_000, "a 7-day TTL keeps the 30-day cap");
  assert.equal(maxFor("2592000"), 7_776_000, "a 30-day TTL gets the 90-day cap the fleet configured");
});
