import type { LlmTransportMeta } from "../sessions/session-store.ts";
import { MAX_LLM_REQUEST_BYTES } from "../core/document-kinds.ts";
import { ELIDED_IMAGE_TEXT } from "./replay-images.ts";

const LLM_REQUEST_TRIM_SLACK_BYTES = 3_000_000;
export const GATEWAY_REQUEST_MAX_BYTES = 9_000_000;
function inlineBinaryData(b: unknown): string | undefined {
  const block = b as {
    type?: string;
    source?: { type?: string; data?: unknown };
    image_url?: unknown;
    file_data?: unknown;
    file?: { file_data?: unknown };
    inlineData?: { mimeType?: unknown; data?: unknown };
  };
  if (
    (block?.type === "image" || block?.type === "document") &&
    block.source?.type === "base64" &&
    typeof block.source.data === "string"
  )
    return block.source.data;
  if (block?.type === "input_image" && typeof block.image_url === "string" && block.image_url.startsWith("data:"))
    return block.image_url;
  if (block?.type === "input_file" && typeof block.file_data === "string") return block.file_data;
  if (block?.type === "file" && typeof block.file?.file_data === "string") return block.file.file_data;
  if (typeof block?.inlineData?.mimeType === "string" && typeof block.inlineData.data === "string")
    return block.inlineData.data;
  return undefined;
}

function jsonBytesUpperBound(value: unknown, binary?: string): number {
  if (typeof value === "string") {
    if (value !== binary) return value.length * 6 + 2;
    const header = value.startsWith("data:") ? value.indexOf(",") + 1 : 0;
    return header * 6 + value.length - header + 2;
  }
  if (!value || typeof value !== "object") return 24;
  let sum = 2;
  if (Array.isArray(value)) {
    for (const item of value) sum += jsonBytesUpperBound(item, binary) + 1;
    return sum;
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return Number.POSITIVE_INFINITY;
  const data = inlineBinaryData(value) ?? binary;
  for (const key of Object.keys(value))
    sum += key.length * 6 + 4 + jsonBytesUpperBound((value as Record<string, unknown>)[key], data);
  return sum;
}

export function trimPayloadToByteBudget(payload: unknown, maxBytes: number = MAX_LLM_REQUEST_BYTES): unknown {
  const p = payload as Record<string, unknown> | null;
  let listKey: "messages" | "input" | undefined;
  if (Array.isArray(p?.messages)) listKey = "messages";
  else if (Array.isArray(p?.input)) listKey = "input";
  if (!p || !listKey) return payload;
  if (jsonBytesUpperBound(payload) <= maxBytes) return payload;
  const totalBytes = Buffer.byteLength(JSON.stringify(payload));
  if (totalBytes <= maxBytes) return payload;

  const inlineImageChars = (b: unknown): number => inlineBinaryData(b)?.length ?? 0;
  const placeholder = (b: unknown) => {
    const block = b as { type?: string; cache_control?: unknown };
    const cache = block.cache_control !== undefined ? { cache_control: block.cache_control } : undefined;
    const text = ["document", "input_file", "file"].includes(block.type ?? "")
      ? "[Document omitted because the model request exceeds its byte budget. Do not claim to have read it.]"
      : ELIDED_IMAGE_TEXT;
    return block.type === "input_image" || block.type === "input_file"
      ? { type: "input_text", text }
      : { type: "text", text, ...cache };
  };
  let toShed = totalBytes - (maxBytes - LLM_REQUEST_TRIM_SLACK_BYTES);
  const trimContent = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content;
    let changed = false;
    const out = content.map((block) => {
      const imageChars = inlineImageChars(block);
      if (imageChars > 0 && toShed > 0) {
        toShed -= imageChars - ELIDED_IMAGE_TEXT.length;
        changed = true;
        return placeholder(block);
      }
      const nested = block as { content?: unknown };
      if (Array.isArray(nested?.content)) {
        const inner = trimContent(nested.content);
        if (inner !== nested.content) {
          changed = true;
          return { ...(block as Record<string, unknown>), content: inner };
        }
      }
      return block;
    });
    return changed ? out : content;
  };

  const items = (p[listKey] as unknown[]).map((m) => {
    if (toShed <= 0) return m;
    const msg = m as { content?: unknown };
    if (!Array.isArray(msg?.content)) return m;
    const content = trimContent(msg.content);
    return content === msg.content ? m : { ...(m as Record<string, unknown>), content };
  });
  return { ...p, [listKey]: items };
}

export function transportFromModel(model: unknown): LlmTransportMeta | undefined {
  if (!model || typeof model !== "object") return undefined;
  const m = model as { id?: unknown; headers?: unknown };
  const out: LlmTransportMeta = {};
  if (typeof m.id === "string") out.modelId = m.id;
  if (m.headers && typeof m.headers === "object") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
    if (Object.keys(headers).length) out.headers = headers;
  }
  return out.modelId || out.headers ? out : undefined;
}

export function textFromContent(content: unknown, separator = ""): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text")
    .map((c) => (typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .join(separator);
}

export const OUTPUT_BUDGET_FLOOR_TOKENS = 1_024;
export const OUTPUT_GUARD_SAFETY_TOKENS = 4_096;
const OUTPUT_GUARD_CHARS_PER_TOKEN = 4;
const IMAGE_STAND_IN = "i".repeat(4_800);

export type OutputBudgetGuardResult =
  { kind: "ok" } | { kind: "raised"; from: number; to: number; estimatedPromptTokens: number };

function estimatePayloadTokens(payload: Record<string, unknown>): number | undefined {
  try {
    const json = JSON.stringify(payload, function (this: unknown, key, value) {
      if (typeof value !== "string" || value.length <= IMAGE_STAND_IN.length) return value;
      const mediaType = (this as { media_type?: unknown } | null)?.media_type;
      const anthropicImage = key === "data" && typeof mediaType === "string" && mediaType.startsWith("image/");
      const openaiImage = (key === "url" || key === "image_url") && value.startsWith("data:image/");
      const container = this as { media_type?: unknown; mimeType?: unknown; type?: unknown } | null;
      const nativeDocument =
        (key === "file_data" && value.startsWith("data:")) ||
        (key === "data" &&
          ((container?.type === "base64" && container.media_type === "application/pdf") ||
            container?.mimeType === "application/pdf"));
      return anthropicImage || openaiImage || nativeDocument ? IMAGE_STAND_IN : value;
    });
    if (typeof json !== "string") return undefined;
    return Math.ceil(json.length / OUTPUT_GUARD_CHARS_PER_TOKEN);
  } catch {
    return undefined;
  }
}

export function guardOutputBudget(payload: unknown, model: unknown): OutputBudgetGuardResult {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return { kind: "ok" };
  let capKey: "max_tokens" | "max_output_tokens" | "max_completion_tokens" | undefined;
  if (typeof p.max_tokens === "number") capKey = "max_tokens";
  else if (typeof p.max_output_tokens === "number") capKey = "max_output_tokens";
  else if (typeof p.max_completion_tokens === "number") capKey = "max_completion_tokens";
  if (capKey === undefined) return { kind: "ok" };
  const cap = p[capKey] as number;
  if (cap >= OUTPUT_BUDGET_FLOOR_TOKENS) return { kind: "ok" };
  const m = model as { contextWindow?: number; maxTokens?: number } | null;
  const contextWindow = m?.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return { kind: "ok" };
  const estimatedPromptTokens = estimatePayloadTokens(p);
  if (estimatedPromptTokens === undefined) return { kind: "ok" };
  const available = contextWindow - estimatedPromptTokens - OUTPUT_GUARD_SAFETY_TOKENS;
  if (available < OUTPUT_BUDGET_FLOOR_TOKENS) {
    throw new Error(
      `prompt is too long: estimated ${estimatedPromptTokens} tokens leave no output room in a ${contextWindow}-token window (output-budget guard)`,
    );
  }
  const modelMax = typeof m?.maxTokens === "number" && m.maxTokens > 0 ? m.maxTokens : available;
  const to = Math.min(modelMax, available);
  if (to <= cap) return { kind: "ok" };
  p[capKey] = to;
  return { kind: "raised", from: cap, to, estimatedPromptTokens };
}
