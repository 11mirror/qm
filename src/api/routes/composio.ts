import { activeCapabilityRun } from "../../runs/capability-run.ts";
import { slackReply } from "./slack-reply.ts";
import { isBackendCredential } from "../../credentials/keychain.ts";
import { livePersonCapability } from "../artifact-share.ts";
import { mintSignedPayload } from "../../auth/signed-token.ts";
import { canonicalPerson, personIds } from "../../directory/person.ts";
import { createHash } from "node:crypto";
import { scopeId } from "../../types.ts";
import { parseRef } from "../../acl/resource-ref.ts";
import { principalEntitledToScope } from "../../resolution/context-filter.ts";
import { sendJson } from "../http.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { createExactSecretValueMasker } from "../../security/secret-masking.ts";
import { errMessage, httpFailure, reportFailure } from "../../util/errors.ts";
import { activePrincipal, audit } from "./shared.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult } from "./route.ts";
import { tenant } from "../../tenant.ts";
import { slackStatus, completeSlack } from "./composio-slack.ts";

const TOOLKIT_SLUG = /^[a-z0-9_-]{1,100}$/;
const UPSTREAM_SLUG = /^[a-zA-Z0-9_-]{1,100}$/;
export const ACCOUNT_ID = /^ca_[a-zA-Z0-9_-]+$/;

export function composioUserId(org: string, principal: string): string {
  return `qm_${createHash("sha256")
    .update(JSON.stringify([org, principal]))
    .digest("hex")}`;
}

export function composioUserIds(principal: string): string[] {
  return [...new Set(personIds(principal).map((id) => composioUserId(tenant().orgId, id)))];
}

export async function activeRun(ctx: ApiCtx): Promise<boolean> {
  const cap = ctx.capability;
  if (!cap || (await activeCapabilityRun(ctx.deps.runs, cap))) return true;
  sendJson(ctx.res, 403, {
    error: "inactive_run",
    message: "Connected app access requires this run's current capability.",
  });
  return false;
}

type Access = { key: string; principal: string };
type Denial = { status: number; body: { error: string; message?: string } };

function deny(status: number, error: string, message?: string): Denial {
  return { status, body: { error, ...(message ? { message } : {}) } };
}

export async function credential(ctx: ApiCtx): Promise<Access | null> {
  if (!(await activeRun(ctx))) return null;
  const access = await resolveCredential(ctx);
  if ("key" in access) return access;
  sendJson(ctx.res, access.status, access.body);
  return null;
}

async function resolveCredential(ctx: ApiCtx): Promise<Access | Denial> {
  const principal = ctx.capability?.actorId ?? ctx.actor?.p;
  if (!principal) return deny(401, "unauthorized");
  if (!(await activePrincipal(ctx.deps, principal))) return deny(403, "forbidden");
  const personal = scopeId("personal", principal);
  const cap = ctx.capability;
  if (cap && (cap.ownerConnections !== true || cap.deployment || cap.botActor))
    return deny(
      403,
      "private_connections",
      "Use your connected apps in your own conversation, or on a turn a person started in this conversation.",
    );
  const own = (await ctx.deps.keychain?.listByOwner(principal)) ?? [];
  const candidates = own.filter(
    (c) => c.kind === "env" && isBackendCredential(c) && (!c.expiresAt || c.expiresAt > Date.now()),
  );
  if (candidates.length > 1)
    return deny(409, "ambiguous_credential", "Choose a single Composio credential in your keychain.");
  if (candidates.length === 1) {
    const key = await ctx.deps.keychain!.composioKey(principal, candidates[0]!.id);
    return key ? { key, principal } : deny(503, "credential_unavailable");
  }
  const org = tenant().orgScope;
  const identity = ctx.deps.identity?.classify(principal) ?? { id: principal, type: "internal" as const };
  const audience = cap && cap.scopeId !== personal ? cap.keychainMembers : [identity];
  if (!audience?.length || audience.some((member) => member.type !== "internal")) return deny(403, "unknown_audience");
  const grants =
    (await ctx.deps.acl?.grantsOfKind(
      "service-cred",
      audience,
      cap?.scopeId ?? personal,
      org,
      principalEntitledToScope,
    )) ?? [];
  const allowed = new Set(grants.map((g) => parseRef(g.ref).id));
  const records = ((await ctx.deps.serviceCreds?.listServiceCredentials(org)) ?? []).filter(
    (c) => c.enabled && c.hasSecret && c.delivery === "env" && c.envKey === "COMPOSIO_API_KEY" && allowed.has(c.slug),
  );
  if (records.length !== 1)
    return deny(
      records.length ? 409 : 403,
      "composio_unavailable",
      "App connections aren’t available for your account yet. Ask your administrator to enable them.",
    );
  const record = await ctx.deps.serviceCreds!.getServiceCredentialSecret(org, records[0]!.slug);
  if (!record?.enabled || record.delivery !== "env" || record.envKey !== "COMPOSIO_API_KEY" || !record.secret)
    return deny(403, "composio_unavailable");
  return { key: record.secret, principal };
}

class ComposioHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function executeFailureCause(error: unknown, timedOut: boolean): string {
  if (timedOut) return "timeout";
  return error instanceof ComposioHttpError ? "provider_error" : "unavailable";
}

const EXECUTE_TIMEOUT_MS = 90_000;

export function reportComposioFailure(context: string, key: string, error: unknown, detail?: string): void {
  reportFailure(context, new Error(createExactSecretValueMasker([key])(redactSecrets(errMessage(error)))), detail);
}

function nextCursor(data: Record<string, unknown>): string | null {
  return typeof data.next_cursor === "string" ? data.next_cursor : null;
}

export function activeAccount(
  owned: { account: Record<string, unknown>; toolkit: string } | null,
  toolkit?: string,
): owned is { account: Record<string, unknown>; toolkit: string } {
  return Boolean(
    owned &&
    owned.account.status === "ACTIVE" &&
    owned.account.is_disabled !== true &&
    (!toolkit || owned.toolkit === toolkit),
  );
}

export async function stillAuthorized(
  ctx: ApiCtx,
  principal: string,
  account: Record<string, unknown>,
): Promise<boolean> {
  if (!(await activeRun(ctx))) return false;
  if (composioUserIds(principal).includes(String(account.user_id))) return true;
  sendJson(ctx.res, 403, { error: "connection_not_authorized" });
  return false;
}

export async function request(
  ctx: ApiCtx,
  key: string,
  path: string,
  body?: unknown,
  timeoutMs = 20_000,
  method = body ? "POST" : "GET",
): Promise<Record<string, unknown>> {
  const response = await (ctx.deps.composioFetch ?? fetch)(`https://backend.composio.dev/api/v3.1${path}`, {
    method,
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new ComposioHttpError(response.status, `Composio request failed: ${await httpFailure(response)}`);
  return (await response.json()) as Record<string, unknown>;
}

async function catalog(ctx: ApiCtx): Promise<RouteResult> {
  const access = await credential(ctx);
  if (!access) return;
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  if (cursor.length > 2048) return reply(400, { error: "bad_cursor" });
  const query = new URLSearchParams({ sort_by: "usage", limit: "1000" });
  if (cursor) query.set("cursor", cursor);
  try {
    const data = await request(ctx, access.key, `/toolkits?${query}`);
    if (!Array.isArray(data.items)) throw new Error("Invalid catalog");
    const items = data.items.flatMap((item) => {
      if (
        !item ||
        typeof item.slug !== "string" ||
        !TOOLKIT_SLUG.test(item.slug) ||
        typeof item.name !== "string" ||
        (Array.isArray(item.auth_schemes) && item.auth_schemes.every((scheme: unknown) => scheme === "NO_AUTH"))
      )
        return [];
      return [
        {
          id: item.slug,
          logoUrl: `https://logos.composio.dev/api/${item.slug}`,
          name: item.name,
          description: typeof item.meta?.description === "string" ? item.meta.description : "",
        },
      ];
    });
    return ok({ items, nextCursor: nextCursor(data) });
  } catch (error) {
    reportComposioFailure("composio: catalog", access.key, error);
    return reply(502, { error: "composio_unavailable", message: "Could not load apps. Please try again." });
  }
}

function validCallback(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 4096 || !URL.canParse(value)) return false;
  const callback = new URL(value);
  return (
    !callback.username &&
    !callback.password &&
    !callback.hash &&
    (callback.protocol === "https:" ||
      (callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)))
  );
}

async function authorize(ctx: ApiCtx, linkSlack = false): Promise<RouteResult> {
  if (ctx.capability && !livePersonCapability(ctx.capability)) return reply(403, { error: "human_consent_required" });
  const access = await credential(ctx);
  if (!access) return;
  const toolkit = linkSlack ? "slack" : (ctx.body as { toolkit?: unknown } | null)?.toolkit;
  if (linkSlack && (!ctx.deps.signingSecret || !ctx.deps.principalLinks || ctx.actor?.imp))
    return reply(403, { error: "link_unavailable", message: "Sign in as yourself to connect Slack." });
  if (typeof toolkit !== "string" || !TOOLKIT_SLUG.test(toolkit)) return reply(400, { error: "invalid_toolkit" });
  const callbackUrl = (ctx.body as { callbackUrl?: unknown }).callbackUrl;
  if (callbackUrl !== undefined && !validCallback(callbackUrl)) return reply(400, { error: "invalid_callback" });
  const userId = composioUserId(tenant().orgId, canonicalPerson(access.principal));
  try {
    const session = await request(ctx, access.key, "/tool_router/session", {
      user_id: userId,
      toolkits: { enable: [toolkit] },
      manage_connections: { enable: false },
      workbench: { enable: false },
    });
    if (typeof session.session_id !== "string" || !/^trs_[a-zA-Z0-9_-]+$/.test(session.session_id))
      throw new Error("Invalid session");
    const link = await request(ctx, access.key, `/tool_router/session/${encodeURIComponent(session.session_id)}/link`, {
      toolkit,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    });
    if (typeof link.connected_account_id !== "string" || !ACCOUNT_ID.test(link.connected_account_id))
      throw new Error("Invalid account");
    await ctx.deps.composioReturns?.put(`${userId}:${link.connected_account_id}`, {
      url: typeof callbackUrl === "string" ? callbackUrl : null,
      toolkit,
      expiresAt: Date.now() + 20 * 60_000,
    });
    const url = new URL(String(link.redirect_url));
    if (
      !(
        (url.origin === "https://connect.composio.dev" && /^\/link\/lk_[a-zA-Z0-9_-]+$/.test(url.pathname)) ||
        (url.origin === "https://app.composio.dev" && /^\/link\/lt_[a-zA-Z0-9_-]+$/.test(url.pathname))
      ) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid authorization URL");
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.authorize",
      resource: toolkit,
      scopeLabel: scopeId("personal", access.principal),
    });
    const ticket = linkSlack
      ? await mintSignedPayload(
          {
            purpose: "slack-account-link",
            principal: access.principal,
            org: tenant().orgId,
            accountId: link.connected_account_id,
            exp: Date.now() + 20 * 60_000,
          },
          ctx.deps.signingSecret!,
        )
      : undefined;
    return ok({
      url: url.href,
      accountId: link.connected_account_id,
      ...(ticket ? { ticket } : {}),
    });
  } catch (error) {
    reportComposioFailure("composio: authorize", access.key, error, `toolkit=${toolkit}`);
    return reply(502, {
      error: "composio_authorization_failed",
      message: "Could not start authorization. Please try again.",
    });
  }
}

export async function ownedAccount(
  ctx: ApiCtx,
  access: Access,
  accountId: string,
): Promise<{ account: Record<string, unknown>; toolkit: string } | null> {
  const account = await request(ctx, access.key, `/connected_accounts/${encodeURIComponent(accountId)}`);
  const toolkit = (account.toolkit as { slug?: string } | undefined)?.slug;
  return account.id === accountId &&
    typeof account.user_id === "string" &&
    composioUserIds(access.principal).includes(account.user_id) &&
    toolkit &&
    toolkit !== "composio"
    ? { account, toolkit }
    : null;
}

const SCOPES_TTL_MS = 5 * 60_000;
const scopeCache = new Map<string, { scopes: string[]; expiresAt: number }>();

async function configuredScopes(ctx: ApiCtx, key: string, authConfigId: string): Promise<string[]> {
  const cacheKey = `${tenant().orgId}:${authConfigId}`;
  const cached = scopeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.scopes;
  try {
    const config = await request(ctx, key, `/auth_configs/${encodeURIComponent(authConfigId)}`);
    const listed = (config.credentials as { scopes?: unknown } | undefined)?.scopes;
    const scopes = Array.isArray(listed) ? listed.filter((scope): scope is string => typeof scope === "string") : [];
    scopeCache.set(cacheKey, { scopes, expiresAt: Date.now() + SCOPES_TTL_MS });
    return scopes;
  } catch (error) {
    reportComposioFailure("composio: auth config scopes", key, error, authConfigId);
    return [];
  }
}

function scopeName(scope: string): string {
  return scope.slice(scope.lastIndexOf("/") + 1) || scope;
}

function missingScopes(account: { state?: { val?: { scope?: unknown } } }, configured: string[]): string[] {
  const granted = account.state?.val?.scope;
  if (typeof granted !== "string" || !granted.trim()) return [];
  const held = new Set(granted.split(/[\s,]+/).map(scopeName));
  return configured.filter((scope) => !held.has(scopeName(scope)));
}

async function connections(ctx: ApiCtx): Promise<RouteResult> {
  const access = await credential(ctx);
  if (!access) return;
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  if (cursor.length > 2048) return reply(400, { error: "bad_cursor" });
  const userIds = composioUserIds(access.principal);
  const query = new URLSearchParams({ user_ids: userIds.join(","), statuses: "ACTIVE", limit: "100" });
  if (cursor) query.set("cursor", cursor);
  try {
    const data = await request(ctx, access.key, `/connected_accounts?${query}`);
    if (!Array.isArray(data.items)) throw new Error("Invalid accounts");
    const accounts = data.items.filter(
      (item) =>
        item &&
        userIds.includes(item.user_id) &&
        item.status === "ACTIVE" &&
        item.is_disabled !== true &&
        typeof item.id === "string" &&
        ACCOUNT_ID.test(item.id) &&
        typeof item.toolkit?.slug === "string" &&
        UPSTREAM_SLUG.test(item.toolkit.slug),
    );
    const configIds = [
      ...new Set(
        accounts
          .map((item) => item.auth_config?.id)
          .filter((id): id is string => typeof id === "string" && /^ac_[a-zA-Z0-9_-]+$/.test(id)),
      ),
    ];
    const scopes = new Map(
      await Promise.all(configIds.map(async (id) => [id, await configuredScopes(ctx, access.key, id)] as const)),
    );
    const items = accounts.map((item) => ({
      id: item.id,
      toolkit: item.toolkit.slug,
      userId: item.user_id,
      missingScopes: missingScopes(item, scopes.get(item.auth_config?.id) ?? []),
    }));
    ctx.res.setHeader("Cache-Control", "no-store");
    return ok({ items, nextCursor: nextCursor(data) });
  } catch (error) {
    reportComposioFailure("composio: connections", access.key, error);
    return reply(502, {
      error: "composio_unavailable",
      message: "Could not check connected apps. Please try again.",
    });
  }
}

async function disconnect(ctx: ApiCtx): Promise<RouteResult> {
  if ((ctx.capability && !livePersonCapability(ctx.capability)) || ctx.actor?.imp)
    return reply(403, { error: "human_consent_required" });
  const access = await credential(ctx);
  if (!access) return;
  const accountId = (ctx.body as { accountId?: unknown } | null)?.accountId;
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) return reply(400, { error: "invalid_account" });
  try {
    const owned = await ownedAccount(ctx, access, accountId);
    if (!owned) return reply(403, { error: "connection_not_authorized" });
    const { toolkit } = owned;
    if (!(await activeRun(ctx))) return;
    await request(ctx, access.key, `/connected_accounts/${encodeURIComponent(accountId)}`, undefined, 20_000, "DELETE");
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.disconnected",
      resource: `${toolkit}/${accountId}`,
      scopeLabel: ctx.capability?.scopeId ?? scopeId("personal", access.principal),
    });
    return ok({ disconnected: accountId, toolkit });
  } catch (error) {
    if (error instanceof ComposioHttpError && error.status === 404)
      return reply(404, { error: "connection_not_found" });
    reportComposioFailure("composio: disconnect", access.key, error);
    return reply(502, {
      error: "composio_disconnect_failed",
      message: "Could not disconnect the app. Please try again.",
    });
  }
}

async function tools(ctx: ApiCtx): Promise<RouteResult> {
  const access = await credential(ctx);
  if (!access) return;
  const toolkit = ctx.url.searchParams.get("toolkit") ?? "";
  const query = ctx.url.searchParams.get("query") ?? "";
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  if (!TOOLKIT_SLUG.test(toolkit) || query.length > 1000 || cursor.length > 2048)
    return reply(400, { error: "invalid_query" });
  const params = new URLSearchParams({ toolkit_slug: toolkit, query, limit: "25", toolkit_versions: "latest" });
  if (cursor) params.set("cursor", cursor);
  try {
    const data = await request(ctx, access.key, `/tools?${params}`);
    if (!Array.isArray(data.items)) throw new Error("Invalid tools");
    const items = data.items
      .filter((item) => item?.toolkit?.slug === toolkit)
      .map((item) => ({
        slug: item.slug,
        name: item.name,
        description: item.description,
        version: item.version,
        input_parameters: item.input_parameters,
      }));
    return ok({ items, nextCursor: nextCursor(data) });
  } catch (error) {
    reportComposioFailure("composio: tools", access.key, error);
    return reply(502, { error: "composio_unavailable" });
  }
}

async function execute(ctx: ApiCtx): Promise<RouteResult> {
  if (!ctx.capability || ctx.actor) return reply(403, { error: "agent_capability_required" });
  const access = await credential(ctx);
  if (!access) return;
  const body = ctx.body as Record<string, unknown> | null;
  if (
    !body ||
    Object.keys(body).some((key) => !["tool", "accountId", "version", "arguments"].includes(key)) ||
    typeof body.tool !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,199}$/.test(body.tool) ||
    body.tool.startsWith("COMPOSIO_") ||
    typeof body.accountId !== "string" ||
    !ACCOUNT_ID.test(body.accountId) ||
    typeof body.version !== "string" ||
    !UPSTREAM_SLUG.test(body.version) ||
    body.version === "latest" ||
    !body.arguments ||
    typeof body.arguments !== "object" ||
    Array.isArray(body.arguments)
  )
    return reply(400, {
      error: "invalid_execution",
      message: "Supply tool, accountId, a concrete version, and arguments only.",
    });
  const scopeLabel = ctx.capability.scopeId;
  const resource = `${body.accountId}/${body.tool}@${body.version}`;
  const auditExecution = (outcome: string) =>
    audit(ctx.deps, { principalId: access.principal, action: `composio.execute.${outcome}`, resource, scopeLabel });
  try {
    const owned = await ownedAccount(ctx, access, body.accountId);
    if (!activeAccount(owned)) return reply(403, { error: "connection_not_authorized" });
    const { account, toolkit } = owned;
    const tool = await request(
      ctx,
      access.key,
      `/tools/${body.tool}?${new URLSearchParams({ toolkit_versions: body.version })}`,
    );
    if (
      tool.slug !== body.tool ||
      (tool.toolkit as { slug?: string } | undefined)?.slug !== toolkit ||
      tool.version !== body.version
    )
      return reply(403, { error: "tool_not_authorized" });
    if (!(await stillAuthorized(ctx, access.principal, account))) return;
    auditExecution("started");
    const result = await request(
      ctx,
      access.key,
      `/tools/execute/${body.tool}`,
      {
        user_id: account.user_id,
        connected_account_id: body.accountId,
        version: body.version,
        arguments: body.arguments,
      },
      EXECUTE_TIMEOUT_MS,
    );
    auditExecution("completed");
    return ok({
      data: result.data,
      successful: result.successful === true,
      error: result.error ?? null,
    });
  } catch (error) {
    auditExecution("failed");
    reportComposioFailure("composio: execute", access.key, error, `tool=${body.tool}`);
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return reply(502, {
      error: "composio_execution_failed",
      cause: executeFailureCause(error, timedOut),
      ...(error instanceof ComposioHttpError ? { providerStatus: error.status } : {}),
      message:
        timedOut || (error instanceof ComposioHttpError && error.status === 413)
          ? "The request was too large to complete. For reads, request less per call (smaller pages, metadata before bodies). Do not automatically retry a write."
          : "Execution failed or its outcome is unknown. Do not automatically retry a write.",
    });
  }
}

async function completeAuth(ctx: ApiCtx): Promise<RouteResult> {
  if (!ctx.actor || ctx.actor.imp || ctx.capability) return reply(403, { error: "browser_identity_required" });
  const access = await credential(ctx);
  if (!access) return;
  const connectFailed = () =>
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.connect_failed",
      resource: "unknown",
      scopeLabel: scopeId("personal", access.principal),
    });
  const sessionUri = (ctx.body as { sessionUri?: unknown } | null)?.sessionUri;
  if (typeof sessionUri !== "string" || !sessionUri || sessionUri.length > 8192) {
    connectFailed();
    return reply(400, { error: "invalid_session" });
  }
  const userId = composioUserId(tenant().orgId, canonicalPerson(access.principal));
  let accountId: string;
  try {
    const result = await request(ctx, access.key, "/connected_accounts/complete_auth", {
      session_uri: sessionUri,
      user_id: userId,
    });
    if (typeof result.connected_account_id !== "string" || !ACCOUNT_ID.test(result.connected_account_id))
      throw new Error("Invalid account");
    accountId = result.connected_account_id;
  } catch (error) {
    reportComposioFailure("composio: complete-auth", access.key, error);
    connectFailed();
    return reply(400, {
      error: "verification_failed",
      message: "Sign in to the QM account that started this connection and try connecting again.",
    });
  }
  const key = `${userId}:${accountId}`;
  const saved = await ctx.deps.composioReturns?.take(key);
  audit(ctx.deps, {
    principalId: access.principal,
    action: "composio.connected",
    resource: saved?.toolkit ?? "unknown",
    scopeLabel: scopeId("personal", access.principal),
  });
  return ok({ returnTo: saved && saved.expiresAt > Date.now() ? saved.url : null });
}

async function identity(ctx: ApiCtx): Promise<RouteResult> {
  const principal = ctx.actor?.p ?? ctx.capability?.actorId;
  if (!principal || !(await activePrincipal(ctx.deps, principal))) return reply(403, { error: "forbidden" });
  const userIds = composioUserIds(principal);
  return ok({ userId: userIds[0], userIds });
}

export const composioRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/composio/tools", auth: "either", handle: tools },
  { method: "POST", path: "/v1/composio/execute", auth: "either", handle: execute },
  { method: "POST", path: "/v1/composio/complete-auth", auth: "source", handle: completeAuth },
  { method: "POST", path: "/v1/composio/slack/reply-status", auth: "source", handle: (ctx) => slackReply(ctx, false) },
  { method: "POST", path: "/v1/composio/slack/reply", auth: "source", handle: (ctx) => slackReply(ctx, true) },
  { method: "GET", path: "/v1/composio/slack", auth: "source", handle: slackStatus },
  { method: "POST", path: "/v1/composio/slack/authorize", auth: "source", handle: (ctx) => authorize(ctx, true) },
  { method: "POST", path: "/v1/composio/slack/complete", auth: "source", handle: completeSlack },
  { method: "GET", path: "/v1/composio/connections", auth: "either", handle: connections },
  { method: "GET", path: "/v1/composio/toolkits", auth: "either", handle: catalog },
  { method: "POST", path: "/v1/composio/authorize", auth: "either", handle: authorize },
  { method: "POST", path: "/v1/composio/disconnect", auth: "either", handle: disconnect },
  { method: "GET", path: "/v1/composio/identity", auth: "either", handle: identity },
];
