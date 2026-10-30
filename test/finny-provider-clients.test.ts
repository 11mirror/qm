import assert from "node:assert/strict";
import test from "node:test";
import { HindsightError } from "@vectorize-io/hindsight-client";

import {
  createFinnyHindsightClient,
  createFinnyNetSuiteClient,
  createNetSuiteOAuthHeader,
} from "../src/finny/provider-clients.ts";
import { FinanceFailure } from "../src/finny/finance-failure.ts";
import { CONFIG_DEFAULTS } from "../src/config.ts";

test("NetSuite OAuth signing matches Oracle's REST web services example", () => {
  const header = createNetSuiteOAuthHeader({
    method: "GET",
    url: "https://123456.suitetalk.api.netsuite.com/services/rest/record/v1/employee/40",
    credential: {
      accountId: "123456",
      consumerKey: "ef40afdd8abaac111b13825dd5e5e2ddddb44f86d5a0dd6dcf38c20aae6b67e4",
      consumerSecret: "d26ad321a4b2f23b0741c8d38392ce01c3e23e109df6c96eac6d099e9ab9e8b5",
      tokenId: "2b0ce516420110bcbd36b69e99196d1b7f6de3c6234c5afb799b73d87569f5cc",
      tokenSecret: "c29a677df7d5439a458c063654187e3d678d73aca8e3c9d8bea1478a3eb0d295",
    },
    nonce: "fjaLirsIcCGVZWzBX0pg",
    timestamp: "1508242306",
  });

  assert.match(header, /oauth_signature="B5OIWznZ2YP0OB7VrJrGkYsTh%2B8H%2B5T9Hag%2Bo92q0zY%3D"/);
});

test("Hindsight client recalls only from the credential-bound banks", async () => {
  const clients: Array<{ baseUrl: string; apiKey?: string }> = [];
  const requests: Array<{ bankId: string; query: string; options?: Record<string, unknown> }> = [];
  const client = createFinnyHindsightClient({
    clientFactory: (options) => {
      clients.push(options);
      return {
        recall: async (bankId, query, recallOptions) => {
          requests.push({ bankId, query, options: recallOptions });
          return { results: [{ id: String(requests.length), text: `memory-${requests.length}` }] };
        },
      };
    },
  });

  const output = await client.recall("open AP", {
    apiUrl: "https://api.hindsight.vectorize.io",
    apiKey: "hsk-secret",
    bankIds: ["finance/shared", "finance-two"],
  });

  assert.deepEqual(output, {
    banks: [
      { bankId: "finance/shared", results: [{ id: "1", text: "memory-1" }] },
      { bankId: "finance-two", results: [{ id: "2", text: "memory-2" }] },
    ],
  });
  assert.deepEqual(clients, [
    {
      baseUrl: "https://api.hindsight.vectorize.io",
      apiKey: "hsk-secret",
      userAgent: "qm-finny/0.1.0",
      maxAttempts: 1,
    },
  ]);
  assert.deepEqual(
    { ...requests[0], options: { ...requests[0]?.options, signal: undefined } },
    {
      bankId: "finance/shared",
      query: "open AP",
      options: {
        types: ["observation"],
        budget: "mid",
        signal: undefined,
      },
    },
  );
  assert.ok(requests[0]?.options?.signal instanceof AbortSignal);
});

test("NetSuite client posts read-only SuiteQL with a signed transient request", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createFinnyNetSuiteClient({
    now: () => 1_700_000_000_000,
    nonce: () => "fixed-nonce",
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ items: [{ id: "1", links: [] }], hasMore: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const credential = {
    accountId: "123456_SB1",
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    tokenId: "token-id",
    tokenSecret: "token-secret",
  };

  const rows = await client.suiteql("SELECT id FROM transaction", credential);

  assert.deepEqual(rows, [{ id: "1" }]);
  assert.equal(
    requests[0]?.url,
    "https://123456-sb1.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=1000&offset=0",
  );
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("prefer"), "transient");
  assert.match(headers.get("authorization") ?? "", /^OAuth realm="123456_SB1"/);
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { q: "SELECT id FROM transaction" });
  assert.ok(requests[0]?.init?.signal instanceof AbortSignal);
});

test("every Hindsight request receives a fresh provider deadline", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const client = createFinnyHindsightClient({
    clientFactory: () => ({
      recall: async (_bankId, _query, options) => {
        signals.push(options?.signal);
        return { results: [] };
      },
    }),
  });

  await client.recall("open AP", {
    apiUrl: "https://api.hindsight.vectorize.io",
    apiKey: "key",
    bankIds: ["finance", "finance-two"],
  });
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  assert.notEqual(signals[0], signals[1]);
});

test("provider deadline uses the platform execution budget and fails closed", async (t) => {
  const timeout = new DOMException("private timeout detail", "TimeoutError");
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, CONFIG_DEFAULTS.execTimeoutDefaultSec * 1000);
    return AbortSignal.abort(timeout);
  });
  const client = createFinnyNetSuiteClient({
    fetch: async (_input, init) => {
      init?.signal?.throwIfAborted();
      throw new Error("unreachable");
    },
  });
  await assert.rejects(
    client.suiteql("SELECT id FROM transaction", {
      accountId: "123456",
      consumerKey: "key",
      consumerSecret: "secret",
      tokenId: "token",
      tokenSecret: "token-secret",
    }),
    (error: Error) =>
      error instanceof FinanceFailure &&
      error.causeCode === "provider_timeout" &&
      error.retryable &&
      error.dependency === "netsuite" &&
      !error.message.includes("private"),
  );
});

test("NetSuite pagination continues until the provider reports completion", async () => {
  let calls = 0;
  const signals: Array<AbortSignal | null | undefined> = [];
  const client = createFinnyNetSuiteClient({
    pageSize: 2,
    nonce: () => `nonce-${calls}`,
    fetch: async (_input, init) => {
      calls += 1;
      signals.push(init?.signal);
      return new Response(
        JSON.stringify({
          items: [{ id: String(calls * 2 - 1) }, { id: String(calls * 2) }],
          hasMore: calls < 2,
        }),
        { status: 200 },
      );
    },
  });

  const rows = await client.suiteql("SELECT id FROM transaction", {
    accountId: "123456",
    consumerKey: "key",
    consumerSecret: "secret",
    tokenId: "token",
    tokenSecret: "token-secret",
  });
  assert.deepEqual(rows, [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }]);
  assert.equal(calls, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  assert.notEqual(signals[0], signals[1]);
});

test("provider clients fail closed without returning upstream error bodies", async () => {
  const marker = "sensitive-upstream-body";
  const hindsight = createFinnyHindsightClient({
    clientFactory: () => ({
      recall: async () => {
        throw new HindsightError(marker, 403, { secret: marker });
      },
    }),
  });
  await assert.rejects(
    hindsight.recall("AP", {
      apiUrl: "https://api.hindsight.vectorize.io",
      apiKey: "key",
      bankIds: ["finance"],
    }),
    (error: Error) =>
      error instanceof FinanceFailure &&
      error.message === "Hindsight recall failed with status 403" &&
      !error.message.includes(marker) &&
      error.causeCode === "provider_auth" &&
      error.retryable === false &&
      error.dependency === "hindsight" &&
      error.providerStatus === 403,
  );

  const netsuite = createFinnyNetSuiteClient({
    fetch: async () => new Response(marker, { status: 401 }),
  });
  await assert.rejects(
    netsuite.suiteql("SELECT id FROM transaction", {
      accountId: "123456",
      consumerKey: "key",
      consumerSecret: "secret",
      tokenId: "token",
      tokenSecret: "token-secret",
    }),
    (error: Error) =>
      error instanceof FinanceFailure &&
      error.message === "NetSuite SuiteQL failed with status 401" &&
      !error.message.includes(marker) &&
      error.causeCode === "provider_auth" &&
      error.retryable === false &&
      error.dependency === "netsuite" &&
      error.providerStatus === 401,
  );
});

test("provider clients classify retryable HTTP and transport failures", async () => {
  const credential = {
    accountId: "123456",
    consumerKey: "key",
    consumerSecret: "secret",
    tokenId: "token",
    tokenSecret: "token-secret",
  };
  for (const [status, cause] of [
    [408, "provider_timeout"],
    [429, "provider_rate_limited"],
    [503, "provider_unavailable"],
    [504, "provider_timeout"],
  ] as const) {
    const client = createFinnyNetSuiteClient({ fetch: async () => new Response("private", { status }) });
    await assert.rejects(client.suiteql("SELECT id FROM transaction", credential), (error: Error) => {
      assert.ok(error instanceof FinanceFailure);
      assert.equal(error.causeCode, cause);
      assert.equal(error.retryable, true);
      assert.equal(error.dependency, "netsuite");
      assert.equal(error.providerStatus, status);
      assert.doesNotMatch(error.message, /private|secret/);
      return true;
    });
  }

  const timeout = createFinnyNetSuiteClient({
    fetch: async () => {
      throw new DOMException("private timeout detail", "TimeoutError");
    },
  });
  await assert.rejects(timeout.suiteql("SELECT id FROM transaction", credential), (error: Error) => {
    assert.ok(error instanceof FinanceFailure);
    assert.equal(error.causeCode, "provider_timeout");
    assert.equal(error.retryable, true);
    assert.equal(error.dependency, "netsuite");
    assert.doesNotMatch(error.message, /private|secret/);
    return true;
  });
});

test("provider clients classify malformed success responses as non-retryable", async () => {
  const client = createFinnyNetSuiteClient({
    fetch: async () => new Response("not-json", { status: 200 }),
  });
  await assert.rejects(
    client.suiteql("SELECT id FROM transaction", {
      accountId: "123456",
      consumerKey: "key",
      consumerSecret: "secret",
      tokenId: "token",
      tokenSecret: "token-secret",
    }),
    (error: Error) =>
      error instanceof FinanceFailure &&
      error.causeCode === "invalid_response" &&
      error.retryable === false &&
      error.dependency === "netsuite" &&
      !error.message.includes("not-json"),
  );
});
