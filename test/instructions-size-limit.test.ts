import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { postInstructions } from "../src/api/routes/surface-config.ts";
import { InstructionsTooLargeError, MAX_INSTRUCTIONS_CHARS } from "../src/resolution/config-store.ts";
import { type ApiCtx, respond } from "../src/api/routes/route.ts";

test("every instructions write path refuses content over the limit with payload_too_large", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "instructions-size-")) }));
  const scope = "personal:U1" as const;
  const tooLong = "x".repeat(MAX_INSTRUCTIONS_CHARS + 1);

  await assert.rejects(built.config.setInstructions(scope, tooLong, "U1"), InstructionsTooLargeError);
  await assert.rejects(built.config.setInstructionsIfVersion(scope, 0, tooLong, "U1"), InstructionsTooLargeError);
  await assert.rejects(built.app.updateInstructions(scope, tooLong, "U1"), InstructionsTooLargeError);

  const out: { status?: number; body?: { error?: string; message?: string } } = {};
  const res = {
    getHeader() {},
    writeHead(status: number) {
      out.status = status;
    },
    end(data?: string) {
      out.body = data ? JSON.parse(data) : undefined;
    },
  };
  await respond(postInstructions, {
    res,
    app: built.app,
    body: { content: tooLong },
    capability: { actorId: "U1", scopeId: scope },
  } as unknown as ApiCtx);
  assert.equal(out.status, 413);
  assert.equal(out.body?.error, "payload_too_large");
  assert.equal(out.body?.message, "instructions must be at most 100000 characters");

  assert.equal(
    await built.app.updateInstructions(scope, "x".repeat(MAX_INSTRUCTIONS_CHARS), "U1"),
    1,
    "the limit itself is allowed",
  );
});
