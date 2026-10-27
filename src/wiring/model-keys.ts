import type { Head } from "./late.ts";
import { createCustomProviderStore } from "../model/custom-provider-store.ts";
import { setCustomProviders } from "../model/custom-providers.ts";
import { type MemoryEmbedder, createMemoryEmbedder } from "../model/embeddings.ts";
import { resolveEmbeddingModel, CODEX_SUBSCRIPTION_PROVIDER } from "../model/pi-models.ts";
import { reportFailure } from "../util/errors.ts";
import { type CompanyChatGPTAuth, keychainCompanyChatGPTAuth } from "../model/company-chatgpt-auth.ts";
import type { ProviderKeys } from "../harness/pi-model-runtime.ts";
import { keychainHarnessAuthEnv } from "../credentials/harness-auth-env.ts";
import type { StoresModule } from "./stores.ts";
import type { ModelCredentialsModule } from "./model-credentials.ts";
import type { CredentialsModule } from "./credentials.ts";

export function buildModelKeys(w: Head & StoresModule & ModelCredentialsModule & CredentialsModule) {
  const {
    advisoryLock,
    artifactMap,
    connectorSecretKey,
    gatewayCatalog,
    modelCredentials,
    gatewayTransport,
    overrides,
    config,
    keychain,
  } = w;

  const writeModelRegistry = <T>(fn: () => Promise<T>): Promise<T> =>
    advisoryLock.withLock("model-registry", async () => {
      await refreshModels();
      return fn();
    });
  const customProviders = createCustomProviderStore({
    write: writeModelRegistry,
    backing: artifactMap("custom_model_providers"),
    keyMaterial: connectorSecretKey,
  });
  const refreshCustomProviders = async () => {
    setCustomProviders(await customProviders.enabled());
  };
  const refreshModels = async () => {
    await gatewayCatalog?.refresh();
    await refreshCustomProviders();
  };
  const resolveMemoryEmbedder = async (id: string): Promise<MemoryEmbedder> => {
    const model = resolveEmbeddingModel(id);
    if (!model) throw new Error(`Embedding model unavailable: ${id}`);
    const key = model.provider === "openai" ? await modelCredentials.resolve("openai") : null;
    return createMemoryEmbedder(model, key, gatewayTransport, overrides.modelCredentialFetch);
  };
  const resolveModelProviderKeys = async () => {
    await refreshModels();
    const [anthropic, openai, openrouter, enabledCustom] = await Promise.all([
      modelCredentials.resolve("anthropic"),
      modelCredentials.resolve("openai"),
      modelCredentials.resolve("openrouter"),
      customProviders.enabled(),
    ]);
    const customKeys = Object.fromEntries(
      (
        await Promise.all(
          enabledCustom.map(async (p) => {
            try {
              return [p.id, await customProviders.resolveKey(p.id)] as const;
            } catch (e) {
              // A corrupt/undecryptable custom key must degrade that one
              // provider, never the whole turn (built-ins included).
              reportFailure("model: custom provider key unreadable", e, p.id);
              return [p.id, null] as const;
            }
          }),
        )
      ).filter(([, key]) => key),
    );
    return {
      ...(anthropic ? { anthropic } : {}),
      ...(openai ? { openai } : {}),
      ...(openrouter ? { openrouter } : {}),
      ...customKeys,
    };
  };
  const companyChatGPTAuth: CompanyChatGPTAuth | undefined = config.codexAuthCredential
    ? keychainCompanyChatGPTAuth({ keychain, credentialId: config.codexAuthCredential })
    : undefined;
  const resolveCompanySubscriptionKeys = async (): Promise<ProviderKeys> => {
    if (!companyChatGPTAuth) return {};
    try {
      const token = await companyChatGPTAuth.accessToken();
      return token ? { [CODEX_SUBSCRIPTION_PROVIDER]: token } : {};
    } catch (e) {
      reportFailure("model: company ChatGPT auth unreadable", e, companyChatGPTAuth.description);
      return {};
    }
  };
  const companyClaudeAuthEnv = config.claudeAuthCredential
    ? keychainHarnessAuthEnv(keychain, config.claudeAuthCredential, ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
    : undefined;
  const resolveCompanyClaudeKeys = async (): Promise<ProviderKeys> => {
    if (!companyClaudeAuthEnv) return {};
    const env = await companyClaudeAuthEnv();
    const token = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
    if (!token)
      console.error(
        `[model] company Claude subscription credential ${config.claudeAuthCredential} yielded no token (missing, expired, or not an env credential)`,
      );
    return token ? { anthropic: token } : {};
  };
  const resolvePiProviderKeys = async (): Promise<ProviderKeys> => ({
    ...(await resolveCompanyClaudeKeys()),
    ...(await resolveModelProviderKeys()),
    ...(await resolveCompanySubscriptionKeys()),
  });
  const resolveBrowserCompanyKeys = async (includeSubscription = true): Promise<ProviderKeys> =>
    includeSubscription ? resolvePiProviderKeys() : resolveModelProviderKeys();
  return {
    resolveMemoryEmbedder,
    resolvePiProviderKeys,
    refreshModels,
    customProviders,
    refreshCustomProviders,
    resolveBrowserCompanyKeys,
  };
}

export type ModelKeysModule = ReturnType<typeof buildModelKeys>;
