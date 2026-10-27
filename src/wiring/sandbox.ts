import { type SandboxResource, type SandboxDefault, createSandboxResources } from "../sandbox/sandbox-resources.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD, CAPABILITY_TTL_MS } from "../auth/capability-token.ts";
import { egressClaimAllowingControlPlane } from "../core/orchestrator.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import { createSandboxRouter } from "../sandbox/sandbox-routing.ts";
import type { StoresModule } from "./stores.ts";
import type { SandboxBackendsModule } from "./sandbox-backends.ts";
import type { Config } from "../config.ts";
import type { Late } from "./late.ts";

export function buildSandbox(
  w: Pick<StoresModule, "artifactMap" | "advisoryLock" | "canUseSandboxScope"> &
    Pick<SandboxBackendsModule, "sandboxBackends" | "sandboxOnError"> & { config: Config; late: Late },
) {
  const { artifactMap, sandboxBackends, config, advisoryLock, late, canUseSandboxScope, sandboxOnError } = w;

  const sandboxRecords = artifactMap<SandboxResource>("sandbox_resources");
  const sandboxDefaults = artifactMap<SandboxDefault>("sandbox_defaults");
  const sandboxResources = createSandboxResources({
    records: sandboxRecords,
    defaults: sandboxDefaults,
    backends: sandboxBackends,
    defaultBackend: config.sandboxBackend,
    lock: advisoryLock,
    beforeRetire: async (record) => {
      if ((await late.processes?.liveByScope(record.ownerScopeId))?.some((process) => process.sandboxId === record.id))
        throw new Error("stop this sandbox's background jobs before retiring it");
    },
    provisionOptions: async (scopeId) => {
      const secret = config.capabilitySecret ?? config.signingSecret;
      if (!secret) return {};
      const egressToken = await mintCapabilityToken(
        {
          actorId: "system:sandbox-create",
          scopeId,
          aud: EGRESS_PROXY_AUD,
          egress: egressClaimAllowingControlPlane({ allowedHosts: [] }, config.apiBaseUrl ?? ""),
          exp: Date.now() + CAPABILITY_TTL_MS,
        },
        secret,
        config.capabilityTokenCompression,
      );
      return { egressToken };
    },
    canUseScope: canUseSandboxScope,
  });
  const sandbox: Sandbox = createSandboxRouter({
    resources: sandboxResources,
    backends: sandboxBackends,
    defaultBackend: config.sandboxBackend,
    onError: sandboxOnError,
  });
  return { sandbox, sandboxResources };
}

export type SandboxModule = ReturnType<typeof buildSandbox>;
