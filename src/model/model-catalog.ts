import { errMessage } from "../util/errors.ts";
import { asRecord } from "../util/objects.ts";
import { readCappedText } from "../util/response-body.ts";
import { gatewayModelCatalog, gatewayModelsVersion } from "./gateway-models.ts";
import { modelSupported, registerOpenRouterCatalogModel, resolveModel, selectableBaseModels } from "./pi-models.ts";
import { customModelCatalog, customProvidersVersion } from "./custom-providers.ts";
import { perTenant } from "../tenant.ts";

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular";
const OPENROUTER_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/;

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_MODELS = 1_000;
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;

interface CacheEntry {
  customVersion?: number;
  gatewayVersion?: number;
  dynamic?: ModelCatalogEntry[];
  expiresAt: number;
  models: ModelCatalogEntry[];
  inFlight?: Promise<ModelCatalogEntry[]>;
}

const catalogCache = perTenant(() => new WeakMap<typeof fetch, CacheEntry>());

export function builtInModelCatalog(): ModelCatalogEntry[] {
  const builtIns = selectableBaseModels().flatMap((model) => {
    const provider = resolveModel(model.id)?.provider;
    return provider === "anthropic" || provider === "openai" || provider === "openrouter"
      ? [{ ...model, provider: provider as string }]
      : [];
  });
  return appendUnknown(builtIns, [...customModelCatalog(), ...gatewayModelCatalog()]);
}

function appendUnknown(models: ModelCatalogEntry[], extras: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  const known = new Set(models.map((model) => model.id));
  return [...models, ...extras.filter((model) => !known.has(model.id))];
}

function settle(entry: CacheEntry, ttlMs: number): ModelCatalogEntry[] {
  entry.models = appendUnknown(builtInModelCatalog(), entry.dynamic ?? []);
  entry.expiresAt = Date.now() + ttlMs;
  entry.customVersion = customProvidersVersion();
  entry.gatewayVersion = gatewayModelsVersion();
  return entry.models;
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await readCappedText(response, MAX_CATALOG_BYTES, () => new Error("OpenRouter catalog is too large"));
  if (text === undefined) throw new Error("OpenRouter catalog has no body");
  return JSON.parse(text) as unknown;
}

function finiteNumber(value: unknown): number | undefined {
  let parsed = Number.NaN;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string") parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOpenRouterModel(candidate: unknown): ModelCatalogEntry | undefined {
  const raw = asRecord(candidate);
  if (!raw) return undefined;
  const { id, name, supported_parameters: supportedParameters } = raw;
  const contextWindow = finiteNumber(raw.context_length);
  const maxTokens = finiteNumber(asRecord(raw.top_provider)?.max_completion_tokens);
  const promptPrice = finiteNumber(asRecord(raw.pricing)?.prompt);
  const completionPrice = finiteNumber(asRecord(raw.pricing)?.completion);
  const inputModalities = asRecord(raw.architecture)?.input_modalities;
  if (
    typeof id !== "string" ||
    id.length > 200 ||
    !OPENROUTER_MODEL_ID_RE.test(id) ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 200 ||
    !Array.isArray(supportedParameters) ||
    !supportedParameters.includes("tools")
  )
    return undefined;
  const knownOpenRouter = resolveModel(id)?.provider === "openrouter";
  const inputPrice = promptPrice === undefined ? undefined : promptPrice * 1_000_000;
  const outputPrice = completionPrice === undefined ? undefined : completionPrice * 1_000_000;
  if (
    contextWindow === undefined ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    maxTokens === undefined ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0 ||
    maxTokens > contextWindow ||
    inputPrice === undefined ||
    !Number.isFinite(inputPrice) ||
    outputPrice === undefined ||
    !Number.isFinite(outputPrice) ||
    !Array.isArray(inputModalities) ||
    !inputModalities.includes("text")
  )
    return knownOpenRouter ? { id, name, provider: "openrouter" } : undefined;
  const registered = registerOpenRouterCatalogModel({
    id,
    name,
    contextWindow,
    maxTokens,
    input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
    reasoning:
      supportedParameters.includes("reasoning") ||
      supportedParameters.includes("include_reasoning") ||
      supportedParameters.includes("reasoning_effort"),
    cost: { input: inputPrice, output: outputPrice },
  });
  return registered ? { id, name, provider: "openrouter" } : undefined;
}

async function fetchOpenRouterModels(fetcher: typeof fetch): Promise<ModelCatalogEntry[]> {
  const response = await fetcher(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`OpenRouter catalog returned ${response.status}`);
  const body = (await boundedJson(response)) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter catalog is invalid");
  return body.data.slice(0, MAX_CATALOG_MODELS).flatMap((candidate) => {
    const model = parseOpenRouterModel(candidate);
    return model ? [model] : [];
  });
}

export async function selectableModelCatalog(fetcher: typeof fetch = fetch): Promise<ModelCatalogEntry[]> {
  const now = Date.now();
  const existing = catalogCache().get(fetcher);
  if (
    existing &&
    existing.expiresAt > now &&
    existing.customVersion === customProvidersVersion() &&
    existing.gatewayVersion === gatewayModelsVersion()
  )
    return existing.models;
  if (existing?.inFlight) return existing.inFlight;
  const entry = existing ?? { expiresAt: 0, models: [] };
  entry.inFlight = fetchOpenRouterModels(fetcher)
    .then((dynamic) => {
      entry.dynamic = dynamic;
      return settle(entry, CACHE_TTL_MS);
    })
    .catch((error: unknown) => {
      console.warn(`[model] OpenRouter catalog fetch failed; using cached and built-in models: ${errMessage(error)}`);
      return settle(entry, FAILURE_TTL_MS);
    })
    .finally(() => {
      delete entry.inFlight;
    });
  catalogCache().set(fetcher, entry);
  return entry.inFlight;
}

export function selectableCatalog(catalog: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  return catalog.filter((model) => modelSupported(model.id));
}

export function cachedModelCatalog(fetcher: typeof fetch = fetch): {
  models: ModelCatalogEntry[];
  refreshing: boolean;
} {
  void selectableModelCatalog(fetcher);
  const entry = catalogCache().get(fetcher);
  return {
    models: appendUnknown(builtInModelCatalog(), entry?.dynamic ?? []),
    refreshing: !!entry?.inFlight,
  };
}
