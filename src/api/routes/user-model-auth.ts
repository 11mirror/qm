import { isPersonalModelProvider, type PersonalModelProvider } from "../../model/user-model-credential-store.ts";
import {
  completeClaudeLogin,
  pollChatGPTDeviceLogin,
  startChatGPTDeviceLogin,
  startClaudeLogin,
} from "../../model/subscription-oauth.ts";
import { errMessage } from "../../util/errors.ts";
import { fail } from "../http.ts";
import { validateProviderApiKey } from "./admin/model-providers.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult, withActor } from "./route.ts";
import { audit, isObj } from "./shared.ts";

type Store = NonNullable<ApiCtx["deps"]["userModelCredentials"]>;

function signedIn(
  handle: (ctx: ApiCtx, principal: string) => Promise<RouteResult>,
): (ctx: ApiCtx) => Promise<RouteResult> {
  return async (ctx) => {
    if (!ctx.actor?.p) throw fail(401, "unauthorized");
    return handle(ctx, ctx.actor.p);
  };
}

function withStore(
  handle: (ctx: ApiCtx, principal: string, store: Store) => Promise<RouteResult>,
): (ctx: ApiCtx) => Promise<RouteResult> {
  return signedIn(async (ctx, principal) => {
    const store = ctx.deps.userModelCredentials;
    return store ? handle(ctx, principal, store) : reply(404, { error: "not_found" });
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

function connectProvider(raw: unknown): PersonalModelProvider | null {
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  if (raw === "openai" || raw === "chatgpt" || raw === "codex") return "openai";
  return null;
}

const getStatus = signedIn(async (ctx, principal) => {
  const required = (await ctx.deps.config?.getIndividualModelAuthDurable()) ?? false;
  const connections = (await ctx.deps.userModelCredentials?.connections(principal)) ?? [];
  const individualModelAuth = (await ctx.deps.config?.getIndividualModelAuthDurable(principal)) ?? false;
  const account = (await ctx.deps.config?.getModelAccountDurable(principal)) ?? "company";
  return ok({ individualModelAuth, required, account, connections });
});

const setAccount = withStore(async (ctx, principal, store) => {
  const config = ctx.deps.config;
  if (!config) throw fail(404, "not_found");
  const { account, provider } = bodyObj(ctx);
  if (account !== "personal" && account !== "company") throw fail(400, "bad_request");
  if (account === "company" && (await config.getIndividualModelAuthDurable()))
    throw fail(403, "Your organization requires a personal AI account.");
  if (account === "personal" && !(await store.connections(principal)).length)
    throw fail(409, "Connect an AI account first.");
  if (provider !== undefined && !isPersonalModelProvider(provider)) throw fail(400, "bad_request");
  if (account === "personal" && provider && !(await store.connections(principal)).some((c) => c.provider === provider))
    throw fail(409, "Connect this AI account first.");
  await config.setPersonalModelAuth(principal, account === "personal", provider);
  auditAuth(ctx, principal, "account", account);
  return getStatus(ctx);
});

const PROVIDER_REQUIRED = { error: "bad_request", message: "provider must be claude or chatgpt" };

const disconnect = withStore(async (ctx, principal, store) => {
  const provider = connectProvider(bodyObj(ctx).provider);
  if (!provider) return reply(400, PROVIDER_REQUIRED);
  await store.delete(principal, provider);
  auditAuth(ctx, principal, "disconnect", provider);
  return ok({ ok: true });
});

const putApiKey = withStore(async (ctx, principal, store) => {
  const provider = connectProvider(bodyObj(ctx).provider);
  const apiKey = bodyString(ctx, "apiKey").trim();
  if (!provider) return reply(400, PROVIDER_REQUIRED);
  if (!apiKey) throw fail(400, "bad_request", "API key is required");
  if (!(await validateProviderApiKey(ctx, provider, apiKey)))
    throw fail(400, "invalid_api_key", `${provider} rejected this API key`);
  await store.setApiKey(principal, provider, apiKey);
  auditAuth(ctx, principal, "api-key", provider);
  return ok({ ok: true });
});

const chatgptStart = signedIn(async () => {
  try {
    return ok(await startChatGPTDeviceLogin());
  } catch (e) {
    return reply(502, { error: "oauth_start_failed", message: errMessage(e) });
  }
});

const chatgptPoll = withStore(async (ctx, principal, store) => {
  const deviceAuthId = bodyString(ctx, "deviceAuthId");
  const userCode = bodyString(ctx, "userCode");
  if (!deviceAuthId || !userCode) throw fail(400, "bad_request");
  try {
    const result = await pollChatGPTDeviceLogin(deviceAuthId, userCode);
    if (result === "pending") return ok({ status: "pending" });
    await store.setOAuth(principal, "openai", result);
    auditAuth(ctx, principal, "oauth", "openai");
    return ok({ status: "connected" });
  } catch (e) {
    return reply(502, { error: "oauth_poll_failed", message: errMessage(e) });
  }
});

const claudeStart = signedIn(async () => ok(startClaudeLogin()));

const claudeComplete = withStore(async (ctx, principal, store) => {
  const code = bodyString(ctx, "code");
  const verifier = bodyString(ctx, "verifier");
  if (!code || !verifier) throw fail(400, "bad_request");
  try {
    await store.setOAuth(principal, "anthropic", await completeClaudeLogin(code, verifier));
    auditAuth(ctx, principal, "oauth", "anthropic");
    return ok({ ok: true });
  } catch (e) {
    return reply(502, { error: "oauth_complete_failed", message: errMessage(e) });
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
