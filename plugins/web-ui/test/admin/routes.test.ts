import assert from "node:assert/strict";
import test from "node:test";
import { stateToUrl } from "../../src/admin/routes.ts";

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
