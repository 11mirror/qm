import { createHmac } from "node:crypto";
import OAuth from "oauth-1.0a";

const fields = ["accountId", "consumerKey", "consumerSecret", "tokenId", "tokenSecret"] as const;

export interface NetSuiteTbaCredentials {
  accountId: string;
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
}

export function parseNetSuiteTbaSecret(secret: string): NetSuiteTbaCredentials {
  const parsed: unknown = JSON.parse(secret);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid NetSuite credential");
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => typeof record[field] !== "string" || !(record[field] as string).trim()) ||
    Object.keys(record).some((field) => !fields.includes(field as (typeof fields)[number]))
  ) {
    throw new Error("invalid NetSuite credential");
  }
  return record as unknown as NetSuiteTbaCredentials;
}

export function netSuiteTbaAuthorization(
  credentials: NetSuiteTbaCredentials,
  url: string,
  method: string,
  nonce: string,
  timestamp: number,
): string {
  const oauth = new OAuth({
    consumer: { key: credentials.consumerKey, secret: credentials.consumerSecret },
    realm: credentials.accountId,
    signature_method: "HMAC-SHA256",
    hash_function: (base, key) => createHmac("sha256", key).update(base).digest("base64"),
  });
  oauth.getNonce = () => nonce;
  oauth.getTimeStamp = () => Math.floor(timestamp / 1000);
  return oauth.toHeader(oauth.authorize({ url, method }, { key: credentials.tokenId, secret: credentials.tokenSecret }))
    .Authorization;
}
