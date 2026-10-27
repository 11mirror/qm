import { type RunSignalStore, createMemoryRunSignalStore } from "../runs/run-signal-store.ts";
import { createPostgresRunSignalStore } from "../runs/postgres-run-signal-store.ts";
import {
  resolveModel,
  modelRequestOverrides,
  codexSubscriptionModelId,
  defaultModel,
  auxiliaryModelFor,
  modelSupported,
} from "../model/pi-models.ts";
import { scopeId } from "../types.ts";
import { configuredModel, baseModelProviders, type Config } from "../config.ts";
import { createPiHarness, piHarnessConfigOptions } from "../harness/pi-harness.ts";
import { createDecisionHooks, turnStartState, routeTurnRuntime } from "../decisions/hooks.ts";
import { createDecisionBackend } from "../decisions/providers.ts";
import { nonDeploymentCredential } from "../credentials/deployment-credentials.ts";
import { credentialRequestHeaders } from "../credentials/keychain.ts";
import { selectableModelCatalog } from "../model/model-catalog.ts";
import { withResolvedRuntime, resolveRuntimeChoiceDurable } from "../harness/runtime-choice.ts";
import type { StoresModule } from "./stores.ts";
import type { ModelCredentialsModule } from "./model-credentials.ts";
import type { AppOverrides } from "../wiring.ts";
import type { ModelKeysModule } from "./model-keys.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";

export function buildHarness(
  w: Pick<StoresModule, "configStore" | "decisions"> &
    Pick<ModelCredentialsModule, "gatewayTransport" | "directProviderAvailability" | "modelCredentials"> &
    Pick<ModelKeysModule, "resolvePiProviderKeys" | "refreshModels"> &
    Pick<CredentialsModule, "serviceCreds"> &
    Pick<DeploymentLayerModule, "auditLog"> & { config: Config; databaseUrl: string; overrides: AppOverrides },
) {
  const {
    config,
    databaseUrl,
    configStore,
    gatewayTransport,
    directProviderAvailability,
    overrides,
    resolvePiProviderKeys,
    decisions,
    serviceCreds,
    auditLog,
    refreshModels,
    modelCredentials,
  } = w;

  const runStoreKind = config.runStore;
  const runSignals: RunSignalStore =
    runStoreKind === "postgres" ? createPostgresRunSignalStore(databaseUrl) : createMemoryRunSignalStore();
  const companyModelId = (id: string): string => {
    if (resolveModel(id)?.provider !== "openai" || modelRequestOverrides(id)) return id;
    const subscription = codexSubscriptionModelId(id);
    return resolveModel(subscription) ? subscription : id;
  };
  const runtimeOrgScope = scopeId("org", config.orgId);
  const orgBaseModelId = (): string | undefined => configStore.getRuntimeSelection(runtimeOrgScope)?.modelId;
  const deploymentDefaultModel = () =>
    defaultModel(
      configuredModel(config),
      baseModelProviders(config) ??
        (gatewayTransport
          ? { ...directProviderAvailability, modelIds: new Set(Object.keys(gatewayTransport.models)) }
          : undefined),
    );
  const pi =
    overrides.harness ??
    createPiHarness({
      ...piHarnessConfigOptions(config),
      modelGateway: gatewayTransport,
      resolveBaseModelId: () => orgBaseModelId() ?? deploymentDefaultModel(),
      resolveFallbackRuntime: () => configStore.getPurposeRuntime("fallback"),
      resolveProviderKeys: resolvePiProviderKeys,
      ...(directProviderAvailability.codexOAuth ? { companyModelId } : {}),
      signals: runSignals,
    });
  const fallback = {
    get modelId() {
      return deploymentDefaultModel();
    },
  };
  const decide = createDecisionHooks(
    decisions,
    createDecisionBackend({
      providers: (ids) => decisions.providers(ids),
      ...(config.modelGateway?.apiKey
        ? {
            gateway: {
              url: config.modelGateway.url,
              apiKey: config.modelGateway.apiKey,
              ...(config.modelGateway.apiKeyHeader ? { apiKeyHeader: config.modelGateway.apiKeyHeader } : {}),
            },
          }
        : {}),
      credential: async (slug) => {
        const rec = nonDeploymentCredential(
          await serviceCreds.getServiceCredentialSecret(scopeId("org", config.orgId), slug),
        );
        return rec ? { host: rec.host, enabled: rec.enabled, headers: credentialRequestHeaders(rec) } : null;
      },
    }),
    auditLog,
  );
  const judgeModelId = (): string => config.judgeModelId ?? auxiliaryModelFor(orgBaseModelId() ?? fallback.modelId);
  const hydrateModelCatalog = async (): Promise<unknown> => {
    await refreshModels();
    if (!(await modelCredentials.availability()).openrouter) return undefined;
    return selectableModelCatalog(overrides.modelCredentialFetch);
  };
  const harness = withResolvedRuntime(pi, async (input, routedBy) => {
    await refreshModels();
    const resolve = (requested: typeof input.runtime) =>
      resolveRuntimeChoiceDurable(
        configStore,
        runtimeOrgScope,
        input.scopeLabel,
        fallback,
        requested,
        hydrateModelCatalog,
        input.runtimePurpose,
      );
    const decision = await decide("turn_start", turnStartState(input), {
      ...(input.runtimeActorId ? { actorId: input.runtimeActorId } : {}),
      scopeLabel: input.scopeLabel,
      sessionId: input.session.id,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.cancel ? { cancel: input.cancel } : {}),
    });
    const routed = await routeTurnRuntime(decision, resolve, async () => {
      if (input.runtimePinned && input.runtime?.modelId) {
        if (!modelSupported(input.runtime.modelId)) throw new Error(`Unsupported model: ${input.runtime.modelId}`);
        return { ...input.runtime, modelId: input.runtime.modelId };
      }
      return resolve(input.runtime);
    });
    if (routed.routedBy) routedBy(routed.routedBy);
    return routed.choice;
  });
  if (config.securityScreenProxy) {
    delete harness.models.screenSecurity;
  }
  return {
    runStoreKind,
    harness,
    runSignals,
    runtimeOrgScope,
    fallback,
    hydrateModelCatalog,
    orgBaseModelId,
    judgeModelId,
  };
}

export type HarnessModule = ReturnType<typeof buildHarness>;
