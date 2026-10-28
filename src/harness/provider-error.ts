import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import { ProviderTurnError, TRANSIENT_ERROR_CODES, type ProviderErrorCode } from "../core/turn-error.ts";

const AUTH_TYPES = new Set(["authentication_error", "permission_error", "invalid_api_key"]);
const TRANSIENT_TYPES = new Set(["overloaded_error", "api_error", "timeout_error"]);
const RETRYABLE_CODES = new Set<ProviderErrorCode>([...TRANSIENT_ERROR_CODES, "unknown"]);

type ProviderFailure = Pick<AssistantMessage, "providerError" | "rawStopReason" | "errorMessage"> | AssistantMessage;

function providerErrorCode(failed: ProviderFailure): ProviderErrorCode {
  if (failed.rawStopReason === "refusal") return "refusal";
  const { status, type, code } = failed.providerError ?? {};
  if (type === "model_unavailable") return "model_unavailable";
  if (type === "request_too_large" || status === 413) return "context_too_long";
  if ("usage" in failed && isContextOverflow(failed)) return "context_too_long";
  if (type === "budget_exceeded" || code === "insufficient_quota") return "model_budget";
  if (code === "context_length_exceeded") return "context_too_long";
  if ((type && AUTH_TYPES.has(type)) || status === 401 || status === 403) return "auth";
  if (type === "rate_limit_error" || status === 429) return "rate_limit";
  if (type === "not_found_error" || code === "model_not_found" || status === 404) return "not_found";
  if ((type && TRANSIENT_TYPES.has(type)) || status === 408 || status === 409 || (status ?? 0) >= 500)
    return "transient";
  if (type === "invalid_request_error" || status === 400 || status === 422) return "bad_request";
  return "unknown";
}

function providerBodyMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as { message?: unknown; error?: unknown };
  const nested = record.error && typeof record.error === "object" ? (record.error as { message?: unknown }) : record;
  return typeof nested.message === "string" && nested.message.trim() ? nested.message.trim() : undefined;
}

export function providerTurnError(failed: ProviderFailure): ProviderTurnError {
  const raw = failed.errorMessage?.trim() ?? "";
  const code = providerErrorCode(failed);
  const status = failed.providerError?.status;
  const type = failed.providerError?.type;
  const bodyMessage = providerBodyMessage(failed.providerError?.body);
  const message = bodyMessage
    ? `Model provider API error${type ? ` (${type})` : ""}: ${bodyMessage}`
    : raw || "Pi agent stopped with an error";
  const retryable =
    RETRYABLE_CODES.has(code) && !(code === "unknown" && (status !== undefined || failed.rawStopReason));
  return new ProviderTurnError(message, { code, retryable, status, raw });
}
