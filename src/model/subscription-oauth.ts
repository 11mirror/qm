import { codeChallengeS256, generateCodeVerifier, oauthFailure } from "../connectors/oauth.ts";
import { chatgptAccountIdFromTokens, tokenExpiry } from "./chatgpt-auth-file.ts";
import { sleep } from "../util/async.ts";
import type { UserOAuthTokens } from "./user-model-credential-store.ts";

const CHATGPT_ISSUER = "https://auth.openai.com";
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_SCOPE = "openid profile email offline_access";
const CHATGPT_DEVICE_CODE_LIFETIME_MS = 15 * 60_000;
const DEVICE_CODE_SLOW_DOWN_MS = 5_000;

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_REDIRECT = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_SCOPE = "org:create_api_key user:profile user:inference";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

async function tokenResponse(res: Response, label: string): Promise<TokenResponse> {
  if (!res.ok) throw await oauthFailure(label, res);
  const raw = (await res.json()) as Partial<TokenResponse>;
  if (!raw.access_token) throw new Error(`${label} missing access_token`);
  return raw as TokenResponse;
}

async function postToken(url: string, body: Record<string, string>, label: string): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return tokenResponse(res, label);
}

function chatgptTokens(raw: TokenResponse, refreshToken?: string): UserOAuthTokens {
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? refreshToken,
    idToken: raw.id_token,
    accountId: chatgptAccountIdFromTokens(raw.id_token, raw.access_token),
    expiresAt: tokenExpiry(raw),
  };
}

export interface ChatGPTDevicePrompt {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
}

export async function refreshChatGPTTokens(refreshToken: string): Promise<UserOAuthTokens> {
  const raw = await postToken(
    `${CHATGPT_ISSUER}/oauth/token`,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CHATGPT_CLIENT_ID, scope: CHATGPT_SCOPE },
    "chatgpt refresh",
  );
  return chatgptTokens(raw, refreshToken);
}

export async function startChatGPTDeviceLogin(): Promise<ChatGPTDevicePrompt> {
  const res = await fetch(`${CHATGPT_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw await oauthFailure("chatgpt device code request", res);
  const raw = (await res.json()) as { device_auth_id?: unknown; user_code?: unknown; interval?: unknown };
  const intervalSeconds = Number(raw.interval);
  if (typeof raw.device_auth_id !== "string" || typeof raw.user_code !== "string" || !(intervalSeconds >= 0))
    throw new Error("chatgpt device code response missing fields");
  return {
    deviceAuthId: raw.device_auth_id,
    userCode: raw.user_code,
    verificationUrl: `${CHATGPT_ISSUER}/codex/device`,
    intervalMs: intervalSeconds * 1000,
    expiresAt: Date.now() + CHATGPT_DEVICE_CODE_LIFETIME_MS,
  };
}

export async function pollChatGPTDeviceLogin(
  deviceAuthId: string,
  userCode: string,
): Promise<UserOAuthTokens | "pending"> {
  const res = await fetch(`${CHATGPT_ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403 || res.status === 404) return "pending";
  const body = (await res.json().catch(() => undefined)) as
    { error?: unknown; authorization_code?: unknown; code_verifier?: unknown } | undefined;
  if (!res.ok) {
    const error = body?.error;
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : error;
    if (code === "slow_down") {
      await sleep(DEVICE_CODE_SLOW_DOWN_MS);
      return "pending";
    }
    if (code === "deviceauth_authorization_pending") return "pending";
    throw await oauthFailure("chatgpt device login", { status: res.status, json: async () => body });
  }
  if (typeof body?.authorization_code !== "string" || typeof body.code_verifier !== "string")
    throw new Error("chatgpt device login response missing authorization code");
  const exchange = await fetch(`${CHATGPT_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CHATGPT_CLIENT_ID,
      code: body.authorization_code,
      code_verifier: body.code_verifier,
      redirect_uri: `${CHATGPT_ISSUER}/deviceauth/callback`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokens = chatgptTokens(await tokenResponse(exchange, "chatgpt device login token exchange"));
  if (!tokens.refreshToken || !tokens.accountId)
    throw new Error("ChatGPT login completed without a usable subscription token");
  return tokens;
}

export interface ClaudeAuthStart {
  authorizeUrl: string;
  verifier: string;
}

export function startClaudeLogin(): ClaudeAuthStart {
  const verifier = generateCodeVerifier();
  const challenge = codeChallengeS256(verifier);
  const url = new URL(CLAUDE_AUTHORIZE);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_REDIRECT);
  url.searchParams.set("scope", CLAUDE_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", verifier);
  return { authorizeUrl: url.toString(), verifier };
}

export async function completeClaudeLogin(pastedCode: string, verifier: string): Promise<UserOAuthTokens> {
  const [code = "", state] = pastedCode.trim().split("#");
  const raw = await postToken(
    CLAUDE_TOKEN,
    {
      grant_type: "authorization_code",
      client_id: CLAUDE_CLIENT_ID,
      code,
      state: state ?? verifier,
      code_verifier: verifier,
      redirect_uri: CLAUDE_REDIRECT,
    },
    "claude token exchange",
  );
  return { accessToken: raw.access_token, refreshToken: raw.refresh_token, expiresAt: tokenExpiry(raw) };
}

export async function refreshClaudeTokens(refreshToken: string): Promise<UserOAuthTokens> {
  const raw = await postToken(
    CLAUDE_TOKEN,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID },
    "claude refresh",
  );
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? refreshToken,
    expiresAt: tokenExpiry(raw),
  };
}
