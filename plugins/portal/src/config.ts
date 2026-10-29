import { parseAllowedOrigins } from "../../chassis/src/allowed-origins.ts";
import { type IncomingMessage } from "node:http";
import { trustedEntryConfig } from "./trusted-entry.ts";
import { deriveKey } from "./session.ts";
import { type OidcConfig, type PrincipalRule } from "./oidc.ts";
import { isPrivateNetworkIp } from "../../chassis/src/network.ts";
import { reportFailure } from "../../chassis/src/error-reporting.ts";
import { edgeTenant, tenantPublicUrl } from "../../chassis/src/tenant-hosts.ts";
import { deriveTenantSecret, type TenantSettings } from "../../chassis/src/tenant-settings.ts";
import { coreSigningSecret, portalIdentitySecret, isMissingOrPlaceholder, portFromEnv } from "../../chassis/src/env.ts";

export const PORT = portFromEnv(8097);

export const SESSION_SECRET = process.env.PORTAL_SESSION_SECRET;

export const SESSION_TTL_S = Number(process.env.PORTAL_SESSION_TTL_S ?? 604800);

export const SESSION_MAX_TTL_S = Math.max(2592000, 3 * SESSION_TTL_S);

export const SESSION_RENEW_AFTER_S = Math.floor(SESSION_TTL_S / 2);

const IS_PROD = process.env.NODE_ENV === "production";

export const secureCookies = (): boolean => site().publicUrl.startsWith("https://");

const LOCAL_AUTH_BYPASS_REQUESTED = process.env.PORTAL_LOCAL_AUTH_BYPASS === "1";

export const localAuthBypass = (): boolean =>
  LOCAL_AUTH_BYPASS_REQUESTED && !IS_PROD && isLocalPortalUrl(site().publicUrl);

export const LOCAL_AUTH_PRINCIPAL = process.env.PORTAL_DEV_PRINCIPAL || process.env.USER || "dev-admin";

export const PLAYGROUND = process.env.PORTAL_PLAYGROUND === "1";

export const DEPLOYMENTS_ENABLED = !PLAYGROUND;

export const PLAYGROUND_MINTS_PER_IP = 30;

export const PLAYGROUND_MINT_WINDOW_S = 3600;

export const WEB_UI_UPSTREAM = (process.env.WEB_UI_UPSTREAM ?? "http://localhost:8096").replace(/\/$/, "");

function isSlackIssuer(issuer: string): boolean {
  try {
    const host = new URL(issuer).hostname;
    return host === "slack.com" || host.endsWith(".slack.com");
  } catch {
    return false;
  }
}

const AUTH_BROKER_UPSTREAM = (process.env.AUTH_BROKER_UPSTREAM ?? "").replace(/\/$/, "");

export const AUTH_BROKER_PREFIX = (process.env.AUTH_BROKER_PREFIX ?? "/idp").replace(/\/$/, "");

const BROKER_PUBLIC_ROUTES = [
  { method: "GET", path: "/authorize" },
  { method: "POST", path: "/authorize" },
  { method: "GET", path: "/verify" },
  { method: "POST", path: "/verify" },
];

export function brokerRouteFor(method: string, pathname: string): string | null {
  if (!site().brokerUpstream || !AUTH_BROKER_PREFIX || !pathname.startsWith(`${AUTH_BROKER_PREFIX}/`)) return null;
  const rest = pathname.slice(AUTH_BROKER_PREFIX.length);
  return BROKER_PUBLIC_ROUTES.some((route) => route.method === method && route.path === rest) ? rest : null;
}

export const XFF_TRUSTED_HOPS = Math.max(0, Math.trunc(Number(process.env.PORTAL_XFF_TRUSTED_HOPS ?? 0)) || 0);

export function clientIpOf(req: IncomingMessage): string {
  const socket = req.socket.remoteAddress || "unknown";
  if (XFF_TRUSTED_HOPS === 0) return socket;
  const forwarded = req.headers["x-forwarded-for"];
  const hops = (typeof forwarded === "string" ? forwarded : "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops[hops.length - XFF_TRUSTED_HOPS] ?? socket;
}

export const principalRule = (): PrincipalRule => site().principalRule;

const DEV_SECRET = "dev-only-insecure-portal-session-secret";

export interface Site {
  tenantId: string;
  principalRule: PrincipalRule;
  publicUrl: string;
  origin: string;
  appsDomain: string | undefined;
  cookieDomain: string | undefined;
  oidc: OidcConfig | null;
  brokerUpstream: string;
  trusted: OidcConfig | null;
  trustedLabel: string | undefined;
  trustedAdmin: boolean;
  faviconSvg: string | undefined;
  apiAllowedOrigins: ReadonlySet<string>;
  sessionSecret: string;
  sessionKey: Buffer;
  tmpKey: Buffer;
  impersonateKey: Buffer;
}

function siteSecrets(tenantId: string): Pick<Site, "sessionSecret" | "sessionKey" | "tmpKey" | "impersonateKey"> {
  const base = SESSION_SECRET ?? DEV_SECRET;
  const sessionSecret = deriveTenantSecret(base, tenantId);
  return {
    sessionSecret,
    sessionKey: deriveKey(sessionSecret, "portal.session.v1"),
    tmpKey: deriveKey(sessionSecret, "portal.tmp.v1"),
    impersonateKey: deriveKey(sessionSecret, "portal.impersonate.v1"),
  };
}

function trustedSite(trusted: OidcConfig | null, label: string | undefined, admin: boolean) {
  const identity = portalIdentitySecret();
  const distinct = Boolean(identity && identity.length >= 32 && identity !== coreSigningSecret());
  if (admin && (!trusted || !distinct))
    throw new Error("Trusted administrator provisioning requires trusted OIDC and a distinct portal identity secret");
  return { trusted, trustedLabel: trusted ? label?.trim() || undefined : undefined, trustedAdmin: admin };
}

function brokerOidc(publicUrl: string, tenantId: string): OidcConfig {
  const issuer = `${publicUrl}${AUTH_BROKER_PREFIX}`;
  return {
    issuer,
    authEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${AUTH_BROKER_UPSTREAM}/token`,
    userinfoEndpoint: `${AUTH_BROKER_UPSTREAM}/userinfo`,
    jwksUri: `${AUTH_BROKER_UPSTREAM}/.well-known/jwks.json`,
    clientId: process.env.OIDC_CLIENT_ID ?? "",
    clientSecret: deriveTenantSecret(process.env.OIDC_CLIENT_SECRET ?? "", tenantId),
    scopes: "openid profile email",
    redirectUri: `${publicUrl}/auth/callback`,
    headers: { "x-forwarded-host": hostOf(publicUrl) },
  };
}

function tenantSite(tenant: TenantSettings & { id: string }): Site {
  const publicUrl = tenantPublicUrl(tenant);
  const appsDomain = tenant.appsDomain || undefined;
  const trusted = tenant.secrets.trustedOidc;
  const result: Site = {
    tenantId: tenant.id,
    principalRule: tenant.principalRule ?? { claim: "email", requireCoreAdmission: Boolean(AUTH_BROKER_UPSTREAM) },
    publicUrl,
    origin: originOf(publicUrl),
    appsDomain,
    cookieDomain: appsDomain ? derivedCookieDomain(hostOf(publicUrl), appsDomain) : undefined,
    oidc: tenant.secrets.primaryOidc ?? (AUTH_BROKER_UPSTREAM ? brokerOidc(publicUrl, tenant.id) : null),
    brokerUpstream: AUTH_BROKER_UPSTREAM,
    ...trustedSite(
      trusted
        ? trustedEntryConfig(
            {
              NODE_ENV: IS_PROD ? "production" : "test",
              PORTAL_TRUSTED_OIDC: JSON.stringify(trusted),
              CORE_SIGNING_SECRET: coreSigningSecret(),
              PORTAL_SESSION_SECRET: siteSecrets(tenant.id).sessionSecret,
            },
            publicUrl,
            trusted,
          )
        : null,
      tenant.oidcLabel,
      tenant.oidcAdmin,
    ),
    faviconSvg: tenant.faviconSvg,
    apiAllowedOrigins: new Set(tenant.apiAllowedOrigins ?? []),
    ...siteSecrets(tenant.id),
  };
  validateSite(result);
  return result;
}

function validateSite(value: Site): void {
  const cors = parseAllowedOrigins([...value.apiAllowedOrigins].join(","));
  if (cors.problems.length) throw new Error(cors.problems.join("; "));
  for (const origin of cors.origins) {
    if (origin === value.origin || (value.appsDomain && hostIsWithinDomain(hostOf(origin), value.appsDomain)))
      throw new Error("Tenant cross-origin access may not trust its own origin or its published apps");
  }
  if (PLAYGROUND && value.appsDomain)
    throw new Error("Anonymous portal sessions may not share a domain with published apps");
  const rule = value.principalRule;
  if (rule.claim !== "sub" && rule.claim !== "email") throw new Error("Tenant principal claim must be sub or email");
  if ((rule.allowedEmailDomain || rule.allowedEmails?.length) && rule.claim !== "email")
    throw new Error("Tenant email restrictions require an email principal claim");
  if (!IS_PROD) return;
  if (!value.publicUrl.startsWith("https://")) throw new Error("Tenant portal URL must be https in production");
  if (value.appsDomain && !value.cookieDomain)
    throw new Error("Tenant portal and published apps must share a cookie domain");
  const oidc = value.oidc;
  if (!oidc) return;
  if (isMissingOrPlaceholder(oidc.clientId) || isMissingOrPlaceholder(oidc.clientSecret))
    throw new Error("Tenant primary sign-in requires a client id and secret");
  if (!rule.requireCoreAdmission && !rule.allowedEmailDomain && !rule.allowedEmails?.length && !oidc.expectedTeamId)
    throw new Error("Tenant primary sign-in requires an identity-provider trust boundary");
  if (!oidc.authEndpoint.startsWith("https://")) throw new Error("Tenant authorization endpoint must be https");
  for (const endpoint of [oidc.tokenEndpoint, oidc.userinfoEndpoint, oidc.jwksUri]) {
    const broker =
      AUTH_BROKER_UPSTREAM &&
      isPrivateNetworkUrl(AUTH_BROKER_UPSTREAM) &&
      originOf(endpoint) === originOf(AUTH_BROKER_UPSTREAM);
    if (!endpoint.startsWith("https://") && !broker)
      throw new Error("Tenant sign-in endpoints must use https or the private broker");
  }
  if (!isSlackIssuer(oidc.issuer) && !oidc.jwksUri) throw new Error("Tenant primary sign-in requires a JWKS URI");
}

const tenantSites = new WeakMap<TenantSettings, Site>();

function servedSite(tenant: TenantSettings & { id: string }): Site {
  try {
    return tenantSite(tenant);
  } catch (error) {
    reportFailure(`portal: tenant ${tenant.slug} trusted sign-in is misconfigured and stays off`, error);
    return tenantSite({
      ...tenant,
      oidcClientId: undefined,
      oidcAdmin: false,
      secrets: { ...tenant.secrets, trustedOidc: undefined },
    });
  }
}

export function site(): Site {
  const tenant = edgeTenant();
  if (!tenant?.id) throw new Error("Portal work requires a registered tenant");
  let found = tenantSites.get(tenant);
  if (!found) {
    found = servedSite({ ...tenant, id: tenant.id });
    tenantSites.set(tenant, found);
  }
  return found;
}

export const IMPERSONATE_TTL_S = 3600;

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function derivedCookieDomain(portalHost: string, appsDomain: string): string | undefined {
  const host = portalHost.toLowerCase();
  return host.includes(".") && appsDomain.toLowerCase().endsWith(`.${host}`) ? host : undefined;
}

export function hostIsWithinDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase().replace(/^\./, "");
  return !!h && !!d && (h === d || h.endsWith(`.${d}`));
}

function isLocalPortalUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

export function isPrivateNetworkUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  return isPrivateNetworkIp(host);
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("127.")
  );
}

export function bootChecks(): void {
  const problems: string[] = [];
  if (IS_PROD) {
    if (isMissingOrPlaceholder(SESSION_SECRET)) problems.push("PORTAL_SESSION_SECRET is required in production");
    if (isMissingOrPlaceholder(coreSigningSecret())) problems.push("CORE_SIGNING_SECRET is required in production");
    if (SESSION_SECRET === coreSigningSecret())
      problems.push("PORTAL_SESSION_SECRET must differ from CORE_SIGNING_SECRET");
    if (AUTH_BROKER_UPSTREAM && !isPrivateNetworkUrl(AUTH_BROKER_UPSTREAM))
      problems.push("AUTH_BROKER_UPSTREAM must address a private-network host");
    if (LOCAL_AUTH_BYPASS_REQUESTED) problems.push("PORTAL_LOCAL_AUTH_BYPASS may not be enabled in production");
  }
  if (!Number.isFinite(SESSION_TTL_S) || SESSION_TTL_S <= 0)
    problems.push("PORTAL_SESSION_TTL_S must be a positive number of seconds");
  if (problems.length) throw new Error(`portal refusing to start: ${problems.join("; ")}`);
}
