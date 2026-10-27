import { deriveKey, open, seal } from "./signed-token.ts";

export interface PortalIdentity {
  p: string;
  authenticatedAs?: string;
  n?: string;
  imp?: string;
  exp: number;
}

export const PORTAL_IDENTITY_HEADER = "x-portal-identity";

export function portalIdentityClaims(value: unknown, nowMs: number): PortalIdentity | null {
  const claims = value as PortalIdentity | null;
  if (!claims || typeof claims.p !== "string" || !claims.p || typeof claims.exp !== "number") return null;
  if (claims.authenticatedAs !== undefined && (typeof claims.authenticatedAs !== "string" || !claims.authenticatedAs))
    return null;
  if (nowMs > claims.exp) return null;
  return claims;
}

export function mintPortalIdentity(claims: PortalIdentity, secret: string): string {
  return seal(claims, secret);
}

export function verifyPortalIdentity(token: string, secret: string, nowMs: number): PortalIdentity | null {
  return portalIdentityClaims(open(token, secret), nowMs);
}

export function portalSessionKey(secret: string): Buffer {
  return deriveKey(secret, "portal.session.v1");
}

export interface SessionClaims {
  k: "session";
  sub: string;
  org: string;
  name?: string;
  auth?: number;
  anon?: boolean;
  appOnly?: boolean;
  iat: number;
  exp: number;
}

export function openSession(
  token: string | null,
  key: Buffer,
  now: number,
  expectedOrg?: string,
  maxAgeSeconds?: number,
): SessionClaims | null {
  const p = open(token, key);
  if (!p || p.k !== "session") return null;
  if (
    typeof p.sub !== "string" ||
    !p.sub ||
    typeof p.org !== "string" ||
    !p.org ||
    typeof p.iat !== "number" ||
    typeof p.exp !== "number"
  )
    return null;
  if (p.appOnly !== undefined && typeof p.appOnly !== "boolean") return null;
  if (expectedOrg !== undefined && p.org !== expectedOrg) return null;
  if (now >= p.exp * 1000) return null;
  const authenticatedAt = typeof p.auth === "number" ? p.auth : p.iat;
  if (maxAgeSeconds !== undefined && now >= (authenticatedAt + maxAgeSeconds) * 1000) return null;
  return p as unknown as SessionClaims;
}
