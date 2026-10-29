import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setEdgeTenants } from "../../chassis/src/tenant-hosts.ts";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
Object.assign(process.env, {
  NODE_ENV: "production",
  AUTH_CLIENT_ID: "deployment-broker",
  AUTH_CLIENT_SECRET: "deployment-client-secret-0123456789",
  AUTH_TOKEN_SECRET: "deployment-token-secret-01234567890",
  AUTH_SIGNING_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
  CORE_SIGNING_SECRET: "deployment-core-secret-012345678901",
});
for (const name of [
  "AUTH_ISSUER",
  "AUTH_REDIRECT_URI",
  "AUTH_ALLOWED_EMAILS",
  "AUTH_ALLOWED_EMAIL_DOMAIN",
  "AUTH_EMAIL_FROM",
  "RESEND_API_KEY",
])
  delete process.env[name];
const { startServer } = await import("../src/index.ts");

test("the production broker boots without a tenant issuer or email policy and derives each issuer from its row", async () => {
  setEdgeTenants([]);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const get = (host: string, path: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: (server.address() as AddressInfo).port, path, headers: { host } },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += String(chunk);
          });
          res.on("end", () => resolve({ status: res.statusCode!, text }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    assert.equal((await get("unknown.example", "/healthz")).status, 200);
    assert.equal((await get("unknown.example", "/.well-known/openid-configuration")).status, 404);
    setEdgeTenants([
      {
        id: "tenant-first",
        slug: "first",
        orgId: "first",
        hosts: ["first.example"],
        status: "active",
        oidcAdmin: false,
        emailAuthPrincipals: ["member@first.example"],
        secrets: {},
      },
    ]);
    const response = await get("first.example", "/.well-known/openid-configuration");
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).issuer, "https://first.example/idp");
  } finally {
    setEdgeTenants([]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
