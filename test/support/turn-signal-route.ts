import { after } from "node:test";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../plugins/chassis/src/portal-identity.ts";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import type { Principal, TurnRequest } from "../../src/types.ts";
import { buildApp } from "./build-app.ts";
import { testConfig } from "./test-config.ts";
import { CORE_SECRET, serveCore } from "./core-route-server.ts";

/**
 * Builds an app whose background turns wait until `runTurns(true)` and serves it on a signed core API and, with
 * `web`, behind the web UI proxy. Everything closes after the file's tests.
 */
export async function serveSignalRoute(opts: { web?: boolean } = {}) {
  const built = buildApp(testConfig());
  const runTurns = (live: boolean) =>
    built.runtime.setBackgroundAdmission(
      () => live,
      () => live,
    );
  runTurns(false);
  const core = serveCore(built.app, {
    webhookReceiver: built.webhookReceiver,
    featureFlags: built.featureFlags,
    uiState: built.uiState,
  });
  let webBase = "";
  let closeWeb = async () => {};
  if (opts.web) {
    process.env.CORE_API_URL = core.base;
    process.env.CORE_SIGNING_SECRET = CORE_SECRET;
    process.env.WEB_UI_PRINCIPALS = "";
    const { handler } = await import("../../plugins/web-ui/server/index.ts");
    const web = createHttpServer(handler);
    web.listen(0);
    webBase = `http://localhost:${(web.address() as AddressInfo).port}`;
    closeWeb = () => new Promise<void>((r) => web.close(() => r()));
  }
  after(async () => {
    await closeWeb();
    await core.close();
    await built.runtime.stop();
  });
  const coreSignal = (runId: string, body: unknown, headers?: Record<string, string>) =>
    core.post(`/v1/runs/${encodeURIComponent(runId)}/signal`, body, headers);
  return { built, runTurns, core, webBase, coreSignal };
}

const actor: Principal = { id: "internal:U1", type: "internal" };
export function request(text: string, threadRef = "t-signal"): OrchestratorInput {
  return {
    modelAccount: "company",
    actor,
    conversation: { kind: "dm", threadRef, audience: [actor] },
    origin: { kind: "direct" },
    text,
  };
}

export function asUser(user: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, CORE_SECRET),
      ...init.headers,
    },
  };
}

export function steererRequest(externalId: string, threadRef: string, text: string, displayName?: string): TurnRequest {
  return {
    surface: "web",
    actor: { externalId, ...(displayName ? { displayName } : {}) },
    conversation: { kind: "dm", threadRef },
    text,
    origin: { kind: "human" },
  };
}
