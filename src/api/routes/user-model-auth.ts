import type { ModelProvider } from "../../model/pi-models.ts";
import { completeClaudeLogin, startClaudeLogin } from "../../model/subscription-oauth.ts";
import { createCodexDeviceLogin } from "../../model/codex-device-login.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { validateProviderApiKey } from "./admin/model-providers.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";
import { audit, isObj } from "./shared.ts";

type Store = NonNullable<ApiCtx["deps"]["userModelCredentials"]>;

function signedIn(handle: (ctx: ApiCtx, principal: string) => Promise<void>): (ctx: ApiCtx) => Promise<void> {
  return async (ctx) => (ctx.actor?.p ? handle(ctx, ctx.actor.p) : sendJson(ctx.res, 401, { error: "unauthorized" }));
}

function withStore(
  handle: (ctx: ApiCtx, principal: string, store: Store) => Promise<void>,
): (ctx: ApiCtx) => Promise<void> {
  return signedIn(async (ctx, principal) => {
    const store = ctx.deps.userModelCredentials;
    return store ? handle(ctx, principal, store) : sendJson(ctx.res, 404, { error: "not_found" });
  });
}

function bodyObj(ctx: ApiCtx): Record<string, unknown> {
  return isObj(ctx.body) ? ctx.body : {};
}

function bodyString(ctx: ApiCtx, name: string): string {
  const value = bodyObj(ctx)[name];
  return typeof value === "string" ? value : "";
}

function auditAuth(ctx: ApiCtx, principal: string, action: string, resource: string): void {
  audit(ctx.deps, { principalId: principal, action: `user-model-auth.${action}`, resource, scopeLabel: principal });
}

function connectProvider(raw: unknown): ModelProvider | null {
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  if (raw === "openai" || raw === "chatgpt" || raw === "codex") return "openai";
  return null;
}

const getStatus = signedIn(async (ctx, principal) => {
  const required = (await ctx.deps.config?.getIndividualModelAuthDurable()) ?? false;
  const connections = (await ctx.deps.userModelCredentials?.connections(principal)) ?? [];
  const individualModelAuth = (await ctx.deps.config?.getIndividualModelAuthDurable(principal)) ?? false;
  const account = (await ctx.deps.config?.getModelAccountDurable(principal)) ?? "company";
  return sendJson(ctx.res, 200, { individualModelAuth, required, account, connections });
});

const setAccount = withStore(async (ctx, principal, store) => {
  const config = ctx.deps.config;
  if (!config) return sendJson(ctx.res, 404, { error: "not_found" });
  const { account, provider } = bodyObj(ctx);
  if (account !== "personal" && account !== "company") return sendJson(ctx.res, 400, { error: "bad_request" });
  if (account === "company" && (await config.getIndividualModelAuthDurable())) {
    return sendJson(ctx.res, 403, { error: "Your organization requires a personal AI account." });
  }
  if (account === "personal" && !(await store.connections(principal)).length) {
    return sendJson(ctx.res, 409, { error: "Connect an AI account first." });
  }
  if (provider !== undefined && provider !== "anthropic" && provider !== "openai")
    return sendJson(ctx.res, 400, { error: "bad_request" });
  if (account === "personal" && provider && !(await store.connections(principal)).some((c) => c.provider === provider))
    return sendJson(ctx.res, 409, { error: "Connect this AI account first." });
  await config.setPersonalModelAuth(principal, account === "personal", provider);
  auditAuth(ctx, principal, "account", account);
  return getStatus(ctx);
});

const PROVIDER_REQUIRED = { error: "bad_request", message: "provider must be claude or chatgpt" };

const disconnect = withStore(async (ctx, principal, store) => {
  const provider = connectProvider(bodyObj(ctx).provider);
  if (!provider) return sendJson(ctx.res, 400, PROVIDER_REQUIRED);
  await store.delete(principal, provider);
  auditAuth(ctx, principal, "disconnect", provider);
  return sendJson(ctx.res, 200, { ok: true });
});

const putApiKey = withStore(async (ctx, principal, store) => {
  const provider = connectProvider(bodyObj(ctx).provider);
  const apiKey = bodyString(ctx, "apiKey").trim();
  if (!provider) return sendJson(ctx.res, 400, PROVIDER_REQUIRED);
  if (!apiKey) return sendJson(ctx.res, 400, { error: "bad_request", message: "API key is required" });
  if (!(await validateProviderApiKey(ctx, provider, apiKey))) {
    return sendJson(ctx.res, 400, { error: "invalid_api_key", message: `${provider} rejected this API key` });
  }
  await store.setApiKey(principal, provider, apiKey);
  auditAuth(ctx, principal, "api-key", provider);
  return sendJson(ctx.res, 200, { ok: true });
});

const codexDeviceLogin = createCodexDeviceLogin();

const chatgptStart = signedIn(async (ctx) => {
  try {
    return sendJson(ctx.res, 200, await codexDeviceLogin.start());
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "oauth_start_failed", message: errMessage(e) });
  }
});

const chatgptPoll = withStore(async (ctx, principal, store) => {
  const deviceAuthId = bodyString(ctx, "deviceAuthId");
  if (!deviceAuthId) return sendJson(ctx.res, 400, { error: "bad_request" });
  try {
    const result = await codexDeviceLogin.poll(deviceAuthId);
    if (result === "pending") return sendJson(ctx.res, 200, { status: "pending" });
    await store.setOAuth(principal, "openai", result);
    auditAuth(ctx, principal, "oauth", "openai");
    return sendJson(ctx.res, 200, { status: "connected" });
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "oauth_poll_failed", message: errMessage(e) });
  }
});

const claudeStart = signedIn(async (ctx) => sendJson(ctx.res, 200, startClaudeLogin()));

const claudeComplete = withStore(async (ctx, principal, store) => {
  const code = bodyString(ctx, "code");
  const verifier = bodyString(ctx, "verifier");
  if (!code || !verifier) return sendJson(ctx.res, 400, { error: "bad_request" });
  try {
    await store.setOAuth(principal, "anthropic", await completeClaudeLogin(code, verifier));
    auditAuth(ctx, principal, "oauth", "anthropic");
    return sendJson(ctx.res, 200, { ok: true });
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "oauth_complete_failed", message: errMessage(e) });
  }
});
export const userModelAuthRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/user-model-auth/status", actor: "query.principalId", auth: "source", handle: getStatus },
  ...withActor("body.principalId", [
    { method: "POST", path: "/v1/user-model-auth/account", auth: "source", handle: setAccount },
    { method: "POST", path: "/v1/user-model-auth/api-key", auth: "source", handle: putApiKey },
    { method: "POST", path: "/v1/user-model-auth/disconnect", auth: "source", handle: disconnect },
    { method: "POST", path: "/v1/user-model-auth/chatgpt/start", auth: "source", handle: chatgptStart },
    { method: "POST", path: "/v1/user-model-auth/chatgpt/poll", auth: "source", handle: chatgptPoll },
    { method: "POST", path: "/v1/user-model-auth/claude/start", auth: "source", handle: claudeStart },
    { method: "POST", path: "/v1/user-model-auth/claude/complete", auth: "source", handle: claudeComplete },
  ]),
];
