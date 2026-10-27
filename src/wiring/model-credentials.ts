import type { Head } from "./late.ts";
import { resolveModel } from "../model/pi-models.ts";
import { createGatewayCatalog } from "../model/gateway-catalog.ts";
import { providerKeysPresent } from "../config.ts";
import { createModelCredentialStore, type ModelCredentialStore } from "../model/model-credential-store.ts";
import type { StoresModule } from "./stores.ts";

export function buildModelCredentials(w: Head & StoresModule) {
  const { config, overrides, artifactMap, connectorSecretKey } = w;

  const unknownGatewayModels = Object.keys(config.modelGateway?.models ?? {}).filter((id) => !resolveModel(id));
  if (unknownGatewayModels.length) {
    throw new Error(`MODEL_GATEWAY_MODELS contains unsupported models: ${unknownGatewayModels.join(", ")}`);
  }
  const gatewayCatalog = config.modelGateway
    ? createGatewayCatalog(config.modelGateway, overrides.modelCredentialFetch)
    : undefined;
  const gatewayTransport = gatewayCatalog?.transport;
  const directProviderAvailability = providerKeysPresent(config);
  const directModelCredentials = createModelCredentialStore({
    backing: artifactMap("model_credentials"),
    keyMaterial: connectorSecretKey,
    fallback: {
      ...(config.anthropicApiKey ? { anthropic: config.anthropicApiKey } : {}),
      ...(config.openaiApiKey ? { openai: config.openaiApiKey } : {}),
      ...(config.openrouterApiKey ? { openrouter: config.openrouterApiKey } : {}),
    },
  });
  const modelCredentials: ModelCredentialStore = {
    ...directModelCredentials,
    async availability() {
      await gatewayCatalog?.refresh();
      const direct = await directModelCredentials.availability();
      return {
        ...direct,
        ...(directProviderAvailability.codexOAuth ? { codexOAuth: true } : {}),
        ...(config.claudeAuthCredential ? { anthropic: true } : {}),
        modelIds: new Set(Object.keys(gatewayTransport?.models ?? {})),
      };
    },
  };
  return { gatewayCatalog, modelCredentials, gatewayTransport, directProviderAvailability };
}

export type ModelCredentialsModule = ReturnType<typeof buildModelCredentials>;
