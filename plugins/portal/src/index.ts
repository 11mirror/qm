import {
  DESKTOP_LAUNCH_SCRIPT,
  DESKTOP_LAUNCH_SCRIPT_HASH,
  desktopChallenge,
  mintDesktopLogin,
  openDesktopLogin,
} from "./desktop-login.ts";
import { INVITE_LOGIN_SCRIPT, INVITE_LOGIN_SCRIPT_HASH } from "./invite-login.ts";
import { reportBackendError } from "../../chassis/src/error-reporting.ts";
import "./instrument.ts";
import { provisionTrustedAdmin } from "./trusted-admin.ts";
import { createHash } from "node:crypto";
import { createServer, METHODS, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { multitenant, serveTenantsByHost } from "../../chassis/src/tenant-workers.ts";
import { ADMIN_LOGIN_SCRIPT, ADMIN_LOGIN_SCRIPT_HASH, openAdminLogin } from "./admin-login.ts";
import { LRUCache } from "lru-cache";
import { createTrustedEntry } from "./trusted-entry.ts";
import { answerPreflight, prepareCors } from "./cors.ts";
import {
  seal,
  openSession,
  openImpersonation,
  openTmp,
  setCookie,
  sessionCookieHeaders,
  clearCookie,
  readCookie,
  randomToken,
  safeEqual,
  sanitizeReturnTo,
  type SessionClaims,
  type ImpersonationClaims,
  type TmpClaims,
} from "./session.ts";
import { pkcePair, buildAuthorizeUrl, exchangeCode, fetchUserinfo, resolvePrincipal, verifyIdToken } from "./oidc.ts";
import {
  proxyToSurface,
  proxyToDeployment,
  proxyToUpstream,
  proxyToAppHost,
  FORWARD_AGENT_API_HEADERS,
  FORWARD_DEPLOYMENT_LAYER_HEADERS,
  FORWARD_OAUTH_HEADERS,
  FORWARD_BROKER_HEADERS,
  FORWARD_WEBHOOK_HEADERS,
} from "./proxy.ts";
import { fetchCoreText, signedHeaders, withSourceAuthNonce, type HttpMethod } from "../../chassis/src/core-client.ts";
import { coreClaimStore, claimOnce, withinRateLimit, ClaimStoreUnavailableError } from "../../chassis/src/claims.ts";
import { coreEmailAdmission } from "../../chassis/src/external-members.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { isUiChannel, UI_CHANNEL_COOKIE } from "../../chassis/src/ui-release.ts";
import { ALERT_ICON, cardPage, LOCK_ICON } from "../../chassis/src/card-page.ts";
import {
  json,
  escapeHtml,
  sendBuffered,
  serveFavicon,
  readBody,
  PayloadTooLargeError,
  sameOriginRequest as sameOriginFor,
} from "../../chassis/src/http.ts";
import {
  CORE_API_URL as CORE,
  CORE_ORG_ID as ORG,
  CORE_SIGNING_SECRET,
  PORTAL_IDENTITY_SECRET,
} from "../../chassis/src/env.ts";

import {
  PORT,
  PUBLIC_URL,
  SESSION_SECRET,
  SESSION_TTL_S,
  SESSION_MAX_TTL_S,
  SESSION_RENEW_AFTER_S,
  APPS_DOMAIN,
  COOKIE_DOMAIN,
  SECURE_COOKIES,
  ORIGIN,
  API_ALLOWED_ORIGINS,
  LOCAL_AUTH_BYPASS,
  LOCAL_AUTH_PRINCIPAL,
  PLAYGROUND,
  DEPLOYMENTS_ENABLED,
  PLAYGROUND_MINTS_PER_IP,
  PLAYGROUND_MINT_WINDOW_S,
  WEB_UI_UPSTREAM,
  OIDC,
  AUTH_BROKER_UPSTREAM,
  AUTH_BROKER_PREFIX,
  brokerRouteFor,
  XFF_TRUSTED_HOPS,
  clientIpOf,
  PRINCIPAL_RULE,
  DEV_SECRET,
  sessionKey,
  tmpKey,
  impersonateKey,
  trustedOidc,
  trustedSignInLabel,
  trustedAdminEnabled,
  IMPERSONATE_TTL_S,
  derivedCookieDomain,
  hostIsWithinDomain,
  isPrivateNetworkUrl,
  isLoopbackAddress,
  bootChecks,
} from "./config.ts";

export {
  brokerRouteFor,
  clientIpOf,
  derivedCookieDomain,
  hostIsWithinDomain,
  isPrivateNetworkUrl,
  isLoopbackAddress,
  bootChecks,
};

const NEUTRAL_ACCENT = "#4f46e5";
let brandAccent = NEUTRAL_ACCENT;
let modelProviderConfigured: boolean | undefined;
let surfaceConfigNextAt = 0;
let surfaceConfigInflight: Promise<void> | null = null;
function refreshSurfaceConfig(): Promise<void> {
  if (Date.now() >= surfaceConfigNextAt) {
    surfaceConfigNextAt = Date.now() + 5_000;
    surfaceConfigInflight = fetchSurfaceConfig().finally(() => {
      surfaceConfigInflight = null;
    });
  }
  return surfaceConfigInflight ?? Promise.resolve();
}
async function coreCall<T extends object>(
  method: HttpMethod,
  path: string,
  o: { body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; status: number; body: Partial<T> }> {
  const r = await fetchCoreText({ origin: CORE, secret: CORE_SIGNING_SECRET, method, path, ...o });
  let body: unknown;
  try {
    body = JSON.parse(r.text);
  } catch {
    body = undefined;
  }
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    body: body && typeof body === "object" ? body : {},
  };
}

async function fetchSurfaceConfig(): Promise<void> {
  try {
    const r = await coreCall<{ branding?: { accent?: unknown }; modelProviderConfigured?: unknown }>(
      "GET",
      "/v1/surface-config",
      { signal: AbortSignal.timeout(2_000) },
    );
    if (r.ok) {
      const body = r.body;
      brandAccent = typeof body.branding?.accent === "string" ? body.branding.accent : NEUTRAL_ACCENT;
      modelProviderConfigured =
        typeof body.modelProviderConfigured === "boolean" ? body.modelProviderConfigured : undefined;
      surfaceConfigNextAt = Date.now() + (modelProviderConfigured === false ? 5_000 : 30_000);
    } else console.warn(`[portal] surface-config returned HTTP ${r.status}`);
  } catch (error) {
    console.warn(`[portal] surface-config fetch failed: ${errMessage(error)}`);
  }
}

const trustedEntry = trustedOidc
  ? createTrustedEntry(trustedOidc, SESSION_SECRET ?? DEV_SECRET, (key, expiresAt) =>
      claimOnce(coreClaimStore(CORE, CORE_SIGNING_SECRET, "portal"), key, expiresAt),
    )
  : null;
const TMP_TTL_S = 600;
const LOCAL_LOGOUT_COOKIE = "portal_local_logout";

const ADMIN_TTL_MS = 60_000;
const ADMIN_PROBE_TIMEOUT_MS = 6_500;
const ADMIN_PROBE_ATTEMPTS = 2;
const ADMIN_PROBE_RETRY_DELAY_MS = 250;
const adminCache = new LRUCache<string, boolean>({ max: 10_000, ttl: ADMIN_TTL_MS });

function portalIdentityHeaders(sub: string): Record<string, string> {
  return PORTAL_IDENTITY_SECRET
    ? { [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: sub, exp: Date.now() + 60_000 }, PORTAL_IDENTITY_SECRET) }
    : {};
}

async function adminProbeAttempt(sub: string): Promise<boolean | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ADMIN_PROBE_TIMEOUT_MS);
  try {
    const r = await coreCall<{ isAdmin: unknown }>("GET", "/v1/admin/whoami", {
      headers: { "x-admin-actor": `${sub}@${ORG}`, ...portalIdentityHeaders(sub) },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn(`[portal] admin probe returned HTTP ${r.status}`);
      return null;
    }
    const j = r.body;
    if (typeof j.isAdmin !== "boolean") {
      console.warn("[portal] admin probe returned an invalid admin status");
      return null;
    }
    return j.isAdmin;
  } catch (error) {
    console.warn(`[portal] admin probe failed: ${errMessage(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isAdmin(sub: string): Promise<boolean> {
  const hit = adminCache.get(sub);
  if (hit !== undefined) return hit;
  for (let attempt = 0; attempt < ADMIN_PROBE_ATTEMPTS; attempt++) {
    const isAdmin = await adminProbeAttempt(sub);
    if (isAdmin === null) {
      if (attempt + 1 < ADMIN_PROBE_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, ADMIN_PROBE_RETRY_DELAY_MS));
      continue;
    }
    adminCache.set(sub, isAdmin);
    return isAdmin;
  }
  return false;
}

const CANONICAL_TTL_MS = 60_000;
const CANONICAL_TIMEOUT_MS = 4_000;
const canonicalCache = new LRUCache<string, string>({ max: 10_000, ttl: CANONICAL_TTL_MS });

async function canonicalPrincipal(sub: string): Promise<string | null> {
  const hit = canonicalCache.get(sub);
  if (hit !== undefined) return hit;
  try {
    const r = await coreCall<{ canonicalId: unknown }>("GET", `/v1/principals/${encodeURIComponent(sub)}/canonical`, {
      signal: AbortSignal.timeout(CANONICAL_TIMEOUT_MS),
    });
    if (!r.ok) {
      console.warn(`[portal] canonical principal lookup returned HTTP ${r.status}`);
      return null;
    }
    const body = r.body;
    const canonical = typeof body.canonicalId === "string" && body.canonicalId ? body.canonicalId : sub;
    canonicalCache.set(sub, canonical);
    return canonical;
  } catch (error) {
    console.warn(`[portal] canonical principal lookup failed: ${errMessage(error)}`);
    return null;
  }
}

function identityUnavailable(req: IncomingMessage, res: ServerResponse): void {
  if (wantsHtml(req))
    return sendHtml(
      res,
      503,
      '<!doctype html><meta charset=utf-8><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h2>Service unavailable</h2><p>Could not confirm your identity. Try again in a moment.</p></body>',
    );
  json(res, 503, { error: "identity_unavailable", message: "could not confirm your identity, try again in a moment" });
}

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function sendHtml(res: ServerResponse, status: number, html: string, csp = PAGE_CSP): void {
  sendBuffered(
    res,
    status,
    {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
    html,
  );
}

const sameOriginRequest = (req: IncomingMessage) => sameOriginFor(req, ORIGIN);

function wantsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

function localDevSession(req: IncomingMessage, nowMs = Date.now(), ignoreLogout = false): SessionClaims | null {
  if (!LOCAL_AUTH_BYPASS) return null;
  if (!isLoopbackAddress(req.socket.remoteAddress)) return null;
  if (!ignoreLogout && readCookie(req.headers.cookie, LOCAL_LOGOUT_COOKIE) === "1") return null;
  const now = Math.floor(nowMs / 1000);
  return { k: "session", sub: LOCAL_AUTH_PRINCIPAL, org: ORG, iat: now, exp: now + SESSION_TTL_S };
}

function currentSession(req: IncomingMessage): SessionClaims | null {
  return (
    openSession(readCookie(req.headers.cookie, "portal_session"), sessionKey, Date.now(), ORG, SESSION_MAX_TTL_S) ??
    localDevSession(req)
  );
}

export function signInErrorHtml(
  detail: string,
  retryPath: "/auth/login" | "/auth/trusted/login" = "/auth/login",
): string {
  return cardPage({
    title: "Sign-in failed",
    heading: "We couldn't sign you in",
    msg: "Your sign-in didn't complete. This is usually temporary. Trying again resolves most cases.",
    icon: ALERT_ICON,
    warn: true,
    extra: `<p class="reason"><strong>Details</strong>${escapeHtml(detail)}</p>`,
    actions: `<a class="btn primary" href="${retryPath}">Try signing in again</a>`,
    help: "Still stuck? Check that your account has access, then contact your admin.",
  });
}

export function notConfiguredHtml(): string {
  return cardPage({
    title: "Not set up yet",
    heading: "This deployment isn't set up yet",
    msg: "An admin still needs to finish setup by adding a model API key. Until then the assistant can't answer.",
    icon: ALERT_ICON,
    warn: true,
    actions: `<a class="btn primary" href="/">Try again</a>`,
    help: "Ask your admin to complete onboarding in Settings.",
  });
}

const connectStyle = (): string => `<style>
  :root{ --bg:#0a0a0a; --text:#fafafa; --muted:#a3a3a3; --border:#2a2a2a; --brand:${brandAccent}; --radius-md:10px; }
  html,body{ height:100%; margin:0; }
  body{ background:var(--bg); color:var(--text); display:grid; place-items:center; padding:40px 20px;
    font:14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing:antialiased; }
  .card{ max-width:440px; text-align:center; }
  h1{ font-size:19px; margin:0 0 10px; }
  p{ color:var(--muted); margin:0 0 18px; }
  .btn{ display:inline-block; font-weight:600; min-height:40px; line-height:40px; padding:0 18px;
    border:1px solid var(--brand); border-radius:var(--radius-md); background:var(--brand); color:#fff; text-decoration:none; }
  a.muted{ color:var(--muted); display:inline-block; margin-top:14px; }
</style>`;

function connectPage(o: { title: string; body: string; action?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(o.title)} · Portal</title>${connectStyle()}</head>
<body><div class="card"><h1>${escapeHtml(o.title)}</h1><p>${escapeHtml(o.body)}</p>${o.action ?? ""}</div></body></html>`;
}

function providerLabel(provider: string): string {
  if (provider === "google") return "Google";
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "this app";
}

export function connectErrorHtml(detail: string): string {
  return connectPage({ title: "Can't connect", body: detail });
}

export function connectWrongRecipientHtml(o: { provider: string; alreadyConnected: boolean }): string {
  const prov = providerLabel(o.provider);
  if (o.alreadyConnected) {
    return connectPage({
      title: `You've already connected ${prov}`,
      body: `This link was meant for a different teammate, and your ${prov} is already connected, so there's nothing to do here.`,
      action: `<a class="muted" href="/connectors">Manage your connections</a>`,
    });
  }
  return connectPage({
    title: "This link was for someone else",
    body: `This connect link was created for a different teammate. Want to connect your own ${prov} instead?`,
    action: `<a class="btn" href="/connect/${encodeURIComponent(o.provider)}/self-connect">Connect my ${escapeHtml(prov)}</a>`,
  });
}

async function handleConsentRedeem(
  res: ServerResponse,
  o: { corePath: string; session: SessionClaims },
): Promise<void> {
  let data: { status?: string; authorizeUrl?: string; provider?: string; clickerConnected?: boolean };
  try {
    data = (
      await coreCall<typeof data>("GET", o.corePath, {
        headers: { "x-consent-clicker": o.session.sub, "x-consent-clicker-org": o.session.org },
      })
    ).body;
  } catch (error) {
    console.warn(`[portal] consent redeem failed: ${errMessage(error)}`);
    return sendHtml(
      res,
      502,
      connectErrorHtml("We couldn't reach the connection service. Please try the link again in a moment."),
    );
  }
  switch (data.status) {
    case "authorize":
      if (!data.authorizeUrl)
        return sendHtml(res, 502, connectErrorHtml("The connection service returned an unexpected response."));
      res.writeHead(302, { location: data.authorizeUrl, "cache-control": "no-store" });
      return void res.end();
    case "wrong_recipient":
      return sendHtml(
        res,
        200,
        connectWrongRecipientHtml({ provider: data.provider ?? "", alreadyConnected: !!data.clickerConnected }),
      );
    case "expired":
      return sendHtml(res, 200, connectErrorHtml("This connect link has expired. Ask the agent for a fresh one."));
    default:
      return sendHtml(
        res,
        200,
        connectErrorHtml("This connect link is invalid or was already used. Ask the agent for a fresh one."),
      );
  }
}

async function handleSecretDrop(
  req: IncomingMessage,
  res: ServerResponse,
  o: { method: string; corePath: string; session: SessionClaims },
): Promise<void> {
  const isPost = o.method === "POST";
  let rawBody = "";
  if (isPost) {
    try {
      rawBody = await readBody(req, 64 * 1024);
    } catch (error) {
      if (!(error instanceof PayloadTooLargeError)) throw error;
      return json(res, 413, { error: "too_large", message: "that value is too large" });
    }
  }
  const path = withSourceAuthNonce(o.corePath, CORE_SIGNING_SECRET);
  const headers = {
    ...signedHeaders(CORE_SIGNING_SECRET, isPost ? "POST" : "GET", path, rawBody),
    "x-drop-owner": o.session.sub,
    "x-drop-owner-org": o.session.org,
  };
  let r: Response;
  try {
    r = await fetch(`${CORE}${path}`, {
      method: isPost ? "POST" : "GET",
      headers,
      ...(isPost ? { body: rawBody } : {}),
    });
  } catch (error) {
    console.warn(`[portal] secret drop relay failed: ${errMessage(error)}`);
    if (isPost)
      return json(res, 502, {
        error: "unreachable",
        message: "couldn't reach the credential service, try again in a moment",
      });
    return sendHtml(
      res,
      502,
      '<!doctype html><meta charset=utf-8><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h2>Service unavailable</h2><p>Try the link again in a moment.</p></body>',
    );
  }
  const bodyText = await r.text();
  const ct = r.headers.get("content-type") ?? (isPost ? "application/json" : "text/html; charset=utf-8");
  res.writeHead(r.status, { "content-type": ct, "cache-control": "no-store" });
  return void res.end(bodyText);
}

async function handleSelfConnect(res: ServerResponse, o: { provider: string; session: SessionClaims }): Promise<void> {
  const redirectUri = `${PUBLIC_URL}/v1/connectors/oauth/${encodeURIComponent(o.provider)}/callback`;
  const qs = new URLSearchParams({ principalId: o.session.sub, redirectUri, returnTo: "/connectors" });
  try {
    const r = await coreCall<{ authorizeUrl: string; message: string }>(
      "GET",
      `/v1/connectors/oauth/${encodeURIComponent(o.provider)}/start?${qs.toString()}`,
      { headers: portalIdentityHeaders(o.session.sub) },
    );
    const data = r.body;
    if (!r.ok) console.warn(`[portal] self-connect start returned HTTP ${r.status}: ${data.message ?? "no message"}`);
    if (data.authorizeUrl) {
      res.writeHead(302, { location: data.authorizeUrl, "cache-control": "no-store" });
      return void res.end();
    }
    return sendHtml(
      res,
      200,
      connectErrorHtml(data.message ?? "We couldn't start the connection. This app may not be configured."),
    );
  } catch (error) {
    console.warn(`[portal] self-connect start failed: ${errMessage(error)}`);
    return sendHtml(
      res,
      502,
      connectErrorHtml("We couldn't reach the connection service. Please try again in a moment."),
    );
  }
}

async function coreImpersonate(
  action: "start" | "stop",
  admin: string,
  target: string,
): Promise<{ ok: boolean; status: number; displayName?: string; message?: string }> {
  try {
    const r = await coreCall<{ displayName: string; message: string }>(
      "POST",
      `/v1/admin/impersonate${action === "stop" ? "/stop" : ""}`,
      {
        body: JSON.stringify({ target }),
        headers: { "x-admin-actor": `${admin}@${ORG}`, ...portalIdentityHeaders(admin) },
      },
    );
    return { ok: r.ok, status: r.status, displayName: r.body.displayName, message: r.body.message };
  } catch (e) {
    return { ok: false, status: 502, message: errMessage(e) };
  }
}

function isOAuthPublicPassthrough(method: string, pathname: string): boolean {
  if (method !== "GET") return false;
  if (/^\/v1\/connectors\/oauth\/[^/]+\/callback$/.test(pathname)) return true;
  return false;
}

function hasAgentCapability(req: IncomingMessage): boolean {
  const value = req.headers["x-agent-capability"];
  return typeof value === "string" && value.trim().length > 0;
}

function isDeploymentLayerPassthrough(method: string, pathname: string): boolean {
  return (method === "GET" || method === "PUT") && pathname === "/v1/deployment-layer";
}

function loginProviderCookie(sub: string): string[] {
  if (!trustedOidc || !trustedSignInLabel) return [];
  const issuerHash = createHash("sha256").update(trustedOidc.issuer).digest("hex");
  return [
    sub.startsWith(`oidc:${issuerHash}:`)
      ? setCookie("portal_login_provider", issuerHash, {
          path: "/",
          maxAge: 365 * 24 * 60 * 60,
          secure: SECURE_COOKIES,
        })
      : clearCookie("portal_login_provider", "/", SECURE_COOKIES),
  ];
}

const FRAME_SESSION_COOKIE = "portal_session_x";

function sessionCookieSet(value: string, sub: string): string[] {
  const attrs = {
    path: "/",
    maxAge: SESSION_TTL_S,
    secure: SECURE_COOKIES,
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  };
  return [...sessionCookieHeaders(value, attrs), ...loginProviderCookie(sub)];
}

function setSession(res: ServerResponse, headers: string[]): void {
  res.setHeader("set-cookie", headers);
}

const playgroundClaims = PLAYGROUND ? coreClaimStore(CORE, CORE_SIGNING_SECRET, "portal") : null;

export function mintBucketOf(ip: string): string {
  if (!ip.includes(":")) return ip;
  const zoneless = ip.split("%")[0] ?? "";
  if (zoneless.toLowerCase().startsWith("::ffff:") && zoneless.includes(".")) return zoneless.slice(7);
  const [headRaw = "", tailRaw = ""] = zoneless.split("::", 2);
  const head = headRaw ? headRaw.split(":") : [];
  const tail = tailRaw ? tailRaw.split(":") : [];
  const groups = [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  const prefix = groups
    .slice(0, 4)
    .map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":");
  return `${prefix}::/64`;
}

export function playgroundBusyHtml(): string {
  return cardPage({
    title: "Playground is busy",
    heading: "The playground is busy",
    msg: "We couldn't start a fresh playground session for you right now. Waiting a little while and reloading resolves most cases.",
    icon: ALERT_ICON,
    warn: true,
    actions: `<a class="btn primary" href="/">Try again</a>`,
    help: "Playground sessions are limited per visitor to keep the demo responsive for everyone.",
  });
}

export function playgroundRestrictedHtml(): string {
  return cardPage({
    title: "Not available in the playground",
    heading: "Not available in the playground",
    msg: "Connecting accounts and dropping secrets are disabled for anonymous playground sessions — clearing your cookie would orphan real credentials.",
    icon: LOCK_ICON,
    actions: `<a class="btn primary" href="/">Back to the playground</a>`,
    help: "Sign in with a real account at /auth/login to use this link.",
  });
}

async function mintPlaygroundSession(req: IncomingMessage, res: ServerResponse): Promise<SessionClaims | null> {
  if (!playgroundClaims) return null;
  const allowed = await withinRateLimit(playgroundClaims, {
    secret: SESSION_SECRET ?? DEV_SECRET,
    kind: "playground-mint",
    value: mintBucketOf(clientIpOf(req)),
    limit: PLAYGROUND_MINTS_PER_IP,
    windowS: PLAYGROUND_MINT_WINDOW_S,
    nowMs: Date.now(),
  }).catch((e) => {
    if (!(e instanceof ClaimStoreUnavailableError)) throw e;
    console.warn(`[portal] playground mint refused: claim store unavailable: ${errMessage(e)}`);
    return false;
  });
  if (!allowed) return null;
  const now = Math.floor(Date.now() / 1000);
  const session: SessionClaims = {
    k: "session",
    sub: `playground-${randomToken(8)}`,
    org: ORG,
    name: "Guest",
    anon: true,
    auth: now,
    iat: now,
    exp: now + SESSION_TTL_S,
  };
  setSession(res, sessionCookieSet(seal(session, sessionKey), session.sub));
  return session;
}

function renewSessionCookie(req: IncomingMessage, res: ServerResponse): SessionClaims | null {
  const session = openSession(
    readCookie(req.headers.cookie, "portal_session"),
    sessionKey,
    Date.now(),
    ORG,
    SESSION_MAX_TTL_S,
  );
  if (!session) return null;
  if (session.appOnly) return session;
  const now = Math.floor(Date.now() / 1000);
  if (now - session.iat < SESSION_RENEW_AFTER_S) return session;
  const authenticatedAt = session.auth ?? session.iat;
  const renewed: SessionClaims = {
    ...session,
    auth: authenticatedAt,
    iat: now,
    exp: Math.min(now + SESSION_TTL_S, authenticatedAt + SESSION_MAX_TTL_S),
  };
  setSession(res, sessionCookieSet(seal(renewed, sessionKey), renewed.sub));
  return renewed;
}

const server = createServer((req, res) => {
  const startedAt = performance.now();
  let errorLogged = false;
  res.once("finish", () => {
    if (res.statusCode >= 500 && !errorLogged)
      console.error(
        "[portal] %d %s response (%d ms)",
        res.statusCode,
        METHODS.includes(req.method ?? "") ? req.method : "?",
        Math.round(performance.now() - startedAt),
      );
  });
  void handle(req, res).catch((err: unknown) => {
    errorLogged = true;
    reportBackendError(err);
    console.error("[portal] 500 %s %s: %s", req.method ?? "?", (req.url ?? "?").split("?")[0], String(err));
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
    else res.end();
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const rawTarget = req.url ?? "/";
  const url = new URL(rawTarget, "http://portal.local");
  const pathname = url.pathname;

  res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");

  const requestHost = (req.headers.host ?? "").toLowerCase().split(":")[0]!;
  const appSuffix = APPS_DOMAIN ? `.${APPS_DOMAIN.toLowerCase()}` : undefined;
  if (appSuffix && (requestHost.endsWith(appSuffix) || requestHost === APPS_DOMAIN?.toLowerCase())) {
    const label = requestHost.slice(0, -appSuffix.length);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return json(res, 404, { error: "not_found" });
    return proxyToAppHost(req, res, CORE, clientIpOf(req));
  }

  const crossOrigin = prepareCors(req, res, pathname, API_ALLOWED_ORIGINS.origins);
  if (crossOrigin && method === "OPTIONS") return answerPreflight(res);

  const brokerPath = brokerRouteFor(method, pathname);
  const reauthentication =
    (method === "GET" &&
      ["/auth/login", "/auth/callback", "/auth/trusted/login", "/auth/trusted/callback"].includes(pathname)) ||
    (method === "POST" && pathname === "/auth/logout") ||
    brokerPath !== null;
  if (currentSession(req)?.appOnly && !reauthentication) {
    return json(res, 403, { error: "app_only_session", message: "this sign-in only permits access to shared apps" });
  }

  void refreshSurfaceConfig();

  if (method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });

  if (method === "GET" && (pathname === "/favicon.ico" || pathname === "/favicon.svg")) {
    return serveFavicon(
      res,
      {
        svg: process.env.PORTAL_FAVICON_SVG,
        emoji: process.env.PORTAL_FAVICON_EMOJI ?? "\u{1F3F4}\u{200D}\u2620\uFE0F",
      },
      "max-age=86400",
    );
  }

  if (pathname === "/auth/login" && method === "GET") return authLogin(req, res, url);
  if (pathname === "/auth/callback" && method === "GET") return authCallback(req, res, url);
  if (pathname.startsWith("/auth/trusted/") && method === "GET") return trustedAuth(req, res, url);
  if (pathname === "/auth/desktop" || pathname === "/auth/desktop/redeem") return desktopLogin(req, res, url);
  if (pathname === "/auth/invite") return inviteLogin(req, res);
  if (pathname === "/auth/admin-login") return adminLogin(req, res);
  if (pathname === "/auth/signed-out" && method === "GET") {
    if (currentSession(req))
      return sendHtml(
        res,
        409,
        connectPage({
          title: "Still signed in",
          body: "Use Sign out from the account menu to end this session.",
          action: `<a class="btn" href="/">Back to the portal</a>`,
        }),
      );
    return sendHtml(
      res,
      200,
      connectPage({
        title: "Signed out",
        body: "You have signed out of this portal.",
        action: `<a class="btn" href="/auth/login">Sign in</a>`,
      }),
    );
  }
  if (pathname === "/auth/logout" && method === "POST") {
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
    if (AUTH_BROKER_UPSTREAM && url.searchParams.get("everywhere") === "1") {
      const session = currentSession(req);
      if (!session || session.anon) return json(res, 401, { error: "sign in" });
      if (!PORTAL_IDENTITY_SECRET) return json(res, 503, { error: "not_configured" });
      try {
        const response = await coreCall("POST", "/v1/auth/broker/sessions/revoke", {
          body: JSON.stringify({ email: session.sub }),
          headers: portalIdentityHeaders(session.sub),
          signal: AbortSignal.timeout(4_000),
        });
        if (!response.ok) {
          console.warn(`[portal] broker session revoke returned HTTP ${response.status}`);
          return json(res, 503, { error: "revocation_failed" });
        }
      } catch (error) {
        console.warn(`[portal] broker session revoke failed: ${errMessage(error)}`);
        return json(res, 503, { error: "revocation_failed" });
      }
    }
    const signedOutSession = currentSession(req);
    const redirectTo = !AUTH_BROKER_UPSTREAM && signedOutSession && !signedOutSession.anon ? "/auth/signed-out" : "/";
    setSession(res, [
      ...(signedOutSession ? loginProviderCookie(signedOutSession.sub) : []),
      clearCookie("portal_impersonate", "/", SECURE_COOKIES),
      clearCookie("portal_trusted_tmp", "/auth/trusted", SECURE_COOKIES),
      clearCookie("portal_session", "/", SECURE_COOKIES, COOKIE_DOMAIN),
      clearCookie(FRAME_SESSION_COOKIE, "/", SECURE_COOKIES, COOKIE_DOMAIN),
      ...(COOKIE_DOMAIN
        ? [clearCookie("portal_session", "/", SECURE_COOKIES), clearCookie(FRAME_SESSION_COOKIE, "/", SECURE_COOKIES)]
        : []),
      clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
      ...(AUTH_BROKER_UPSTREAM ? [clearCookie("qm_idp_session", AUTH_BROKER_PREFIX, true)] : []),
      ...(LOCAL_AUTH_BYPASS && isLoopbackAddress(req.socket.remoteAddress)
        ? [setCookie(LOCAL_LOGOUT_COOKIE, "1", { path: "/", maxAge: SESSION_TTL_S, secure: SECURE_COOKIES })]
        : []),
    ]);
    if (wantsHtml(req)) {
      res.writeHead(303, { location: redirectTo, "cache-control": "no-store" });
      return void res.end();
    }
    return json(res, 200, { ok: true, redirectTo });
  }

  if (brokerPath) {
    if (method !== "GET" && !sameOriginRequest(req))
      return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    return proxyToUpstream(
      req,
      res,
      { baseUrl: AUTH_BROKER_UPSTREAM, path: brokerPath, search: url.search, forwardCookies: true },
      FORWARD_BROKER_HEADERS,
      {
        "x-qm-client-ip": clientIpOf(req),
        cookie: (req.headers.cookie ?? "")
          .split(";")
          .map((part) => part.trim())
          .filter((part) => /^qm_idp_session=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(part))
          .join("; "),
      },
    );
  }

  let session = renewSessionCookie(req, res) ?? currentSession(req);
  const authenticatedPrincipal = session?.sub;
  if (session && !session.anon && (!pathname.startsWith("/auth/") || pathname.startsWith("/auth/impersonate"))) {
    const canonical = await canonicalPrincipal(session.sub);
    if (canonical === null) return identityUnavailable(req, res);
    session = { ...session, sub: canonical };
  }

  if (pathname === "/auth/impersonate" && method === "POST") {
    if (!session) return json(res, 401, { error: "sign in" });
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    if (!(await isAdmin(session.sub))) return json(res, 403, { error: "forbidden", message: "admin access required" });
    const target = (url.searchParams.get("target") ?? "").trim();
    if (!target) return json(res, 400, { error: "bad_request", message: "target required" });
    if (target === session.sub || (await canonicalPrincipal(target)) === session.sub)
      return json(res, 400, { error: "bad_request", message: "cannot impersonate yourself" });
    const result = await coreImpersonate("start", session.sub, target);
    if (!result.ok) {
      const status = result.status === 403 || result.status === 400 ? result.status : 502;
      return json(res, status, {
        error: "impersonate_failed",
        message: result.message ?? "core refused impersonation",
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const imp: ImpersonationClaims = {
      k: "impersonate",
      actor: session.sub,
      target,
      org: session.org,
      iat: now,
      exp: now + IMPERSONATE_TTL_S,
    };
    setSession(res, [
      setCookie("portal_impersonate", seal(imp, impersonateKey), {
        path: "/",
        maxAge: IMPERSONATE_TTL_S,
        secure: SECURE_COOKIES,
      }),
    ]);
    return json(res, 200, { ok: true, target, displayName: result.displayName ?? target });
  }

  if (pathname === "/auth/impersonate/stop" && method === "POST") {
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    const imp = openImpersonation(readCookie(req.headers.cookie, "portal_impersonate"), impersonateKey, Date.now());
    setSession(res, [clearCookie("portal_impersonate", "/", SECURE_COOKIES)]);
    if (session && imp && imp.actor === session.sub) await coreImpersonate("stop", session.sub, imp.target);
    if (wantsHtml(req)) {
      res.writeHead(303, { location: "/", "cache-control": "no-store" });
      return void res.end();
    }
    return json(res, 200, { ok: true });
  }

  const rawPath = rawTarget.split("?")[0] ?? "";
  if (/%2f|%5c|%2e%2e|\\|\x00/i.test(rawPath) || rawPath.includes("//") || pathname.includes("/..")) {
    return json(res, 400, { error: "bad_request", message: "illegal path" });
  }

  if (
    (pathname === "/v1/slack/managed/installation" && (method === "POST" || method === "DELETE")) ||
    (pathname === "/v1/slack/managed/events" && method === "POST")
  ) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: "" }, [
      "authorization",
      "content-type",
      "content-length",
    ]);
  }

  if (method === "POST" && /^\/v1\/webhooks\/incoming\/[^/]+$/.test(pathname)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, FORWARD_WEBHOOK_HEADERS);
  }

  if (method === "POST" && /^\/v1\/surfaces\/[^/]+\/events$/.test(pathname)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, [
      "content-type",
      "x-timestamp",
      "x-signature",
    ]);
  }

  const consentBounce = (): void => {
    res.writeHead(302, { location: `/auth/login?returnTo=${encodeURIComponent(`${pathname}${url.search}`)}` });
    return void res.end();
  };
  const redeem = /^\/connect\/redeem\/([^/]+)$/.exec(pathname);
  if (method === "GET" && redeem) {
    if (!session) return consentBounce();
    if (session.anon) return sendHtml(res, 403, playgroundRestrictedHtml());
    return handleConsentRedeem(res, {
      corePath: `/v1/connectors/oauth/consent/redeem/${redeem[1]}${url.search}`,
      session,
    });
  }
  const selfConnect = /^\/connect\/([^/]+)\/self-connect$/.exec(pathname);
  if (method === "GET" && selfConnect) {
    if (!session) return consentBounce();
    if (session.anon) return sendHtml(res, 403, playgroundRestrictedHtml());
    return handleSelfConnect(res, { provider: decodeURIComponent(selfConnect[1] ?? ""), session });
  }

  if (isOAuthPublicPassthrough(method, pathname)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, FORWARD_OAUTH_HEADERS);
  }

  const dropForm = /^\/drop\/([^/]+)\/form$/.exec(pathname);
  if (method === "GET" && dropForm) {
    if (!session) return consentBounce();
    if (session.anon) return sendHtml(res, 403, playgroundRestrictedHtml());
    return handleSecretDrop(req, res, {
      method,
      corePath: `/v1/keychain/drops/${dropForm[1]}/form${url.search}`,
      session,
    });
  }
  const dropSubmit = /^\/drop\/([^/]+)$/.exec(pathname);
  if (method === "POST" && dropSubmit) {
    if (!session)
      return json(res, 401, {
        error: "sign in",
        message: "your session expired, re-open the link, sign in, and paste again",
      });
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    if (session.anon)
      return json(res, 403, { error: "forbidden", message: "secret drops are disabled for playground sessions" });
    return handleSecretDrop(req, res, {
      method,
      corePath: `/v1/keychain/drops/${dropSubmit[1]}${url.search}`,
      session,
    });
  }

  if (
    ((method === "GET" || method === "POST") && pathname === "/v1/background-work") ||
    (method === "POST" && pathname === "/v1/deployment/live-session")
  ) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, [
      ...FORWARD_DEPLOYMENT_LAYER_HEADERS,
      "authorization",
    ]);
  }

  if (isDeploymentLayerPassthrough(method, pathname)) {
    return proxyToUpstream(
      req,
      res,
      { baseUrl: CORE, path: pathname, search: url.search },
      FORWARD_DEPLOYMENT_LAYER_HEADERS,
    );
  }

  if (pathname.startsWith("/v1/") && hasAgentCapability(req)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, FORWARD_AGENT_API_HEADERS);
  }

  if (pathname === "/v1" || pathname.startsWith("/v1/")) return json(res, 404, { error: "not_found" });

  const seg = pathname.split("/")[1] ?? "";
  if (seg === "web-ui") {
    const stripped = pathname.slice("/web-ui".length) || "/";
    res.writeHead(308, { location: `${stripped}${url.search}`, "cache-control": "no-store" });
    return void res.end();
  }
  if (!DEPLOYMENTS_ENABLED && (seg === "d" || seg === "deployments")) return json(res, 404, { error: "not_found" });
  const isDeployment = DEPLOYMENTS_ENABLED && (seg === "d" || seg === "deployments");

  if (
    method === "GET" &&
    (/^\/share\/external\/[a-f0-9-]{36}(?:\/files\/[a-f0-9-]{36})?$/.test(pathname) ||
      /^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname))
  ) {
    return proxyToUpstream(req, res, { baseUrl: WEB_UI_UPSTREAM, path: pathname, search: url.search }, [
      "accept",
      "accept-encoding",
    ]);
  }

  if (!session) {
    if (method === "GET" && wantsHtml(req)) {
      if (PLAYGROUND) {
        session = await mintPlaygroundSession(req, res);
        if (!session) return sendHtml(res, 429, playgroundBusyHtml());
      } else {
        const returnTo = encodeURIComponent(`${pathname}${url.search}`);
        res.writeHead(302, { location: `/auth/login?returnTo=${returnTo}` });
        return void res.end();
      }
    } else {
      return json(res, 401, { error: "sign in", loginUrl: "/auth/login" });
    }
  }

  if (method !== "GET" && method !== "HEAD" && !crossOrigin && !sameOriginRequest(req)) {
    return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
  }

  if (isDeployment) {
    if (session.anon) return json(res, 403, { error: "forbidden", message: "sign in to view deployed apps" });
    const rest = pathname.slice(`/${seg}/`.length);
    const slash = rest.indexOf("/");
    const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    const subPath = slash === -1 ? "/" : rest.slice(slash);
    if (!id) return json(res, 404, { error: "not_found" });
    return proxyToDeployment(req, res, {
      coreBase: CORE,
      id,
      subPath,
      search: url.search,
      principal: session.sub,
      signingSecret: CORE_SIGNING_SECRET,
      ...(PORTAL_IDENTITY_SECRET ? { identitySecret: PORTAL_IDENTITY_SECRET } : {}),
    });
  }

  const settingsPath = pathname === "/settings" || pathname.startsWith("/settings/") || seg === "admin";
  if (method === "GET" && wantsHtml(req) && !settingsPath) {
    await refreshSurfaceConfig();
    if (modelProviderConfigured === false) {
      if (await isAdmin(session.sub)) {
        res.writeHead(302, { location: "/settings/onboarding", "cache-control": "no-store" });
        return void res.end();
      }
      return sendHtml(res, 503, notConfiguredHtml());
    }
  }

  let principal = session.sub;
  let impersonator: string | undefined;
  if (!crossOrigin) {
    const imp = openImpersonation(readCookie(req.headers.cookie, "portal_impersonate"), impersonateKey, Date.now());
    if (imp && imp.actor === session.sub && imp.org === session.org && (await isAdmin(session.sub))) {
      principal = imp.target;
      impersonator = session.sub;
    }
  }

  const requestedChannel = method === "GET" && wantsHtml(req) ? url.searchParams.get("ui") : null;
  if (requestedChannel !== null) {
    if (!isUiChannel(requestedChannel)) return json(res, 400, { error: "bad_request", message: "unknown ui channel" });
    url.searchParams.delete("ui");
    setSession(res, [
      requestedChannel === "live"
        ? clearCookie(UI_CHANNEL_COOKIE, "/", SECURE_COOKIES)
        : setCookie(UI_CHANNEL_COOKIE, requestedChannel, { secure: SECURE_COOKIES }),
    ]);
    res.writeHead(302, { location: `${pathname}${url.search}`, "cache-control": "no-store" });
    return void res.end();
  }
  const uiChannel = readCookie(req.headers.cookie, UI_CHANNEL_COOKIE);
  return proxyToSurface(req, res, {
    ...(uiChannel && isUiChannel(uiChannel) ? { uiChannel } : {}),
    upstreamBase: WEB_UI_UPSTREAM,
    forwardPath: pathname,
    search: url.search,
    cookieName: "webuiuser",
    principal,
    ...(!impersonator && session.name ? { displayName: session.name } : {}),
    ...(impersonator ? { impersonator } : {}),
    ...(PORTAL_IDENTITY_SECRET ? { identitySecret: PORTAL_IDENTITY_SECRET } : {}),
    authenticatedPrincipal,
  });
}

async function desktopLogin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  res.setHeader("cache-control", "no-store");
  if (!SESSION_SECRET || SESSION_SECRET.trim().length < 32 || !CORE_SIGNING_SECRET) {
    return json(res, 503, { error: "not_configured" });
  }
  if (url.pathname.endsWith("/redeem")) {
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
    if ((req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) && !sameOriginRequest(req))
      return json(res, 403, { error: "forbidden" });
    let body: URLSearchParams;
    try {
      body = new URLSearchParams(await readBody(req, 12288));
    } catch (error) {
      if (error instanceof PayloadTooLargeError) return json(res, 413, { error: "payload_too_large" });
      throw error;
    }
    const claims = openDesktopLogin(
      body.get("code") ?? "",
      body.get("verifier") ?? "",
      body.get("state") ?? "",
      SESSION_SECRET,
      ORIGIN,
      ORG,
      SESSION_MAX_TTL_S,
    );
    if (!claims) return json(res, 400, { error: "invalid_desktop_login" });
    try {
      if (
        !(await claimOnce(
          coreClaimStore(CORE, CORE_SIGNING_SECRET, "portal"),
          `desktop-login:${claims.jti}`,
          claims.expiresAtMs,
        ))
      ) {
        return json(res, 400, { error: "desktop_login_already_used" });
      }
    } catch (error) {
      if (error instanceof ClaimStoreUnavailableError) return json(res, 503, { error: "temporarily_unavailable" });
      throw error;
    }
    setSession(res, [
      ...sessionCookieSet(seal(claims.session, sessionKey), claims.session.sub),
      clearCookie("portal_impersonate", "/", SECURE_COOKIES),
    ]);
    return json(res, 200, { ok: true });
  }
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  const challenge = url.searchParams.get("challenge") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!desktopChallenge(challenge) || !desktopChallenge(state))
    return json(res, 400, { error: "invalid_desktop_request" });
  if (req.method === "POST" && !sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
  const session = renewSessionCookie(req, res) ?? currentSession(req);
  if (!session || session.anon) {
    res.writeHead(303, {
      location: `/auth/login?returnTo=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      "cache-control": "no-store",
    });
    return void res.end();
  }
  if (req.method === "GET") {
    return sendHtml(
      res,
      200,
      cardPage({
        title: "Open QM Desktop",
        heading: "Sign in to QM Desktop",
        icon: LOCK_ICON,
        msg: `Continue as ${session.sub}.`,
        actions: `<form method="post" action="${escapeHtml(`${url.pathname}${url.search}`)}"><button class="btn primary" type="submit">Open QM Desktop</button></form>`,
        help: "Only continue if you just started sign-in in the QM desktop app on this computer.",
      }),
    );
  }
  const callback = new URL("qm-desktop://auth/callback");
  callback.searchParams.set("code", mintDesktopLogin(session, SESSION_SECRET, ORIGIN, challenge, state));
  callback.searchParams.set("state", state);
  return sendHtml(
    res,
    200,
    cardPage({
      title: "Ready to open QM",
      heading: "Opening QM Desktop…",
      icon: LOCK_ICON,
      msg: "If QM doesn’t open automatically, use the button below.",
      actions: `<a id="desktop-launch" class="btn primary" href="${escapeHtml(callback.href)}">Open QM Desktop</a><script>${DESKTOP_LAUNCH_SCRIPT}</script>`,
      help: "This link expires in two minutes and works only for the app that requested it.",
    }),
    `${PAGE_CSP}; script-src '${DESKTOP_LAUNCH_SCRIPT_HASH}'`,
  );
}

async function inviteLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!SESSION_SECRET || !CORE_SIGNING_SECRET) return json(res, 503, { error: "not_configured" });
  if (req.method === "GET")
    return sendHtml(
      res,
      200,
      cardPage({
        title: "Accept invitation",
        heading: "You're invited",
        icon: LOCK_ICON,
        msg: "",
        extra: '<p id="invite-status"></p><noscript>JavaScript is required to open this invitation.</noscript>',
        actions: `<form method="post" action="/auth/invite"><input id="invite-token" name="token" type="hidden"><button id="invite-confirm" class="btn primary" type="submit" disabled>Accept invitation</button></form><script>${INVITE_LOGIN_SCRIPT}</script>`,
        help: "",
      }),
      `${PAGE_CSP}; script-src '${INVITE_LOGIN_SCRIPT_HASH}'`,
    );
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
  let token: string;
  try {
    token = new URLSearchParams(await readBody(req, 8192)).get("token") ?? "";
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return json(res, 413, { error: "payload_too_large" });
    throw error;
  }
  if (!token || token.length > 4096) return sendHtml(res, 400, signInErrorHtml("This invitation is invalid."));
  try {
    const r = await coreCall<{ email: string }>("POST", "/v1/auth/invitations/redeem", {
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(10_000),
    });
    const unavailable = r.ok || r.status >= 500;
    if (!r.ok || typeof r.body.email !== "string")
      return sendHtml(
        res,
        unavailable ? 503 : 400,
        signInErrorHtml(
          unavailable
            ? "Sign-in is temporarily unavailable. Please try again."
            : "This invitation is expired, revoked, or already used. Ask your administrator for a new one.",
        ),
      );
    setAuthenticatedSession(res, r.body.email);
    res.writeHead(303, { location: "/", "cache-control": "no-store" });
    res.end();
  } catch (error) {
    console.warn(`[portal] invitation redeem failed: ${errMessage(error)}`);
    return sendHtml(res, 503, signInErrorHtml("Sign-in is temporarily unavailable. Please try again."));
  }
}

async function adminLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!SESSION_SECRET || SESSION_SECRET.trim().length < 32 || !CORE_SIGNING_SECRET) {
    return json(res, 503, { error: "not_configured" });
  }
  if (req.method === "GET") {
    return sendHtml(
      res,
      200,
      cardPage({
        title: "Admin sign-in",
        heading: "Sign in as an administrator",
        msg: "Only continue if you generated this link for your own admin account.",
        icon: LOCK_ICON,
        extra: '<p id="admin-email"></p><noscript>JavaScript is required to open this login link.</noscript>',
        actions: `<form method="post" action="/auth/admin-login"><input id="admin-token" name="token" type="hidden"><button id="admin-confirm" class="btn primary" style="width:100%" type="submit" disabled>Sign in</button></form><script>${ADMIN_LOGIN_SCRIPT}</script>`,
        help: "This link expires after five minutes and can be used once. Generate another with qm admin-login.",
      }),
      `${PAGE_CSP}; script-src '${ADMIN_LOGIN_SCRIPT_HASH}'`,
    );
  }
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
  let token: string;
  try {
    token = new URLSearchParams(await readBody(req, 8192)).get("token") ?? "";
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return json(res, 413, { error: "payload_too_large" });
    throw error;
  }
  const claims = openAdminLogin(token, SESSION_SECRET, ORIGIN);
  const fail = () =>
    sendHtml(
      res,
      400,
      signInErrorHtml("This admin link is invalid, expired, or already used. Generate a new link with qm admin-login."),
    );
  if (!claims) return fail();
  const allowed = await adminProbeAttempt(claims.email);
  if (allowed === null)
    return sendHtml(res, 503, signInErrorHtml("Admin access could not be checked. Please try again."));
  if (!allowed) return sendHtml(res, 403, signInErrorHtml("This account does not have admin access."));
  try {
    const claimsStore = coreClaimStore(CORE, CORE_SIGNING_SECRET, "portal");
    if (!(await claimOnce(claimsStore, `admin-login:${claims.jti}`, claims.expiresAtMs))) return fail();
  } catch (error) {
    if (error instanceof ClaimStoreUnavailableError) {
      return sendHtml(res, 503, signInErrorHtml("Sign-in is temporarily unavailable. Please try again."));
    }
    throw error;
  }
  setAuthenticatedSession(res, claims.email);
  res.writeHead(303, { location: "/settings/history", "cache-control": "no-store" });
  res.end();
}

async function trustedAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!trustedEntry) return json(res, 404, { error: "not_found" });
  const cookieName = "portal_trusted_tmp";
  const path = "/auth/trusted";
  if (url.pathname === `${path}/login`) {
    const returnTo =
      url.searchParams.get("returnTo") ??
      openTmp(readCookie(req.headers.cookie, "portal_oidc_tmp"), tmpKey, Date.now())?.returnTo ??
      null;
    const existing = currentSession(req);
    const trustedPrefix = `oidc:${createHash("sha256").update(trustedOidc!.issuer).digest("hex")}:`;
    if (existing && !existing.anon && !existing.appOnly && existing.sub.startsWith(trustedPrefix)) {
      res.writeHead(302, {
        location: sanitizeReturnTo(returnTo, PUBLIC_URL, APPS_DOMAIN),
        "cache-control": "no-store",
      });
      return void res.end();
    }
    const login = trustedEntry.start(sanitizeReturnTo(returnTo, PUBLIC_URL, APPS_DOMAIN));
    setSession(res, [setCookie(cookieName, login.cookie, { path, maxAge: login.ttl, secure: SECURE_COOKIES })]);
    res.writeHead(302, { location: login.location, "cache-control": "no-store" });
    return void res.end();
  }
  if (url.pathname !== `${path}/callback`) return json(res, 404, { error: "not_found" });
  setSession(res, [clearCookie(cookieName, path, SECURE_COOKIES)]);
  try {
    const identity = await trustedEntry.finish(readCookie(req.headers.cookie, cookieName), url);
    if (trustedAdminEnabled) {
      await provisionTrustedAdmin(
        {
          core: CORE,
          signingSecret: CORE_SIGNING_SECRET!,
          identitySecret: PORTAL_IDENTITY_SECRET!,
          org: ORG,
          issuer: trustedOidc!.issuer,
        },
        identity.subject,
      );
      adminCache.delete(identity.sub);
    }
    setAuthenticatedSession(res, identity.sub, identity.name);
    res.writeHead(302, {
      location: sanitizeReturnTo(identity.returnTo, PUBLIC_URL, APPS_DOMAIN),
      "cache-control": "no-store",
    });
    res.end();
  } catch (error) {
    console.warn(`[portal] trusted sign-in failed: ${errMessage(error)}`);
    reportBackendError(error, "trusted_signin_failed");
    sendHtml(
      res,
      400,
      signInErrorHtml("Trusted sign-in failed. Please start again from your provider.", "/auth/trusted/login"),
    );
  }
}

function setAuthenticatedSession(res: ServerResponse, sub: string, name = "", appOnly = false): void {
  const now = Math.floor(Date.now() / 1000);
  const session: SessionClaims = {
    k: "session",
    sub,
    org: ORG,
    auth: now,
    iat: now,
    exp: now + SESSION_TTL_S,
    ...(name ? { name } : {}),
    ...(appOnly ? { appOnly: true } : {}),
  };
  setSession(res, [
    ...sessionCookieSet(seal(session, sessionKey), session.sub),
    clearCookie("portal_trusted_tmp", "/auth/trusted", SECURE_COOKIES),
    clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
    clearCookie("portal_impersonate", "/", SECURE_COOKIES),
  ]);
}

function authLogin(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (
    trustedOidc &&
    trustedSignInLabel &&
    url.searchParams.get("provider") !== "primary" &&
    readCookie(req.headers.cookie, "portal_login_provider") ===
      createHash("sha256").update(trustedOidc.issuer).digest("hex")
  ) {
    const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"), PUBLIC_URL, APPS_DOMAIN);
    res.writeHead(302, {
      location: `/auth/trusted/login?returnTo=${encodeURIComponent(returnTo)}`,
      "cache-control": "no-store",
    });
    return void res.end();
  }
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"), PUBLIC_URL, APPS_DOMAIN);
  const localSession = localDevSession(req, Date.now(), true);
  if (localSession) {
    setSession(res, [
      ...sessionCookieSet(seal(localSession, sessionKey), localSession.sub),
      clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
      ...(AUTH_BROKER_UPSTREAM ? [clearCookie("qm_idp_session", AUTH_BROKER_PREFIX, true)] : []),
      clearCookie(LOCAL_LOGOUT_COOKIE, "/", SECURE_COOKIES),
    ]);
    res.writeHead(302, { location: returnTo, "cache-control": "no-store" });
    return void res.end();
  }
  const state = randomToken();
  const nonce = randomToken();
  const { verifier, challenge } = pkcePair();
  const now = Math.floor(Date.now() / 1000);
  const tmp: TmpClaims = { k: "tmp", state, nonce, pkceVerifier: verifier, returnTo, iat: now, exp: now + TMP_TTL_S };
  setSession(res, [
    setCookie("portal_oidc_tmp", seal(tmp, tmpKey), { path: "/auth", maxAge: TMP_TTL_S, secure: SECURE_COOKIES }),
  ]);
  res.writeHead(302, { location: buildAuthorizeUrl(OIDC, { state, nonce, challenge }), "cache-control": "no-store" });
  res.end();
}

async function authCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const fail = (detail: string): void => {
    setSession(res, [clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES)]);
    sendHtml(res, 400, signInErrorHtml(detail));
  };

  if (url.searchParams.get("error")) return fail(`identity provider returned: ${url.searchParams.get("error") ?? ""}`);
  const code = url.searchParams.get("code") ?? "";
  const stateParam = url.searchParams.get("state") ?? "";

  const tmp = openTmp(readCookie(req.headers.cookie, "portal_oidc_tmp"), tmpKey, Date.now());
  if (!tmp) return fail("login session expired, please try again");
  if (!code || !stateParam || !safeEqual(stateParam, tmp.state)) return fail("invalid login state");
  try {
    if (
      !(await claimOnce(
        coreClaimStore(CORE, CORE_SIGNING_SECRET, "portal"),
        `oidc-state:${tmp.state}`,
        Date.now() + 2 * TMP_TTL_S * 1000,
      ))
    )
      return fail("login already used, please try again");
  } catch (error) {
    if (!(error instanceof ClaimStoreUnavailableError)) throw error;
    console.warn(`[portal] sign-in state check unavailable: ${errMessage(error)}`);
    return fail("sign-in is temporarily unavailable, please try again");
  }

  let principal: { sub: string; appOnly?: true };
  let name = "";
  try {
    const { accessToken, idToken } = await exchangeCode(OIDC, { code, codeVerifier: tmp.pkceVerifier });
    const claims = await verifyIdToken(OIDC, idToken, tmp.nonce);
    if (OIDC.expectedTeamId) {
      const team = claims["https://slack.com/team_id"];
      if (team !== OIDC.expectedTeamId) throw new Error("workspace not permitted");
    }
    const info = await fetchUserinfo(OIDC, accessToken);
    const infoSub = typeof info.sub === "string" ? info.sub : "";
    if (!infoSub) throw new Error("userinfo missing sub");
    if (typeof claims.sub === "string" && claims.sub !== infoSub) throw new Error("subject mismatch");
    principal = await resolvePrincipal(PRINCIPAL_RULE, { sub: infoSub, claims, userinfo: info }, (email) =>
      coreEmailAdmission(CORE, CORE_SIGNING_SECRET, email, "portal"),
    );
    const rawName = info.name ?? claims.name;
    if (typeof rawName === "string") name = rawName.trim().slice(0, 200);
  } catch (e) {
    return fail(errMessage(e, "sign-in failed"));
  }

  setAuthenticatedSession(res, principal.sub, name, principal.appOnly);
  res.writeHead(302, {
    location: sanitizeReturnTo(tmp.returnTo, PUBLIC_URL, APPS_DOMAIN),
    "cache-control": "no-store",
  });
  res.end();
}

function loopbackPort(upstream: string): number | undefined {
  try {
    const url = new URL(upstream);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.pathname === "/"
      ? Number(url.port)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function startServer(port = PORT, host?: string): Promise<Server> {
  bootChecks();
  if (process.env.AUTH_EMBEDDED === "1") {
    const brokerPort = loopbackPort(AUTH_BROKER_UPSTREAM);
    if (!brokerPort) throw new Error("Embedded auth requires a loopback broker upstream");
    const auth = await import("../../auth/src/index.ts");
    const broker = await auth.startServer({
      port: brokerPort,
      host: "127.0.0.1",
      ...(trustedSignInLabel ? { trustedSignInLabel } : {}),
    });
    server.once("close", () => broker.close());
    server.once("error", () => broker.close());
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
      console.log(`[portal] public front door on http://localhost:${port} → web-ui over 6PN (org ${ORG})`);
      if (!SESSION_SECRET)
        console.warn("[portal] PORTAL_SESSION_SECRET unset, using an INSECURE dev key (dev/test only)");
      if (!SECURE_COOKIES)
        console.warn("[portal] PORTAL_PUBLIC_URL is not https, cookies are NOT Secure (dev/test only)");
      if (LOCAL_AUTH_BYPASS)
        console.warn(
          `[portal] PORTAL_LOCAL_AUTH_BYPASS=1 -- using ${LOCAL_AUTH_PRINCIPAL} as the local session principal (dev/test only)`,
        );
      if (PLAYGROUND)
        console.warn(
          `[portal] PORTAL_PLAYGROUND=1 -- unauthenticated visitors get anonymous browser-pinned sessions (${PLAYGROUND_MINTS_PER_IP} mints per IP per ${PLAYGROUND_MINT_WINDOW_S}s); admin sign-in stays on /auth/login`,
        );
      if (PLAYGROUND && XFF_TRUSTED_HOPS === 0)
        console.warn(
          "[portal] playground mint limits key on the socket address — set PORTAL_XFF_TRUSTED_HOPS when behind a reverse proxy, or every visitor shares one bucket",
        );
    });
  });
  return server;
}

export { handle, server };

if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (multitenant(process.env)
    ? serveTenantsByHost({ entry: new URL(import.meta.url), service: "portal", port: PORT, env: process.env })
    : startServer()
  ).catch((error: unknown) => {
    reportBackendError(error);
    console.error("[portal] failed to start:", errMessage(error));
    process.exitCode = 1;
  });
}
