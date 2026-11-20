import assert from "node:assert/strict";
import { test } from "node:test";
import { coreEmailShared } from "../src/tenant-choice.ts";

test("workspace lookup fallback reports nested network evidence", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void diagnostics.push(args.map(String).join(" ")));
  t.mock.method(globalThis, "fetch", async () =>
    Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND core.internal") })),
  );
  assert.equal(await coreEmailShared("https://core.internal", "secret", "founder@example.test"), false);
  assert.match(diagnostics.join("\n"), /fetch failed.*ENOTFOUND core\.internal/);
});
