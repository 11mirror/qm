import { test } from "node:test";
import assert from "node:assert/strict";
import { piLastAssistantTextOrThrow, piTurnError, providerRefusalError } from "../../src/harness/turn-recovery.ts";
import { ProviderTurnError, turnFailureMessage } from "../../src/core/turn-error.ts";

test("Pi assistant error messages fail the turn instead of becoming a blank reply", () => {
  const session = {
    getLastAssistantText: () => undefined,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider quota exhausted",
        content: [],
      },
    ],
  } as unknown as Parameters<typeof piLastAssistantTextOrThrow>[0];

  assert.throws(() => piLastAssistantTextOrThrow(session), /provider quota exhausted/);
});

type FailedFields = { errorMessage?: string; providerError?: unknown; rawStopReason?: string };
const failedSession = (...messages: FailedFields[]) =>
  ({
    getLastAssistantText: () => undefined,
    messages: messages.map((m) => ({ role: "assistant", stopReason: "error", content: [], ...m })),
  }) as unknown as Parameters<typeof piTurnError>[0];
const overloaded = {
  errorMessage: "529 Overloaded",
  providerError: {
    status: 529,
    type: "overloaded_error",
    body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  },
};

test("Pi provider errors are surfaced from the structured body as readable chat errors", () => {
  const session = failedSession({
    errorMessage: "400 Your credit balance is too low.",
    providerError: {
      status: 400,
      type: "invalid_request_error",
      body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low." } },
    },
  });
  assert.throws(
    () => piLastAssistantTextOrThrow(session),
    /Model provider API error \(invalid_request_error\): Your credit balance is too low\./,
  );
});

test("piTurnError recovers the session's structured error when the agent loop rejects generically", () => {
  const err = piTurnError(failedSession(overloaded), new Error("An unknown error occurred"));
  assert.match(err.message, /Model provider API error \(overloaded_error\): Overloaded/);
});

test("Pi retryability comes from status and type, never errorMessage", () => {
  const retryable: FailedFields[] = [
    overloaded,
    { errorMessage: "500", providerError: { status: 500, type: "api_error" } },
    { errorMessage: "429", providerError: { status: 429 } },
    { errorMessage: "fetch failed" },
  ];
  for (const fields of retryable) {
    const err = piTurnError(failedSession(fields), new Error("x"));
    assert.ok(err instanceof ProviderTurnError && err.retryable, JSON.stringify(fields));
    assert.equal(turnFailureMessage(err), err.message);
    assert.throws(() => piLastAssistantTextOrThrow(failedSession(fields)), ProviderTurnError);
  }
  const terminal: FailedFields[] = [
    { errorMessage: "429 overloaded, retry", providerError: { status: 429, code: "insufficient_quota" } },
    { errorMessage: "rate limit", providerError: { status: 400, type: "invalid_request_error" } },
    { errorMessage: "503", providerError: { status: 400, code: "context_length_exceeded" } },
    { errorMessage: "overloaded", providerError: { status: 401, type: "authentication_error" } },
    { errorMessage: "network error", rawStopReason: "refusal" },
  ];
  for (const fields of terminal) {
    const err = piTurnError(failedSession(fields), new Error("x"));
    assert.ok(err instanceof ProviderTurnError && !err.retryable, JSON.stringify(fields));
  }
});

test("piTurnError falls back to the thrown error when the session has no structured error", () => {
  const session = {
    getLastAssistantText: () => undefined,
    messages: [{ role: "assistant", stopReason: "stop", content: [] }],
  } as unknown as Parameters<typeof piTurnError>[0];

  assert.equal(piTurnError(session, new Error("socket hang up")).message, "socket hang up");
  assert.equal(piTurnError(session, "boom").message, "boom");
});

test("piTurnError ignores a PRIOR turn's stale error when nothing new was appended this prompt", () => {
  const session = failedSession(overloaded);
  const err = piTurnError(session, new Error("socket hang up"), 1);
  assert.equal(err.message, "socket hang up");
  const recovered = piTurnError(session, new Error("An unknown error occurred"), 0);
  assert.match(recovered.message, /Model provider API error \(overloaded_error\): Overloaded/);
});

test("Pi provider errors are classified once into a typed code from structured fields", () => {
  const classify = (fields: FailedFields) => piTurnError(failedSession(fields), new Error("x")) as ProviderTurnError;
  const budget = classify({
    errorMessage: "429: Budget has been exceeded! Limit=$1000.00",
    providerError: {
      status: 429,
      type: "budget_exceeded",
      code: "400",
      body: { message: "Budget has been exceeded! Limit=$1000.00", type: "budget_exceeded" },
    },
  });
  assert.deepEqual([budget.code, budget.status, budget.retryable], ["model_budget", 429, false]);
  assert.match(budget.raw, /Limit=\$1000\.00/, "the gateway's full text is kept for operators");
  assert.match(budget.message, /Budget has been exceeded/);
  const cases: Array<[FailedFields, string, number | undefined]> = [
    [{ providerError: { status: 429, type: "rate_limit_error" } }, "rate_limit", 429],
    [{ providerError: { status: 401, type: "authentication_error" } }, "auth", 401],
    [{ providerError: { status: 403 } }, "auth", 403],
    [{ providerError: { status: 400, code: "context_length_exceeded" } }, "context_too_long", 400],
    [{ providerError: { status: 529, type: "overloaded_error" } }, "transient", 529],
    [{ rawStopReason: "refusal" }, "refusal", undefined],
    // Anthropic documents prompt-too-long only as a 400 invalid_request_error, so it is a bad_request, not context_too_long.
    [
      {
        errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
        providerError: { status: 400, type: "invalid_request_error" },
      },
      "bad_request",
      400,
    ],
    [{ errorMessage: "The model refused to complete the request" }, "unknown", undefined],
  ];
  for (const [fields, code, status] of cases) {
    const err = classify(fields);
    assert.equal(err.code, code, JSON.stringify(fields));
    assert.equal(err.status, status, JSON.stringify(fields));
  }
});

test("providerRefusalError finds this prompt's refusal but never a prior turn's", () => {
  const refusalMsg = {
    role: "assistant",
    stopReason: "error",
    rawStopReason: "refusal",
    errorMessage:
      "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.",
    content: [],
  };
  const session = {
    getLastAssistantText: () => undefined,
    messages: [refusalMsg, { role: "user", content: [] }],
  } as unknown as Parameters<typeof providerRefusalError>[0];
  assert.match(providerRefusalError(session) ?? "", /Terms of Service/);
  assert.equal(providerRefusalError(session, 2), null);
});
