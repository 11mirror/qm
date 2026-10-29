import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setEdgeTenants, withEdgeTenant } from "../../chassis/src/tenant-hosts.ts";

Object.assign(process.env, {
  NODE_ENV: "production",
  CORE_SIGNING_SECRET: "deployment-core-signing-secret-0123456789",
  PORTAL_IDENTITY_SECRET: "deployment-identity-secret-01234567890123",
  PORTAL_SESSION_SECRET: "deployment-session-root-secret-01234567",
  PORTAL_PUBLIC_URL: "http://must-not-be-a-tenant.example",
  PORTAL_TRUSTED_OIDC: "not-json",
  ORG_ID: "must-not-be-a-tenant",
  CORE_ORG_ID: "must-not-be-a-tenant",
});
delete process.env.AUTH_BROKER_UPSTREAM;
delete process.env.AUTH_EMBEDDED;
delete process.env.PORTAL_LOCAL_AUTH_BYPASS;
const { coreOrgId } = await import("../../chassis/src/env.ts");
const { startServer } = await import("../src/index.ts");
const { site, secureCookies } = await import("../src/config.ts");

async function get(server: Server, host: string, path: string) {
  return new Promise<{ status: number; location?: string; cookies: string[] }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: (server.address() as AddressInfo).port, path, headers: { host } },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            location: res.headers.location,
            cookies: res.headers["set-cookie"] ?? [],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("production portal boots without a tenant, and every sign-in and cookie setting comes from a row", async () => {
  setEdgeTenants([]);
  const server = await startServer(0, "127.0.0.1");
  try {
    assert.throws(site, /registered tenant/);
    assert.throws(coreOrgId, /registered tenant/);
    assert.equal((await get(server, "unknown.example", "/healthz")).status, 200);
    assert.equal((await get(server, "must-not-be-a-tenant.example", "/")).status, 404);
    const own = {
      id: "tenant-original",
      slug: "original",
      orgId: "original",
      hosts: ["typed.example"],
      status: "active" as const,
      oidcAdmin: false,
      principalRule: { claim: "email" as const, allowedEmailDomain: "typed.example" },
      secrets: {
        primaryOidc: {
          issuer: "https://login.example",
          authEndpoint: "https://login.example/authorize",
          tokenEndpoint: "https://login.example/token",
          userinfoEndpoint: "https://login.example/userinfo",
          jwksUri: "https://login.example/jwks",
          clientId: "typed-client",
          clientSecret: "tenant-client-secret-0123456789012345",
          redirectUri: "https://typed.example/auth/callback",
          scopes: "openid profile email",
        },
      },
    };
    setEdgeTenants([own]);
    withEdgeTenant(own, () => assert.equal(secureCookies(), true));
    const login = await get(server, "typed.example", "/auth/login");
    assert.equal(login.status, 302);
    assert.equal(new URL(login.location!).searchParams.get("client_id"), "typed-client");
    assert.ok(login.cookies.some((cookie) => /; Secure(?:;|$)/.test(cookie)));
  } finally {
    setEdgeTenants([]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
