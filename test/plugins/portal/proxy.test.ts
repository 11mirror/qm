import test from "node:test";
import assert from "node:assert/strict";
import { canonicalPayload, signRequest } from "../../../plugins/chassis/src/source-auth-sign.ts";
import { signedHeaders } from "../../../plugins/chassis/src/core-client.ts";
import { requestPort } from "../../../plugins/portal/src/proxy.ts";

test("portal signs /d/ ingress with the principal as the canonical tail (core-verifiable)", () => {
  const secret = "portal-source-auth-secret";
  const path = "/d/dep-1/assets/app.js?q=a+b%2Fc&n=1";
  const principal = "U00000001";
  const headers = signedHeaders(secret, "GET", path, "", principal);
  const ts = Number(headers["x-timestamp"]);
  assert.equal(headers["x-signature"], signRequest(secret, ts, canonicalPayload("GET", path, principal)));
});

test("portal proxy omits empty URL ports so http.request uses protocol defaults", () => {
  assert.equal(requestPort(new URL("http://qm-web-ui.flycast")), undefined);
  assert.equal(requestPort(new URL("https://qm-web-ui.flycast")), undefined);
  assert.equal(requestPort(new URL("http://qm-web-ui.flycast:8080")), "8080");
});
