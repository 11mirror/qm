import { swallow } from "../../util/errors.ts";
import { browserModelRoutes } from "./browser-model.ts";
import { sandboxModelRoutes } from "./sandbox-model.ts";
import { deploymentLiveSmokeRoutes } from "./deployment-live-smoke.ts";
import { backgroundWorkRoutes } from "./background-work.ts";
import { composioRoutes } from "./composio.ts";
import { composioTwitterMediaRoutes } from "./composio-twitter-media.ts";
import { type ApiCtx, type BaseCtx, ok, reply, type Route } from "./route.ts";
import { connectorRawRoutes, connectorRoutes } from "./connectors.ts";
import { deploymentRawRoutes, deploymentRoutes } from "./deployments.ts";
import { blobRoutes } from "./blobs.ts";
import { sessionStateRawRoutes } from "./session-state.ts";
import { webhookRawRoutes, webhookRoutes } from "./webhooks.ts";
import { runEventRoutes } from "./run-events.ts";
import { turnRoutes } from "./turns.ts";
import { credentialRoutes } from "./credentials.ts";
import { brokerCredentialHttp, CREDENTIAL_HTTP_BROKER_PREFIX } from "../credential-http-broker.ts";
import { keychainRoutes } from "./keychain.ts";
import { secretDropRoutes } from "./secret-drop.ts";
import { adminRoutes } from "./admin.ts";
import { spendExport } from "./admin/spend.ts";
import { skillPackRoutes } from "./skill-packs.ts";
import { fileUploadRoutes } from "./file-uploads.ts";
import { surfaceRoutes } from "./surface.ts";
import { cronRoutes } from "./crons.ts";
import { reachRoutes } from "./reach.ts";
import { directoryRoutes } from "./directory.ts";
import { contextRoutes } from "./context.ts";
import { pinRoutes } from "./pins.ts";
import { uiCanvasRoutes } from "./ui-canvas.ts";
import { surfaceCacheRoutes } from "./surface-cache.ts";
import { environmentRoutes } from "./environments.ts";
import { emojiRoutes } from "./emoji.ts";
import { projectRoutes } from "./projects.ts";
import { contextPolicyRoutes } from "./context-policy.ts";
import { deploymentLayerRoutes } from "./deployment-layer.ts";
import { egressAuditRoutes } from "./egress-audit.ts";
import { slackEventRawRoutes } from "./slack-events.ts";
import { chatSurfaceRawRoutes } from "./chat-surface-events.ts";
import { authBrokerRoutes } from "./auth-broker.ts";
import { searchRoutes } from "./search.ts";
import { userModelAuthRoutes } from "./user-model-auth.ts";
import { toolManifestRoutes } from "./tool-manifest.ts";

export const rawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "GET", path: "/healthz", auth: "public", handle: (_ctx) => ok({ ok: true }) },
  {
    method: "GET",
    path: "/readyz",
    auth: "public",
    handle: async ({ deps }) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Readiness deadline exceeded"));
        }, 1000);
      });
      try {
        await Promise.race([Promise.resolve().then(() => deps.checkReadiness?.(controller.signal)), deadline]);
        return ok({ ok: true });
      } catch (error) {
        swallow("readiness", error);
        return reply(503, { ok: false });
      } finally {
        clearTimeout(timer);
      }
    },
  },
  ...slackEventRawRoutes,
  ...chatSurfaceRawRoutes,
  { method: "GET", path: "/v1/spend/export", auth: "public", handle: spendExport },
  {
    match: (_m, p) => p.startsWith(CREDENTIAL_HTTP_BROKER_PREFIX),
    auth: { aud: "credential-broker" },
    handle: brokerCredentialHttp,
  },
  ...connectorRawRoutes,
  ...deploymentRawRoutes,
  ...blobRoutes,
  ...sessionStateRawRoutes,
  ...webhookRawRoutes,
];

export const apiRoutes: ReadonlyArray<Route<ApiCtx>> = [
  ...browserModelRoutes,
  ...sandboxModelRoutes,
  ...searchRoutes,
  ...deploymentLayerRoutes,
  ...backgroundWorkRoutes,
  ...deploymentLiveSmokeRoutes,
  ...turnRoutes,
  ...runEventRoutes,
  ...credentialRoutes,
  ...keychainRoutes,
  ...secretDropRoutes,
  ...connectorRoutes,
  ...composioRoutes,
  ...composioTwitterMediaRoutes,
  ...adminRoutes,
  ...skillPackRoutes,
  ...surfaceRoutes,
  ...fileUploadRoutes,
  ...projectRoutes,
  ...contextPolicyRoutes,
  ...cronRoutes,
  ...reachRoutes,
  ...webhookRoutes,
  ...directoryRoutes,
  ...contextRoutes,
  ...pinRoutes,
  ...uiCanvasRoutes,
  ...surfaceCacheRoutes,
  ...environmentRoutes,
  ...emojiRoutes,
  ...deploymentRoutes,
  ...egressAuditRoutes,
  ...authBrokerRoutes,
  ...userModelAuthRoutes,
  ...toolManifestRoutes,
];
