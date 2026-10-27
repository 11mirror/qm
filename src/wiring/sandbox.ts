import type { ScopeId } from "../types.ts";
import { BACKGROUND_JOB_TTL_MAX_MS } from "../connectors/background-exec-broker.ts";
import { type StoredE2bSandbox, createE2bSandbox, E2B_TEMPLATE_TOOLS } from "../sandbox/e2b-sandbox.ts";
import { type StoredModalSandbox, modalLegacyRecordMigration, createModalSandbox } from "../sandbox/modal-sandbox.ts";
import type { BackendSandbox, Sandbox } from "../sandbox/sandbox.ts";
import { createLocalSandbox, type StoredLocalSandbox } from "../sandbox/local-sandbox.ts";
import { createSpritesSandbox, type StoredSpritesSandbox } from "../sandbox/sprites-sandbox.ts";
import { loadConnectorSdk } from "../sandbox/connector-sdk.ts";
import { createSmolmachinesSandbox, type StoredSmolmachinesSandbox } from "../sandbox/smolmachines-sandbox.ts";
import { type E2bClient, createSdkE2bClient } from "../sandbox/e2b-client.ts";
import { E2B_DEPLOY_IDLE_TIMEOUT_SEC } from "../deploy/e2b-deploy-provider.ts";
import {
  createManagedAgentsSandbox,
  QM_TEMPLATE_TOOLS,
  type StoredManagedAgentsSandbox,
} from "../sandbox/managed-agents-sandbox.ts";
import { createSdkManagedAgentsClient } from "../sandbox/managed-agents-client.ts";
import { createSdkModalClient } from "../sandbox/modal-client.ts";
import { type Config, enabledSandboxBackends } from "../config.ts";
import { type SandboxBackendName, createSandboxRouter } from "../sandbox/sandbox-routing.ts";
import type { Stores } from "./stores.ts";
import type { Files } from "./files.ts";
import type { DeploymentLayer } from "./deployment-layer.ts";
import { type SandboxResource, type SandboxDefault, createSandboxResources } from "../sandbox/sandbox-resources.ts";
import {
  upgradeLegacySandboxes,
  type LegacyRoute,
  legacySandboxBackendForScope,
} from "../sandbox/sandbox-resource-upgrade.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD, CAPABILITY_TTL_MS } from "../auth/capability-token.ts";
import { egressClaimAllowingControlPlane } from "../core/orchestrator.ts";
import type { Late } from "./late.ts";

export function buildSandboxBackends(
  w: Pick<Stores, "artifactMap" | "pgArtifactMap" | "advisoryLock"> &
    Pick<Files, "errors" | "blobTransfer" | "workspace"> &
    Pick<DeploymentLayer, "deploymentLayer"> & { config: Config },
) {
  const { errors, config, advisoryLock, blobTransfer, deploymentLayer, artifactMap, pgArtifactMap, workspace } = w;

  const sandboxOnError = (
    e: { category: string; code: string; message: string; scopeLabel?: string },
    error?: unknown,
  ) =>
    errors.record(
      {
        category: e.category,
        code: e.code,
        message: e.message,
        scopeLabel: (e.scopeLabel ?? "unknown") as ScopeId,
      },
      error,
    );
  const sandboxShared = {
    ...config.sandbox,
    keepWarmSec: Math.ceil(BACKGROUND_JOB_TTL_MAX_MS / 1000),
    advisoryLock,
    blobTransfer,
    extraTools: deploymentLayer.advertisedTools,
    credentialPaths: deploymentLayer.credentialPaths,
    layerToolFiles: () => deploymentLayer.installFiles,
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    onError: sandboxOnError,
  };
  const e2bBodies = artifactMap<StoredE2bSandbox>("e2b_sandbox_bodies");
  const modalBodies = artifactMap<StoredModalSandbox>("modal_sandbox_bodies");
  pgArtifactMap.pool.registerMigration(modalLegacyRecordMigration("modal_sandbox_bodies"));
  const buildLocal = (): BackendSandbox =>
    createLocalSandbox(workspace, {
      ...sandboxShared,
      ...config.localSandbox,
      store: artifactMap<StoredLocalSandbox>("local_sandbox_bodies"),
    });
  const buildSprites = (): BackendSandbox =>
    createSpritesSandbox(workspace, {
      ...sandboxShared,
      ...config.spritesSandbox,
      store: artifactMap<StoredSpritesSandbox>("sprites_initialization"),
      connectorSdk: loadConnectorSdk,
    });
  const buildSmolmachines = (): BackendSandbox =>
    createSmolmachinesSandbox(workspace, {
      ...sandboxShared,
      ...config.smolmachinesSandbox,
      store: artifactMap<StoredSmolmachinesSandbox>("smolmachines_sandbox_bodies"),
    });
  const e2bClient = (use: "computers" | "apps"): E2bClient => {
    const e2b = config.e2bSandbox;
    if (!e2b.apiKey)
      throw new Error(`${use === "apps" ? "DEPLOY_PROVIDER" : "SANDBOX_BACKEND"}=e2b requires E2B_API_KEY`);
    return createSdkE2bClient({
      apiKey: e2b.apiKey,
      ...(e2b.templateId ? { templateId: e2b.templateId } : {}),
      ...(use === "apps" ? { sandboxTtlMs: E2B_DEPLOY_IDLE_TIMEOUT_SEC * 1000 } : {}),
      ...(use === "computers" && config.sandbox.idleParkSec ? { sandboxTtlMs: config.sandbox.idleParkSec * 1000 } : {}),
      ...(config.sandbox.maxLifetimeSec ? { maxLifetimeMs: config.sandbox.maxLifetimeSec * 1000 } : {}),
      ...(use === "computers" && config.sandbox.egressProxyUrl
        ? { egressProxyUrl: config.sandbox.egressProxyUrl }
        : {}),
    });
  };
  const buildE2b = (): BackendSandbox =>
    createE2bSandbox(workspace, {
      ...sandboxShared,
      client: e2bClient("computers"),
      extraTools: [...(config.e2bSandbox.templateId ? E2B_TEMPLATE_TOOLS : []), ...deploymentLayer.advertisedTools],
      store: e2bBodies,
    });
  const buildManagedAgents = (): BackendSandbox => {
    const managedAgents = config.managedAgentsSandbox;
    if (!managedAgents.apiToken) throw new Error("SANDBOX_BACKEND=do-managed-agents requires DO_AGENTS_API_TOKEN");
    return createManagedAgentsSandbox(workspace, {
      ...sandboxShared,
      client: createSdkManagedAgentsClient({
        apiToken: managedAgents.apiToken,
        ...(managedAgents.template ? { template: managedAgents.template } : {}),
        ...(config.sandbox.idleParkSec ? { idleTimeoutSec: config.sandbox.idleParkSec } : {}),
        ...(config.sandbox.egressProxyUrl ? { egressProxyUrl: config.sandbox.egressProxyUrl } : {}),
      }),
      extraTools: [...(managedAgents.template ? QM_TEMPLATE_TOOLS : []), ...deploymentLayer.advertisedTools],
      store: artifactMap<StoredManagedAgentsSandbox>("do_managed_agents_sandbox_bodies"),
    });
  };
  const buildModal = (): BackendSandbox => {
    const modal = config.modalSandbox;
    if (!modal.tokenId || !modal.tokenSecret)
      throw new Error("SANDBOX_BACKEND=modal requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET");
    return createModalSandbox(workspace, {
      ...sandboxShared,
      client: createSdkModalClient({
        tokenId: modal.tokenId,
        tokenSecret: modal.tokenSecret,
        appName: modal.appName ?? "qm",
        ...(modal.image ? { image: modal.image } : {}),
        ...(modal.environment ? { environment: modal.environment } : {}),
        ...(config.sandbox.cpus !== undefined ? { cpus: config.sandbox.cpus } : {}),
        ...(config.sandbox.memoryMb !== undefined ? { memoryMb: config.sandbox.memoryMb } : {}),
        ...(config.sandbox.maxLifetimeSec ? { sandboxTimeoutMs: config.sandbox.maxLifetimeSec * 1000 } : {}),
        ...(config.sandbox.idleParkSec ? { idleTimeoutMs: 2 * config.sandbox.idleParkSec * 1000 } : {}),
        ...(config.sandbox.egressProxyUrl ? { egressProxyUrl: config.sandbox.egressProxyUrl } : {}),
      }),
      connectorSdk: loadConnectorSdk,
      store: modalBodies,
    });
  };
  const buildBackend: Record<Config["sandboxBackend"], () => BackendSandbox> = {
    local: buildLocal,
    sprites: buildSprites,
    smolmachines: buildSmolmachines,
    e2b: buildE2b,
    modal: buildModal,
    "do-managed-agents": buildManagedAgents,
  };
  const enabledBackends = new Set(enabledSandboxBackends(config));
  const sandboxBackends: Partial<Record<SandboxBackendName, BackendSandbox>> = {
    [config.sandboxBackend]: buildBackend[config.sandboxBackend](),
  };
  for (const name of Object.keys(buildBackend) as Array<Config["sandboxBackend"]>) {
    if (name !== config.sandboxBackend && enabledBackends.has(name)) sandboxBackends[name] = buildBackend[name]();
  }
  return { sandboxBackends, e2bBodies, modalBodies, sandboxOnError, e2bClient };
}

export type SandboxBackends = ReturnType<typeof buildSandboxBackends>;

export function buildSandbox(
  w: Pick<Stores, "artifactMap" | "advisoryLock" | "sessions" | "environments" | "canUseSandboxScope"> &
    Pick<SandboxBackends, "sandboxBackends" | "sandboxOnError" | "e2bBodies" | "modalBodies"> & {
      config: Config;
      late: Late;
    },
) {
  const {
    artifactMap,
    sandboxBackends,
    advisoryLock,
    config,
    sessions,
    environments,
    e2bBodies,
    modalBodies,
    late,
    canUseSandboxScope,
    sandboxOnError,
  } = w;

  const sandboxRecords = artifactMap<SandboxResource>("sandbox_resources");
  const sandboxDefaults = artifactMap<SandboxDefault>("sandbox_defaults");
  const sandboxResources = createSandboxResources({
    records: sandboxRecords,
    defaults: sandboxDefaults,
    upgrade: () =>
      upgradeLegacySandboxes({
        availableBackends: Object.keys(sandboxBackends) as SandboxBackendName[],
        records: sandboxRecords,
        defaults: sandboxDefaults,
        marker: artifactMap<{ activatedAt: string }>("sandbox_resource_rollout"),
        routes: () => artifactMap<LegacyRoute>("sandbox_routing").entries(),
        lock: advisoryLock,
        legacyBackend: (scope) =>
          legacySandboxBackendForScope(scope, config.sandboxBackend, config.legacySandboxScopeDefaults),
        specFor: (backend) => sandboxBackends[backend]?.profile.spec,
        legacyScopes: async () => [
          ...(await sessions.distinctScopes()).map((scope) => scope.scopeId),
          ...(await environments.list()).map((environment) => environment.id),
        ],
        legacySandboxes: async () => {
          const [e2b, modal] = await Promise.all([e2bBodies.entries(), modalBodies.entries()]);
          return [
            ...e2b.map(([scopeId, body]) => ({ scopeId, backend: "e2b" as const, machineId: body.sandboxId })),
            ...modal.flatMap(([scopeId, body]) =>
              body.sandboxId ? [{ scopeId, backend: "modal" as const, machineId: body.sandboxId }] : [],
            ),
          ];
        },
      }),
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
