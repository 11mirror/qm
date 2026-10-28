import { isModelProvider, type ModelProvider } from "../../../model/pi-models.ts";
import { cachedModelCatalog, selectableModelCatalog } from "../../../model/model-catalog.ts";
import { swallow } from "../../../util/errors.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "../route.ts";
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
  } catch (error) {
    swallow("model provider key check", error);
    return false;
  }
}

export const validateProviderApiKey = (ctx: ApiCtx, provider: ModelProvider, apiKey: string): Promise<boolean> =>
  apiKeyAccepted(ctx, VALIDATION_URLS[provider], provider === "anthropic", apiKey);

export async function getModelProviders(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  await ctx.deps.refreshModels?.();
  if (!ctx.deps.modelCredentials) throw notFound();
  authz.audit("model-providers.read", "model-providers");
  const cached =
    ctx.url.searchParams.get("catalog") === "cached" ? cachedModelCatalog(ctx.deps.modelCredentialFetch) : undefined;
  const [providers, models] = await Promise.all([
    ctx.deps.modelCredentials.statuses(),
    cached?.models ?? selectableModelCatalog(ctx.deps.modelCredentialFetch),
  ]);
  return ok({
    providers,
    models,
    ...(cached?.refreshing ? { modelCatalogRefreshing: true } : {}),
    ...(ctx.deps.companySubscriptionAuth ? { subscriptionAuth: { provider: ctx.deps.companySubscriptionAuth } } : {}),
  });
}

export async function putModelProvider(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  const store = ctx.deps.modelCredentials;
  const provider = ctx.params.provider;
  if (!store || !isModelProvider(provider)) throw notFound();
  const apiKey = (ctx.body as { apiKey?: unknown }).apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) throw badRequest("API key is required");
  if (!(await validateProviderApiKey(ctx, provider, apiKey.trim())))
    return reply(400, { error: "invalid_api_key", message: `${provider} rejected this API key` });
  await store.set(provider, apiKey.trim(), authz.actor.id);
  authz.audit("model-providers.update", provider);
  const status = (await store.statuses()).find((item) => item.provider === provider);
  return ok({ ok: true, status });
}

export async function deleteModelProvider(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  const provider = ctx.params.provider;
  if (!ctx.deps.modelCredentials || !isModelProvider(provider)) throw notFound();
  await ctx.deps.modelCredentials.delete(provider, authz.actor.id);
  authz.audit("model-providers.delete", provider);
  return ok({ ok: true });
}
