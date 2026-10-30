import { createHmac, randomBytes } from "node:crypto";
import {
  HindsightClient,
  HindsightError,
  type HindsightClientOptions,
  type RecallResponse,
} from "@vectorize-io/hindsight-client";
import OAuth from "oauth-1.0a";

import type { FinnyNetSuiteClient, FinnyNetSuiteCredential } from "./provider-adapter.ts";
import { FinanceFailure, type FinanceFailureCause } from "./finance-failure.ts";
import { CONFIG_DEFAULTS } from "../config.ts";

export interface FinnyHindsightCredential {
  apiUrl: string;
  apiKey: string;
  bankIds: readonly string[];
}

export interface FinnyHindsightClient {
  recall(query: string, credential: FinnyHindsightCredential): Promise<unknown>;
}

interface NetSuiteClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  pageSize?: number;
}

interface HindsightProviderClientOptions {
  clientFactory?: (options: HindsightClientOptions) => Pick<HindsightClient, "recall">;
}

export interface NetSuiteOAuthHeaderInput {
  method: string;
  url: string;
  credential: FinnyNetSuiteCredential;
  nonce: string;
  timestamp: string;
}

type ProviderDependency = "hindsight" | "netsuite";
const PROVIDER_TIMEOUT_MS = CONFIG_DEFAULTS.execTimeoutDefaultSec * 1000;

export function createFinnyHindsightClient(options: HindsightProviderClientOptions = {}): FinnyHindsightClient {
  const clientFactory = options.clientFactory ?? ((clientOptions) => new HindsightClient(clientOptions));
  return {
    async recall(query, credential) {
      const banks: Array<{ bankId: string; results: unknown }> = [];
      const client = clientFactory({
        baseUrl: credential.apiUrl,
        apiKey: credential.apiKey,
        userAgent: "qm-finny/0.1.0",
        maxAttempts: 1,
      });
      for (const bankId of credential.bankIds) {
        const signal = providerSignal();
        let payload: RecallResponse;
        try {
          payload = await client.recall(bankId, query, {
            types: ["observation"],
            budget: "mid",
            signal,
          });
        } catch (error) {
          if (error instanceof FinanceFailure) throw error;
          if (error instanceof HindsightError && error.statusCode !== undefined) {
            throw providerHttpFailure("Hindsight recall", "hindsight", error.statusCode);
          }
          throw providerTransportFailure("Hindsight recall", "hindsight", error);
        }
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.results)) {
          throw invalidProviderResponse("Hindsight recall returned an invalid response", "hindsight");
        }
        banks.push({ bankId, results: payload.results });
      }
      return { banks };
    },
  };
}

export function createFinnyNetSuiteClient(options: NetSuiteClientOptions = {}): FinnyNetSuiteClient {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const nonce = options.nonce ?? (() => randomBytes(18).toString("base64url"));
  const pageSize = boundedInteger(options.pageSize ?? 1000, 1, 1000, "NetSuite page size");
  return {
    async suiteql(query, credential) {
      const accountHost = credential.accountId.replaceAll("_", "-").toLowerCase();
      const endpoint = `https://${accountHost}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
      const rows: unknown[] = [];
      let offset = 0;
      while (true) {
        const signal = providerSignal();
        const url = `${endpoint}?limit=${pageSize}&offset=${offset}`;
        const authorization = createNetSuiteOAuthHeader({
          method: "POST",
          url,
          credential,
          nonce: nonce(),
          timestamp: String(Math.floor(now() / 1000)),
        });
        const response = await requestProvider(
          request,
          url,
          {
            method: "POST",
            headers: {
              authorization,
              "content-type": "application/json",
              prefer: "transient",
            },
            body: JSON.stringify({ q: query }),
            signal,
          },
          "NetSuite SuiteQL",
          "netsuite",
        );
        if (!response.ok) throw providerHttpFailure("NetSuite SuiteQL", "netsuite", response.status);
        const payload = await readProviderJson(response, "NetSuite SuiteQL", "netsuite");
        if (!payload || typeof payload !== "object") {
          throw invalidProviderResponse("NetSuite SuiteQL returned an invalid response", "netsuite");
        }
        const items = (payload as { items?: unknown }).items;
        const hasMore = (payload as { hasMore?: unknown }).hasMore;
        if (!Array.isArray(items) || typeof hasMore !== "boolean") {
          throw invalidProviderResponse("NetSuite SuiteQL returned an invalid response", "netsuite");
        }
        for (const item of items) {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw invalidProviderResponse("NetSuite SuiteQL returned an invalid response", "netsuite");
          }
          rows.push(withoutLinks(item));
        }
        if (!hasMore) return rows;
        if (!items.length) throw invalidProviderResponse("NetSuite SuiteQL pagination did not advance", "netsuite");
        offset += items.length;
      }
    },
  };
}

export function createNetSuiteOAuthHeader(input: NetSuiteOAuthHeaderInput): string {
  const oauth = new OAuth({
    consumer: { key: input.credential.consumerKey, secret: input.credential.consumerSecret },
    signature_method: "HMAC-SHA256",
    hash_function: (base, key) => createHmac("sha256", key).update(base).digest("base64"),
    realm: input.credential.accountId,
  });
  oauth.getNonce = () => input.nonce;
  oauth.getTimeStamp = () => Number(input.timestamp);
  return oauth.toHeader(
    oauth.authorize(
      { method: input.method, url: input.url },
      { key: input.credential.tokenId, secret: input.credential.tokenSecret },
    ),
  ).Authorization;
}

async function readProviderJson(
  response: Response,
  operation: string,
  dependency: ProviderDependency,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidProviderResponse(`${operation} returned invalid JSON`, dependency);
    throw providerTransportFailure(operation, dependency, error);
  }
}

async function requestProvider(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
  dependency: ProviderDependency,
): Promise<Response> {
  try {
    return await request(url, init);
  } catch (error) {
    throw providerTransportFailure(operation, dependency, error);
  }
}

function providerTransportFailure(operation: string, dependency: ProviderDependency, error: unknown): FinanceFailure {
  const name = error instanceof Error ? error.name : "";
  const timeout = name === "TimeoutError" || name === "AbortError";
  return new FinanceFailure(timeout ? "provider_timeout" : "provider_unavailable", {
    retryable: true,
    dependency,
    message: timeout ? `${operation} timed out` : `${operation} is unavailable`,
  });
}

function providerHttpFailure(
  operation: string,
  dependency: ProviderDependency,
  providerStatus: number,
): FinanceFailure {
  let cause: FinanceFailureCause = "invalid_response";
  let retryable = false;
  if (providerStatus === 401 || providerStatus === 403) cause = "provider_auth";
  else if (providerStatus === 408 || providerStatus === 504) {
    cause = "provider_timeout";
    retryable = true;
  } else if (providerStatus === 429) {
    cause = "provider_rate_limited";
    retryable = true;
  } else if (providerStatus >= 500 && providerStatus <= 599) {
    cause = "provider_unavailable";
    retryable = true;
  }
  return new FinanceFailure(cause, {
    retryable,
    dependency,
    providerStatus,
    message: `${operation} failed with status ${providerStatus}`,
  });
}

function invalidProviderResponse(message: string, dependency: ProviderDependency): FinanceFailure {
  return new FinanceFailure("invalid_response", { retryable: false, dependency, message });
}

function withoutLinks(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const { links: _links, ...record } = item as Record<string, unknown>;
  return record;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function providerSignal(): AbortSignal {
  return AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
}
