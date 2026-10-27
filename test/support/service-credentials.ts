import { createInsecureTestServer } from "../../src/api/server.ts";
import type { BuiltApp } from "../../src/wiring.ts";
import { buildApp } from "./build-app.ts";
import { testConfig } from "./test-config.ts";
import type { AclStore } from "../../src/acl/acl-store.ts";
import { listenLocal } from "./listen-local.ts";

export const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

export function start(wrapAcl?: (acl: AclStore) => AclStore): {
  base: string;
  built: BuiltApp;
  close: () => Promise<void>;
} {
  const built = buildApp(testConfig());
  const acl = wrapAcl?.(built.acl) ?? built.acl;
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    serviceCreds: built.serviceCreds,
    acl,
    credentialUsage: built.credentialUsage,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  const base = listenLocal(server);
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export const putCred = (base: string, b: object, headers = ADMIN) =>
  fetch(`${base}/v1/admin/scopes/org:default-org/service-credentials`, {
    method: "PUT",
    headers,
    body: JSON.stringify(b),
  });

export const getCfg = async (base: string) =>
  (await (await fetch(`${base}/v1/admin/scopes/org:default-org`, { headers: ADMIN })).json()) as {
    serviceCredentials: Array<{
      slug: string;
      name: string;
      host: string;
      deployments?: boolean;
      hasSecret: boolean;
      enabled: boolean;
      grantees: string[];
      updatedAt: number;
      injection?: { header?: string; scheme?: string; actor?: boolean; headers?: Record<string, string> };
      allowedMethods?: string[];
      allowedPathPrefixes?: string[];
    }>;
  };

export const SECRET = "svc-cred-route-secret".repeat(3);
