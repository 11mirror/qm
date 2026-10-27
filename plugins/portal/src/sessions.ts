import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import {
  seal,
  openSession,
  setCookie,
  sessionCookieHeaders,
  clearCookie,
  readCookie,
  randomToken,
  type SessionClaims,
} from "./session.ts";
import { coreClaimStore, withinRateLimit, ClaimStoreUnavailableError } from "../../chassis/src/claims.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { sameOriginRequest as sameOriginFor } from "../../chassis/src/http.ts";
import { CORE_API_URL as CORE, CORE_ORG_ID as ORG, CORE_SIGNING_SECRET } from "../../chassis/src/env.ts";
import {
  SESSION_SECRET,
  SESSION_TTL_S,
  SESSION_MAX_TTL_S,
  SESSION_RENEW_AFTER_S,
  COOKIE_DOMAIN,
  SECURE_COOKIES,
  ORIGIN,
  LOCAL_AUTH_BYPASS,
  LOCAL_AUTH_PRINCIPAL,
  PLAYGROUND,
  PLAYGROUND_MINTS_PER_IP,
  PLAYGROUND_MINT_WINDOW_S,
  clientIpOf,
  DEV_SECRET,
  sessionKey,
  trustedOidc,
  trustedSignInLabel,
  isLoopbackAddress,
} from "./config.ts";

export const LOCAL_LOGOUT_COOKIE = "portal_local_logout";

export const sameOriginRequest = (req: IncomingMessage) => sameOriginFor(req, ORIGIN);

export function localDevSession(req: IncomingMessage, nowMs = Date.now(), ignoreLogout = false): SessionClaims | null {
  if (!LOCAL_AUTH_BYPASS) return null;
  if (!isLoopbackAddress(req.socket.remoteAddress)) return null;
  if (!ignoreLogout && readCookie(req.headers.cookie, LOCAL_LOGOUT_COOKIE) === "1") return null;
  const now = Math.floor(nowMs / 1000);
  return { k: "session", sub: LOCAL_AUTH_PRINCIPAL, org: ORG, iat: now, exp: now + SESSION_TTL_S };
}

export function currentSession(req: IncomingMessage): SessionClaims | null {
  return (
    openSession(readCookie(req.headers.cookie, "portal_session"), sessionKey, Date.now(), ORG, SESSION_MAX_TTL_S) ??
    localDevSession(req)
  );
}

export function loginProviderCookie(sub: string): string[] {
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

export const FRAME_SESSION_COOKIE = "portal_session_x";

export function sessionCookieSet(value: string, sub: string): string[] {
  const attrs = {
    path: "/",
    maxAge: SESSION_TTL_S,
    secure: SECURE_COOKIES,
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  };
  return [...sessionCookieHeaders(value, attrs), ...loginProviderCookie(sub)];
}

export function setSession(res: ServerResponse, headers: string[]): void {
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

export async function mintPlaygroundSession(req: IncomingMessage, res: ServerResponse): Promise<SessionClaims | null> {
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

export function renewSessionCookie(req: IncomingMessage, res: ServerResponse): SessionClaims | null {
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

export function setAuthenticatedSession(res: ServerResponse, sub: string, name = "", appOnly = false): void {
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
