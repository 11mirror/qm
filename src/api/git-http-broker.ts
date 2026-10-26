import { Readable } from "node:stream";
import type { AuditEvent } from "../audit/audit-log.ts";
import { isValidCredentialSlug, isComposioHost } from "../credentials/keychain.ts";
import {
  brokerMethodAllowed,
  brokerPathAllowed,
  brokerRequestHeaders,
  grantedCredential,
  recordBrokerOutcome,
} from "./credential-broker.ts";
import { pipeToResponse, sendJson } from "./http.ts";
import type { BaseCtx } from "./routes/route.ts";
import { proxyHeaders } from "../util/http-proxy.ts";
import { tenant } from "../tenant.ts";

export const GIT_HTTP_BROKER_PREFIX = "/v1/credentials/git/";

const ALLOWED_GIT_HEADERS = new Set(["accept", "content-length", "content-type", "git-protocol", "user-agent"]);

interface GitHttpFetchResponse {
  status: number;
  headers?: Record<string, string>;
  body?: NodeJS.ReadableStream | null;
}

export type GitHttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: NodeJS.ReadableStream },
) => Promise<GitHttpFetchResponse>;

const realGitHttpFetch: GitHttpFetch = async (url, init) => {
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

function parseBrokerPath(pathname: string): { slug: string; upstreamPath: string } | null {
  if (!pathname.startsWith(GIT_HTTP_BROKER_PREFIX)) return null;
  const rest = pathname.slice(GIT_HTTP_BROKER_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return null;
  }
  if (!isValidCredentialSlug(slug)) return null;
  const upstreamPath = `/${rest.slice(slash + 1)}`;
  if (upstreamPath === "/" || upstreamPath.includes("\0")) return null;
  return { slug, upstreamPath };
}

function callerHeaders(ctx: BaseCtx): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.req.headers)) {
    const lower = key.toLowerCase();
    if (typeof value === "string" && ALLOWED_GIT_HEADERS.has(lower)) headers[lower] = value;
  }
  return headers;
}

export async function brokerGitHttp(ctx: BaseCtx): Promise<void> {
  const parsed = parseBrokerPath(ctx.pathname);
  if (!parsed) return sendJson(ctx.res, 404, { error: "not_found" });
  const { slug, upstreamPath } = parsed;
  const method = ctx.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return sendJson(ctx.res, 405, { error: "method_not_allowed", message: "git smart HTTP supports GET and POST" });
  }
  if (!ctx.deps.serviceCreds) return sendJson(ctx.res, 404, { error: "not_found" });

  const claims = ctx.capability;
  if (!claims) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const sinks = {
    usage: ctx.deps.credentialUsage,
    audit: (e: Omit<AuditEvent, "at">) => ctx.deps.auditLog?.record({ at: Date.now(), ...e }),
  };
  const deny = (status: number, code: string, message: string, host: string): void => {
    recordBrokerOutcome(sinks, claims, "git", { slug, host, status: "denied", detail: code });
    sendJson(ctx.res, status, { error: code, message });
  };
  const grant = await grantedCredential(claims, slug, ctx.deps.serviceCreds, tenant().orgScope);
  if (!grant.rec) return deny(grant.status, grant.code, grant.message, grant.host);
  const { rec } = grant;
  if (!brokerMethodAllowed(rec, method))
    return deny(403, "method_not_allowed", `method ${method} is not allowed for this credential`, rec.host);
  const upstream = new URL(`https://${rec.host}${upstreamPath}`);
  upstream.search = ctx.url.search;
  if (isComposioHost(upstream.hostname))
    return deny(403, "backend_only", "Composio calls must use /v1/composio", rec.host);
  if (!brokerPathAllowed(upstream.pathname, rec.allowedPathPrefixes))
    return deny(403, "path_not_allowed", "url path is not in the credential's allowlist", rec.host);

  let upstreamResp: GitHttpFetchResponse;
  try {
    upstreamResp = await (ctx.deps.gitHttpFetch ?? realGitHttpFetch)(upstream.toString(), {
      method,
      headers: brokerRequestHeaders(rec, callerHeaders(ctx)),
      ...(method === "POST" ? { body: ctx.req } : {}),
    });
  } catch {
    recordBrokerOutcome(sinks, claims, "git", { slug, host: rec.host, status: "error" });
    return sendJson(ctx.res, 502, {
      error: "upstream_unreachable",
      message: "the credential's host could not be reached",
    });
  }

  recordBrokerOutcome(sinks, claims, "git", {
    slug,
    host: rec.host,
    status: "ok",
    upstreamStatus: upstreamResp.status,
  });
  ctx.res.writeHead(
    upstreamResp.status,
    proxyHeaders(upstreamResp.headers ?? {}, ["content-encoding", "content-length"]),
  );
  if (!upstreamResp.body) {
    ctx.res.end();
    return;
  }
  pipeToResponse(ctx.res, upstreamResp.body, "git upstream stream failed");
}
