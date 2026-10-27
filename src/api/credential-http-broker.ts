import { Readable } from "node:stream";
import type { BrokeredConnector, CapabilityClaims } from "../auth/capability-token.ts";
import { isValidCredentialSlug, isComposioHost } from "../credentials/keychain.ts";
import {
  brokerSinks,
  brokerPathAllowed,
  grantedCredential,
  recordBrokerOutcome,
  serviceCallDenial,
  serviceRequestHeaders,
  reportUpstreamFailure,
  upstreamUnreachable,
} from "./credential-broker.ts";
import { pipeToResponse } from "./http.ts";
import { type BaseCtx, reply, type RouteResult } from "./routes/route.ts";
import { HOP_BY_HOP, proxyHeaders } from "../util/http-proxy.ts";
import { tenant } from "../tenant.ts";

export const CREDENTIAL_HTTP_BROKER_PREFIX = "/v1/credentials/http/";

const SHARED_CREDENTIAL_HEADERS = new Set(["accept", "content-length", "content-type", "git-protocol", "user-agent"]);

const CONNECTOR_DROPPED_HEADERS = [
  "authorization",
  "cookie",
  "forwarded",
  "host",
  "x-agent-capability",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-qm-actor",
  "x-real-ip",
];

const CONNECTOR_METHODS = new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);

interface CredentialHttpFetchResponse {
  status: number;
  headers?: Record<string, string>;
  body?: NodeJS.ReadableStream | null;
}

export type CredentialHttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: NodeJS.ReadableStream },
) => Promise<CredentialHttpFetchResponse>;

const realCredentialHttpFetch: CredentialHttpFetch = async (url, init) => {
  const req: RequestInit & { duplex?: "half" } = {
    method: init.method,
    headers: init.headers,
    redirect: "manual",
    ...(init.body ? { body: init.body as unknown as RequestInit["body"], duplex: "half" as const } : {}),
  };
  const resp = await fetch(url, req);
  const headers: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: resp.status,
    headers,
    body: resp.body ? Readable.fromWeb(resp.body as ReadableStream<Uint8Array>) : null,
  };
};

function parseBrokerPath(pathname: string): { ref: string; upstreamPath: string } | null {
  if (!pathname.startsWith(CREDENTIAL_HTTP_BROKER_PREFIX)) return null;
  const rest = pathname.slice(CREDENTIAL_HTTP_BROKER_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  let ref: string;
  try {
    ref = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return null;
  }
  const upstreamPath = `/${rest.slice(slash + 1)}`;
  if (upstreamPath === "/" || upstreamPath.includes("\0")) return null;
  return { ref, upstreamPath };
}

type ConnectorMatch = { connector: BrokeredConnector } | { ambiguous: true } | null;

function connectorFor(claims: CapabilityClaims, ref: string): ConnectorMatch {
  const connectors = claims.connectors ?? [];
  const byHandle = connectors.find((connector) => connector.handle === ref);
  if (byHandle) return { connector: byHandle };
  const byHost = connectors.filter((connector) => connector.host.toLowerCase() === ref.toLowerCase());
  if (byHost.length > 1) return { ambiguous: true };
  return byHost[0] ? { connector: byHost[0] } : null;
}

function callerHeaders(ctx: BaseCtx, connector: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const dropped = new Set([...HOP_BY_HOP, ...CONNECTOR_DROPPED_HEADERS]);
  for (const [key, value] of Object.entries(ctx.req.headers)) {
    const lower = key.toLowerCase();
    if (typeof value !== "string") continue;
    if (connector ? !dropped.has(lower) : SHARED_CREDENTIAL_HEADERS.has(lower)) headers[lower] = value;
  }
  return headers;
}

function responseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return proxyHeaders(headers ?? {}, ["content-encoding", "content-length"]);
}

interface BrokeredTarget {
  slug: string;
  host: string;
  upstream: URL;
  headers: Record<string, string>;
}

export async function brokerCredentialHttp(ctx: BaseCtx): Promise<RouteResult> {
  const parsed = parseBrokerPath(ctx.pathname);
  if (!parsed) return reply(404, { error: "not_found" });
  const { ref, upstreamPath } = parsed;
  const method = ctx.method.toUpperCase();
  const claims = ctx.capability;
  if (!claims) return reply(401, { error: "unauthorized" });

  const sinks = brokerSinks(ctx.deps);
  const record = (
    status: "ok" | "denied" | "error",
    slug: string,
    host: string,
    extra: { detail?: string; upstreamStatus?: number } = {},
  ): void => recordBrokerOutcome(sinks, claims, "http", { slug, host, status, ...extra });
  const deny = (status: number, code: string, message: string, slug: string, host: string): RouteResult => {
    record("denied", slug, host, { detail: code });
    return reply(status, { error: code, message });
  };

  let target: BrokeredTarget;
  const match = connectorFor(claims, ref);
  if (match && "ambiguous" in match)
    return deny(
      409,
      "ambiguous_connector",
      `several selected connected-app accounts use ${ref}; name the credential handle instead of the host`,
      ref,
      ref,
    );
  if (match) {
    const { connector } = match;
    if (!CONNECTOR_METHODS.has(method))
      return deny(405, "method_not_allowed", `method ${method} is not supported`, connector.handle, connector.host);
    if (connector.grantId) {
      const grant = await ctx.deps.keychain?.getGrant(connector.grantId);
      if (!grant || grant.status === "revoked" || (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()))
        return deny(
          403,
          "grant_revoked",
          "the owner's grant for this connected app is no longer active",
          connector.handle,
          connector.host,
        );
    }
    const token = await ctx.deps.connectorTokens?.connectorAccessToken(
      connector.host,
      connector.ownerId,
      connector.accountType,
    );
    if (!token)
      return deny(
        410,
        "connector_unavailable",
        "the connected app's token expired and could not be refreshed; its owner must reconnect the app",
        connector.handle,
        connector.host,
      );
    target = {
      slug: connector.handle,
      host: connector.host,
      upstream: new URL(`https://${connector.host}${upstreamPath}`),
      headers: { ...callerHeaders(ctx, true), authorization: `Bearer ${token}` },
    };
  } else {
    if (!isValidCredentialSlug(ref) || !ctx.deps.serviceCreds) return reply(404, { error: "not_found" });
    const grant = await grantedCredential(claims, ref, ctx.deps.serviceCreds, tenant().orgScope);
    if (!grant.rec) return deny(grant.status, grant.code, grant.message, ref, grant.host);
    const { rec } = grant;
    const upstream = new URL(`https://${rec.host}${upstreamPath}`);
    const denial = await serviceCallDenial(rec, claims, {
      slug: ref,
      method,
      pathname: upstream.pathname,
      usage: sinks.usage,
    });
    if (denial) return deny(denial.status, denial.code, denial.message, ref, rec.host);
    target = {
      slug: ref,
      host: rec.host,
      upstream,
      headers: serviceRequestHeaders(rec, claims, callerHeaders(ctx, false)),
    };
  }
  target.upstream.search = ctx.url.search;
  if (isComposioHost(target.upstream.hostname))
    return deny(403, "backend_only", "Composio calls must use /v1/composio", target.slug, target.host);
  if (!brokerPathAllowed(target.upstream.pathname))
    return deny(403, "path_not_allowed", "url path may not contain dot segments", target.slug, target.host);

  let upstreamResp: CredentialHttpFetchResponse;
  try {
    upstreamResp = await (ctx.deps.credentialHttpFetch ?? realCredentialHttpFetch)(target.upstream.toString(), {
      method,
      headers: target.headers,
      ...(method !== "GET" && method !== "HEAD" ? { body: ctx.req } : {}),
    });
  } catch (error) {
    const detail = reportUpstreamFailure("credential-http-broker: upstream fetch", error, target.slug);
    record("error", target.slug, target.host, { detail });
    return reply(502, upstreamUnreachable(detail));
  }

  record("ok", target.slug, target.host, { upstreamStatus: upstreamResp.status });
  ctx.res.writeHead(upstreamResp.status, responseHeaders(upstreamResp.headers));
  if (!upstreamResp.body) {
    ctx.res.end();
    return;
  }
  pipeToResponse(ctx.res, upstreamResp.body, "credential broker upstream stream failed");
}
