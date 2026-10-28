import { asRecord } from "../util/objects.ts";
import { decodeJwt } from "jose";
export type JsonObject = Record<string, unknown>;

function decodeJwtClaims(jwt: string | undefined): Record<string, unknown> | undefined {
  if (!jwt) return undefined;
  try {
    return decodeJwt(jwt);
  } catch {
    return undefined;
  }
}

function chatgptAccountIdFromToken(jwt: unknown): string | undefined {
  if (typeof jwt !== "string" || jwt.split(".").length !== 3) return undefined;
  const auth = decodeJwtClaims(jwt)?.["https://api.openai.com/auth"];
  const accountId = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
  return typeof accountId === "string" && accountId ? accountId : undefined;
}

export function tokenExpiry(raw: { expires_in?: number; access_token?: string }): number | undefined {
  if (typeof raw.expires_in === "number") return Date.now() + raw.expires_in * 1000;
  const claims = decodeJwtClaims(raw.access_token);
  const exp = claims?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

export function authTokens(auth: JsonObject): { access: string; refresh: string; id?: string } | null {
  const tokens = asRecord(auth.tokens);
  if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) return null;
  if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) return null;
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    ...(typeof tokens.id_token === "string" && tokens.id_token ? { id: tokens.id_token } : {}),
  };
}

export function chatgptAccountIdFromTokens(idToken: string | undefined, accessToken: string): string | undefined {
  return chatgptAccountIdFromToken(idToken) ?? chatgptAccountIdFromToken(accessToken);
}

export function authAccountId(auth: JsonObject): string | undefined {
  const tokens = authTokens(auth);
  return tokens ? chatgptAccountIdFromTokens(tokens.id, tokens.access) : undefined;
}

export function accessExpiresAt(auth: JsonObject): number | undefined {
  return tokenExpiry({ access_token: authTokens(auth)?.access });
}

export function chatgptAuthFromValue(value: unknown): JsonObject | null {
  const auth = asRecord(value);
  if (!auth || (auth.auth_mode !== "chatgpt" && auth.auth_mode !== "chatgptAuthTokens")) return null;
  return authTokens(auth) && authAccountId(auth) ? auth : null;
}
