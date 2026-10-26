import { isModelProvider, type ModelProvider } from "../../../model/model-credential-store.ts";
import { cachedModelCatalog, selectableModelCatalog } from "../../../model/model-catalog.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { badRequest, notFound, orgAdmin } from "./common.ts";

const VALIDATION_URLS: Record<ModelProvider, string> = {
  anthropic: "https://api.anthropic.com/v1/models",
  openai: "https://api.openai.com/v1/models",
  openrouter: "https://openrouter.ai/api/v1/key",
};

export async function apiKeyAccepted(ctx: ApiCtx, url: string, anthropic: boolean, apiKey: string): Promise<boolean> {
  const headers: Record<string, string> = anthropic
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${apiKey}` };
  try {
    return (await (ctx.deps.modelCredentialFetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    return false;
  }
}

export const validateProviderApiKey = (ctx: ApiCtx, provider: ModelProvider, apiKey: string): Promise<boolean> =>
  apiKeyAccepted(ctx, VALIDATION_URLS[provider], provider === "anthropic", apiKey);

export async function getModelProviders(ctx: ApiCtx): Promise<void> {
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  await ctx.deps.refreshModels?.();
  if (!ctx.deps.modelCredentials) return notFound(ctx.res);
  authz.audit("model-providers.read", "model-providers");
  const cached =
    ctx.url.searchParams.get("catalog") === "cached" ? cachedModelCatalog(ctx.deps.modelCredentialFetch) : undefined;
  const [providers, models] = await Promise.all([
    ctx.deps.modelCredentials.statuses(),
    cached?.models ?? selectableModelCatalog(ctx.deps.modelCredentialFetch),
  ]);
  return sendJson(ctx.res, 200, {
    providers,
    models,
    ...(cached?.refreshing ? { modelCatalogRefreshing: true } : {}),
    ...(ctx.deps.companySubscriptionAuth ? { subscriptionAuth: { provider: ctx.deps.companySubscriptionAuth } } : {}),
  });
}

export async function putModelProvider(ctx: ApiCtx): Promise<void> {
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  const store = ctx.deps.modelCredentials;
  const provider = ctx.params.provider;
  if (!store || !isModelProvider(provider)) return notFound(ctx.res);
  const apiKey = (ctx.body as { apiKey?: unknown }).apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) return badRequest(ctx.res, "API key is required");
  if (!(await validateProviderApiKey(ctx, provider, apiKey.trim()))) {
    return sendJson(ctx.res, 400, { error: "invalid_api_key", message: `${provider} rejected this API key` });
  }
  await store.set(provider, apiKey.trim(), authz.actor.id);
  authz.audit("model-providers.update", provider);
  const status = (await store.statuses()).find((item) => item.provider === provider);
  return sendJson(ctx.res, 200, { ok: true, status });
}

export async function deleteModelProvider(ctx: ApiCtx): Promise<void> {
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  const provider = ctx.params.provider;
  if (!ctx.deps.modelCredentials || !isModelProvider(provider)) return notFound(ctx.res);
  await ctx.deps.modelCredentials.delete(provider, authz.actor.id);
  authz.audit("model-providers.delete", provider);
  return sendJson(ctx.res, 200, { ok: true });
}
