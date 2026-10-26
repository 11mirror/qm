import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { postSoul } from "../src/api/routes/surface.ts";
import { MAX_SOUL_CHARS, SoulTooLargeError } from "../src/resolution/config-store.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

test("every SOUL write path refuses content over the limit with payload_too_large", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "soul-size-")) }));
  const scope = "personal:U1" as const;
  const tooLong = "x".repeat(MAX_SOUL_CHARS + 1);

  await assert.rejects(built.config.setSoul(scope, tooLong, "U1"), SoulTooLargeError);
  await assert.rejects(built.config.setSoulIfVersion(scope, 0, tooLong, "U1"), SoulTooLargeError);
  await assert.rejects(built.app.updateSoul(scope, tooLong, "U1"), SoulTooLargeError);

  const out: { status?: number; body?: { error?: string } } = {};
  const res = {
    getHeader() {},
    writeHead(status: number) {
      out.status = status;
    },
    end(data?: string) {
      out.body = data ? JSON.parse(data) : undefined;
    },
  };
  await postSoul({
    res,
    app: built.app,
    body: { content: tooLong },
    capability: { actorId: "U1", scopeId: scope },
  } as unknown as ApiCtx);
  assert.equal(out.status, 413);
  assert.equal(out.body?.error, "payload_too_large");

  assert.equal(await built.app.updateSoul(scope, "x".repeat(MAX_SOUL_CHARS), "U1"), 1, "the limit itself is allowed");
});
