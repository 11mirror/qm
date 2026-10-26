import { getRuntimeConfig, type RuntimeConfig } from "./runtime-config-cache.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBaseModel, type ModelMetadata } from "./pi-models.ts";

export type ModelOptionValue = string;
export interface ModelOption {
  value: ModelOptionValue;
  model: Model<Api>;
  label: string;
  buttonLabel: string;
  groupLabel: string;
  displayProvider?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  "qm:gateway": "Gateway",
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google",
  "arcee-ai": "Arcee AI",
  "meta-llama": "Meta",
  mistralai: "Mistral AI",
};

function providerLabel(id: string, name: string, provider: string): string {
  const named = provider === "openrouter" && /^([^:]{2,40}):\s/.exec(name)?.[1]?.trim();
  if (named) return named;
  const key = provider === "openrouter" ? (id.split("/", 1)[0] ?? provider) : provider;
  return (
    PROVIDER_LABELS[key] ??
    key
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function gatewayPresentation(id: string, provider: string): { label: string; provider: string } | null {
  if (provider !== "qm:gateway" || !id.startsWith("gateway/")) return null;
  const name = id.split("/").at(-1)!;
  const family = /^(claude|gpt|gemini)-(.+)$/.exec(name);
  if (!family) return null;
  const words = family[2]!.replace(/^((?:[a-z]+-)*)(\d+)-(\d+)(?=-|$)/, "$1$2.$3").split("-");
  const title = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const brand = {
    claude: { prefix: "", provider: "anthropic" },
    gpt: { prefix: "GPT-", provider: "openai" },
    gemini: { prefix: "Gemini ", provider: "google" },
  }[family[1] as "claude" | "gpt" | "gemini"];
  return { label: brand.prefix + title, provider: brand.provider };
}

function buildOption(id: string, catalog: Readonly<Record<string, ModelMetadata>>): ModelOption | null {
  const meta = catalog[id];
  if (!meta) return null;
  try {
    const model = getBaseModel(id, meta);
    const presentation = gatewayPresentation(id, String(model.provider));
    const present = (label: string) =>
      presentation && [id, id.slice("gateway/".length)].includes(label) ? presentation.label : label;
    return {
      value: id,
      model,
      label: present(meta.label),
      buttonLabel: present(meta.buttonLabel),
      ...(presentation ? { displayProvider: presentation.provider } : {}),
      groupLabel: providerLabel(
        id,
        meta.label,
        presentation?.provider ?? meta.provider ?? String(model.api ?? "other"),
      ),
    };
  } catch {
    return null;
  }
}

export function runtimeModelOptions(
  ids: readonly string[],
  catalog: Readonly<Record<string, ModelMetadata>> = {},
): ModelOption[] {
  return [...new Set(ids)].flatMap((id) => buildOption(id, catalog) ?? []);
}

const FALLBACK = { options: [] as ModelOption[], defaultValue: null as string | null };
const derived = new WeakMap<RuntimeConfig, typeof FALLBACK>();

function runtimeFor(scopeKey?: string | null): typeof FALLBACK {
  const config = getRuntimeConfig(scopeKey);
  if (!config) return FALLBACK;
  const options = derived.get(config) ?? {
    options: runtimeModelOptions(config.models, config.modelCatalog),
    defaultValue: config.effective.modelId,
  };
  derived.set(config, options);
  return options;
}

export function getModelOptions(scopeKey?: string | null): ModelOption[] {
  return runtimeFor(scopeKey).options;
}

export function defaultModelValue(scopeKey?: string | null): ModelOptionValue {
  return runtimeFor(scopeKey).defaultValue ?? "";
}

export function transcriptModel(scopeKey?: string | null): Model<Api> | undefined {
  const { options, defaultValue } = runtimeFor(scopeKey);
  return options.find((o) => o.value === defaultValue)?.model;
}

export { EFFORT_LEVELS, defaultEffortForModel, effortLabel, type EffortLevel } from "./runtime-capabilities.ts";
