import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/api/app.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { createToolContext } from "../../src/tools/tool-context.ts";
import { type ToolContext } from "../../src/tools/primitives.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { createDeployService, type DeployService } from "../../src/deploy/deploy-service.ts";
import { createAclStore, type AclStore } from "../../src/acl/acl-store.ts";
import { shareDeployment } from "../../src/api/routes/deployments.ts";
import { type ApiCtx, respond, type Route } from "../../src/api/routes/route.ts";
import { HttpError } from "../../src/api/http.ts";
import type { CapabilityClaims } from "../../src/auth/capability-token.ts";
import type { RecipientResolution } from "../../src/directory/directory-store.ts";
import type { Sandbox, SandboxHandle } from "../../src/sandbox/sandbox.ts";
import { scopeId } from "../../src/types.ts";
import type { FeatureFlagStore } from "../../src/feature-flags.ts";
import { singleProcessDeps } from "./single-process.ts";
import { testAdvisoryLock, testDatabaseUrl, testDeployBackings } from "./test-database.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";

export const externalSharingOn = { enabled: async () => true } as unknown as FeatureFlagStore;

export type Dir = { resolve: (orgId: string, q: string) => Promise<RecipientResolution> };

export function makeDeploy(
  canManageEmail?: (email: string) => Promise<boolean>,
  externalSharing = true,
  publicLinksAvailable = true,
): { deploy: DeployService; acl: AclStore } {
  const acl: AclStore = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 20200 }),
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    ...(canManageEmail ? { canManageEmail } : {}),
    externalSharingAllowed: async () => externalSharing,
    publicLinksAvailable,
    deployDir: mkdtempSync(join(tmpdir(), "share-api-")),
  });
  return { deploy, acl };
}

export function apiHarness(directory?: Dir) {
  const { deploy, acl } = makeDeploy();
  const app = createApp({
    advisoryLock: testAdvisoryLock(),
    deploy,
    identity: createIdentityService(testDatabaseUrl()),
    ...(directory ? { directory } : {}),
  } as unknown as Parameters<typeof createApp>[0]);
  return { app, deploy, acl };
}

export const cap = (actorId: string, orgId = "acme"): CapabilityClaims =>
  ({ actorId, orgId, scopeId: scopeId("personal", actorId), exp: 9_999_999_999 }) as CapabilityClaims;

export function callShare(
  app: ReturnType<typeof createApp>,
  capability: CapabilityClaims | null,
  id: string,
  body: unknown,
  featureFlags = externalSharingOn,
) {
  const out: { status?: number; body?: any } = {};
  const res = {
    getHeader() {},
    writeHead(s: number) {
      out.status = s;
    },
    end(d?: string) {
      out.body = d ? JSON.parse(d) : undefined;
    },
  };
  const ctx = {
    res,
    app,
    deps: { featureFlags },
    params: { id },
    body,
    capability,
  } as unknown as ApiCtx;
  return respond(shareDeployment, ctx).then(
    () => out,
    (error: unknown) => {
      if (error instanceof HttpError) return { status: error.status, body: error.body };
      throw error;
    },
  );
}

export function callManage(
  handle: Route<ApiCtx>["handle"],
  app: ReturnType<typeof createApp>,
  capability: CapabilityClaims | null,
  id: string,
  body: unknown,
  featureFlags = externalSharingOn,
) {
  const out: { status?: number; body?: any } = {};
  const res = {
    getHeader() {},
    writeHead(s: number) {
      out.status = s;
    },
    end(d?: string) {
      out.body = d ? JSON.parse(d) : undefined;
    },
  };
  const ctx = { res, app, deps: { featureFlags }, params: { id }, body, capability } as unknown as ApiCtx;
  return respond(handle, ctx).then(() => out);
}

export const APP_FILES = [{ path: "server.js", data: new TextEncoder().encode("listen") }];

export const appSandbox = (): Sandbox => {
  const under = (dir: string) => {
    const d = (dir ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
    return APP_FILES.filter((f) => !d || d === "." || f.path === d || f.path.startsWith(`${d}/`));
  };
  return {
    listDir: async (_h: SandboxHandle, dir: string) => under(dir).map((f) => f.path),
    readFileBytes: async (_h: SandboxHandle, p: string) => APP_FILES.find((f) => f.path === p)?.data ?? null,
    exportFiles: async (
      _h: SandboxHandle,
      opts?: { include?: Array<"workspace" | "home">; includePaths?: readonly string[] },
    ) => {
      if (opts?.include?.includes("home")) return [];
      const dir = opts?.includePaths?.[0] ?? "";
      return under(dir).map((f) => ({ area: "workspace" as const, path: f.path, data: f.data }));
    },
  } as unknown as Sandbox;
};

export function toolCtx(deploy: DeployService): ToolContext {
  return createToolContext({
    sandbox: appSandbox(),
    provision: async () => ({}) as SandboxHandle,
    layers: [
      { scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" },
      { scopeId: scopeId("org", "default-org"), mountPath: "global", mode: "ro" },
    ],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy,
    acl: {} as never,
    createdBy: "U1",
  } as never);
}
