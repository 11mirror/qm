import { endpointTransport } from "../../deploy/endpoint-transport.ts";
import { type Reach } from "../../deploy/deploy-service.ts";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  connect as connectHttp2,
  constants as http2Constants,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type OutgoingHttpHeaders,
} from "node:http2";
import { sendJson } from "../http.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../auth/portal-identity.ts";
import type { BaseCtx } from "./route.ts";
import { viewerIdentityKey } from "../../deploy/access-token.ts";
import { proxyHeaders } from "../../util/http-proxy.ts";

const DEPLOY_DIAL_TIMEOUT_MS = 20_000;

export const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const GATEWAY_AUTH_HEADERS = [
  "x-qm-app-host",
  "x-qm-client-ip",
  "x-signature",
  "x-timestamp",
  "x-as-principal",
  "x-admin-actor",
  "x-agent-capability",
  PORTAL_IDENTITY_HEADER,
];

const PROXY_BUFFER_MAX_BYTES = 10_000_000;
export const AGENT_FETCH_DEFAULT_MAX_BYTES = 256 * 1024;
export const AGENT_FETCH_MAX_BYTES = 1024 * 1024;
const AGENT_FETCH_TIMEOUT_MS = 10_000;
const AGENT_FETCH_MAX_REDIRECTS = 5;

const THROTTLE_SHIELD_MS = 5_000;
const throttledUpstreams = new Map<string, number>();

function setPruned(map: Map<string, number>, key: string, value: number, stale: (value: number) => boolean): void {
  if (map.size > 1000) for (const [k, v] of map) if (stale(v)) map.delete(k);
  map.set(key, value);
}

function armThrottleShield(upstreamKey: string, statusCode: number, upstream: NodeJS.EventEmitter): void {
  if (statusCode !== 429) return;
  let sawBody = false;
  upstream.on("data", () => (sawBody = true));
  upstream.on("end", () => {
    if (sawBody) return;
    setPruned(throttledUpstreams, upstreamKey, Date.now() + THROTTLE_SHIELD_MS, (until) => Date.now() >= until);
  });
}
type OkReach = Extract<Reach, { status: "ok" }>;
type ProxyOptions = { sandbox?: boolean; frameAncestors?: readonly string[] };

const endpointOrigin = ({ endpoint: { host, port, tls } }: OkReach): string =>
  `${tls ? "https" : "http"}://${host}:${port}`;
const endpointAuthority = ({ endpoint: { host, port, tls } }: OkReach): string => (tls ? host : `${host}:${port}`);

function writeUpstreamHead(
  res: BaseCtx["res"],
  upstreamKey: string,
  status: number,
  headers: Record<string, string | string[] | number | undefined>,
  upstream: NodeJS.EventEmitter,
  opts: ProxyOptions,
): void {
  markUpstreamUp(upstreamKey);
  armThrottleShield(upstreamKey, status, upstream);
  const safeHeaders = gatewaySafeResponseHeaders(headers, opts.sandbox ?? false, opts.frameAncestors);
  if (opts.frameAncestors !== undefined) res.removeHeader("content-security-policy");
  res.writeHead(status, safeHeaders);
}

function sendUpstreamFailure(res: BaseCtx["res"], htmlNav: boolean, timedOut: boolean): boolean {
  if (res.headersSent) return false;
  if (htmlNav) sendWarmingPage(res);
  else if (timedOut) sendJson(res, 504, { error: "gateway_timeout", message: "deployment did not respond" });
  else sendJson(res, 502, { error: "bad_gateway", message: "deployment unreachable" });
  return true;
}

const HTTP2_IDLE_TIMEOUT_MS = 60_000;
const HTTP2_DRAIN_TIMEOUT_MS = 5_000;
interface DeploymentHttp2Connection {
  session: ClientHttp2Session;
  activeStreams: number;
  idleTimer?: NodeJS.Timeout;
  retiring?: boolean;
}
const deploymentHttp2Sessions = new Map<string, DeploymentHttp2Connection>();

const TRACE_HEADERS = ["sentry-trace", "baggage", "traceparent", "tracestate"];

function forwardableHeaders(req: BaseCtx["req"]): Record<string, string | string[]> {
  const out = proxyHeaders(req.headers, ["host", ...GATEWAY_AUTH_HEADERS, ...TRACE_HEADERS]);
  const kept = String(out.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^(?:dpl_access|dpl_owner|portal_session|portal_session_x)\s*=/.test(part));
  if (kept.length) out.cookie = kept.join("; ");
  else delete out.cookie;
  return out;
}

const APP_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

export function frameAncestorsDirective(ancestors: readonly string[]): string {
  return `frame-ancestors 'self' ${ancestors.join(" ")}`;
}

function appendHeader(out: Record<string, string | string[]>, name: string, value: string): void {
  const existing = out[name];
  out[name] = existing ? [...(Array.isArray(existing) ? existing : [existing]), value] : value;
}

function gatewaySafeResponseHeaders(
  headers: Record<string, string | string[] | number | undefined>,
  sandbox = false,
  frameAncestors?: readonly string[],
): Record<string, string | string[]> {
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined || name.startsWith(":")) continue;
    normalized[name] = typeof value === "number" ? String(value) : value;
  }
  const out = proxyHeaders(normalized);
  const cookies = out["set-cookie"];
  if (cookies) {
    const values = Array.isArray(cookies) ? cookies : [cookies];
    const kept = values.filter(
      (cookie) => !/^\s*(?:dpl_access|dpl_owner|portal_session|portal_session_x)\s*=/i.test(cookie),
    );
    if (kept.length) out["set-cookie"] = kept;
    else delete out["set-cookie"];
  }
  delete out["clear-site-data"];
  if (sandbox) appendHeader(out, "content-security-policy", APP_SANDBOX_CSP);
  const csp = [out["content-security-policy"] ?? []].flat();
  if (frameAncestors?.length && !out["x-frame-options"] && !csp.some((v) => /frame-ancestors/i.test(v)))
    appendHeader(out, "content-security-policy", frameAncestorsDirective(frameAncestors));
  return out;
}

function deploymentHttp2Session(origin: string): DeploymentHttp2Connection {
  const existing = deploymentHttp2Sessions.get(origin);
  if (existing && !existing.session.closed && !existing.session.destroyed) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = undefined;
    return existing;
  }
  const session = connectHttp2(origin);
  session.unref();
  const connection: DeploymentHttp2Connection = { session, activeStreams: 0 };
  deploymentHttp2Sessions.set(origin, connection);
  const remove = (): void => {
    if (deploymentHttp2Sessions.get(origin) === connection) deploymentHttp2Sessions.delete(origin);
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = undefined;
  };
  session.on("error", () => {
    remove();
    session.destroy();
  });
  session.on("close", remove);
  session.on("goaway", () => retireDeploymentHttp2Connection(origin, connection));
  return connection;
}

function retireDeploymentHttp2Connection(origin: string, connection: DeploymentHttp2Connection): void {
  if (deploymentHttp2Sessions.get(origin) === connection) deploymentHttp2Sessions.delete(origin);
  if (connection.retiring || connection.session.destroyed) return;
  connection.retiring = true;
  connection.session.close();
  const timer = setTimeout(() => connection.session.destroy(), HTTP2_DRAIN_TIMEOUT_MS);
  timer.unref();
  connection.session.once("close", () => clearTimeout(timer));
}

function releaseDeploymentHttp2Stream(origin: string, connection: DeploymentHttp2Connection): void {
  connection.activeStreams--;
  if (connection.activeStreams !== 0 || deploymentHttp2Sessions.get(origin) !== connection) return;
  connection.idleTimer = setTimeout(() => connection.session.close(), HTTP2_IDLE_TIMEOUT_MS);
  connection.idleTimer.unref();
}

function http2SessionFailed(connection: DeploymentHttp2Connection, error: unknown, codes: string[]): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return connection.session.closed || connection.session.destroyed || (!!code && codes.includes(code));
}

function checkDeploymentHttp2Session(connection: DeploymentHttp2Connection): void {
  const timer = setTimeout(() => connection.session.destroy(), 1_000);
  timer.unref();
  try {
    connection.session.ping((error) => {
      clearTimeout(timer);
      if (error) connection.session.destroy();
    });
  } catch {
    clearTimeout(timer);
    connection.session.destroy();
  }
}

function proxyReachHttp2(
  ctx: BaseCtx,
  endpoint: OkReach,
  subPath: string,
  headers: Record<string, string | string[]>,
  bufferedBody: Buffer | null,
  opts: ProxyOptions,
): void {
  const { req, res, deps, url, method } = ctx;
  const { host, port } = endpoint.endpoint;
  const origin = endpointOrigin(endpoint);
  const htmlNav = wantsWarmingPage(req, method);
  const requestHeaders: OutgoingHttpHeaders = {
    ":method": method,
    ":path": subPath + url.search,
    ":authority": endpointAuthority(endpoint),
  };
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "host") requestHeaders[name.toLowerCase()] = value;
  }
  const replaySafe =
    (method === "GET" || method === "HEAD") && bufferedBody === null && headers["content-length"] === undefined;
  let current: ClientHttp2Stream | undefined;
  res.on("close", () => {
    if (current && !current.closed) current.close(http2Constants.NGHTTP2_CANCEL);
  });
  req.on("error", () => current?.close(http2Constants.NGHTTP2_CANCEL));
  req.on("aborted", () => current?.close(http2Constants.NGHTTP2_CANCEL));

  const start = (retried: boolean): void => {
    const connection = deploymentHttp2Session(origin);
    let up: ClientHttp2Stream;
    try {
      up = connection.session.request(requestHeaders);
    } catch (error) {
      const sessionFailed = http2SessionFailed(connection, error, [
        "ERR_HTTP2_GOAWAY_SESSION",
        "ERR_HTTP2_OUT_OF_STREAMS",
        "ERR_HTTP2_INVALID_SESSION",
      ]);
      if (sessionFailed) retireDeploymentHttp2Connection(origin, connection);
      if (replaySafe && !retried && sessionFailed && !res.headersSent && !res.destroyed && !res.writableEnded)
        return start(true);
      if (res.destroyed || res.writableEnded) return;
      sendJson(res, 502, { error: "bad_gateway", message: "deployment unreachable" });
      return;
    }
    current = up;
    connection.activeStreams++;
    let responseStarted = false;
    let failureHandled = false;
    const fail = (error?: unknown): void => {
      if (failureHandled) return;
      failureHandled = true;
      const sessionFailed = http2SessionFailed(connection, error, [
        "ECONNRESET",
        "ERR_HTTP2_SESSION_ERROR",
        "ERR_HTTP2_INVALID_SESSION",
      ]);
      if (sessionFailed) retireDeploymentHttp2Connection(origin, connection);
      const moved = deploymentHttp2Sessions.get(origin) !== connection;
      if (
        !responseStarted &&
        replaySafe &&
        !retried &&
        (sessionFailed || moved) &&
        !res.headersSent &&
        !res.destroyed &&
        !res.writableEnded
      ) {
        up.setTimeout(0);
        if (!up.closed) up.close(http2Constants.NGHTTP2_CANCEL);
        return start(true);
      }
      if (res.destroyed || res.writableEnded) return;
      if (!sendUpstreamFailure(res, htmlNav, false)) res.destroy();
    };
    up.once("close", () => {
      releaseDeploymentHttp2Stream(origin, connection);
      if (!responseStarted || !up.readableEnded || up.rstCode !== http2Constants.NGHTTP2_NO_ERROR) fail();
      else if (!failureHandled && !res.destroyed && !res.writableEnded) res.end();
    });
    up.setTimeout(
      warmingDialTimeoutMs(`${host}:${port}`, htmlNav, deps.deployDialTimeoutMs ?? DEPLOY_DIAL_TIMEOUT_MS),
      () => {
        if (failureHandled) return;
        failureHandled = true;
        if (!sendUpstreamFailure(res, htmlNav, true)) res.end();
        up.close(http2Constants.NGHTTP2_CANCEL);
        checkDeploymentHttp2Session(connection);
      },
    );
    up.on("response", (responseHeaders) => {
      if (failureHandled || res.headersSent || res.destroyed || res.writableEnded) {
        up.close(http2Constants.NGHTTP2_CANCEL);
        return;
      }
      responseStarted = true;
      up.setTimeout(0);
      writeUpstreamHead(res, `${host}:${port}`, Number(responseHeaders[":status"] ?? 502), responseHeaders, up, opts);
      up.pipe(res, { end: false });
    });
    up.on("error", fail);
    if (replaySafe) up.end();
    else if (bufferedBody !== null) up.end(bufferedBody);
    else req.pipe(up);
  };
  start(false);
}

const WARM_RECENT_MS = 60_000;
const COLD_FIRST_BYTE_TIMEOUT_MS = 4_000;
const upstreamLastOk = new Map<string, number>();

function markUpstreamUp(upstreamKey: string): void {
  setPruned(upstreamLastOk, upstreamKey, Date.now(), (at) => Date.now() - at > WARM_RECENT_MS);
}

function wantsWarmingPage(req: BaseCtx["req"], method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const dest = String(req.headers["sec-fetch-dest"] ?? "");
  if (dest && dest !== "document") return false;
  return String(req.headers.accept ?? "").includes("text/html");
}

function warmingDialTimeoutMs(upstreamKey: string, htmlNav: boolean, configuredMs: number): number {
  if (!htmlNav) return configuredMs;
  const lastOk = upstreamLastOk.get(upstreamKey) ?? 0;
  if (Date.now() - lastOk < WARM_RECENT_MS) return configuredMs;
  return Math.min(configuredMs, COLD_FIRST_BYTE_TIMEOUT_MS);
}

const WARMING_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting up…</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fafaf8;color:#333}
  .card{text-align:center;padding:2rem}
  .spinner{width:28px;height:28px;margin:0 auto 1rem;border:3px solid #eee;border-top-color:#f26522;
    border-radius:50%;animation:spin .9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:1.1rem;font-weight:600;margin:0 0 .35rem}
  p{margin:0;color:#777}
</style></head>
<body><div class="card"><div class="spinner"></div><h1>Starting up&hellip;</h1>
<p id="msg"></p></div>
<script>
  var started = Date.now();
  function retry(){
    if (Date.now() - started > 120000) {
      document.getElementById("msg").textContent = "Still not responding — the app may have crashed.";
      return;
    }
    fetch(location.href, { method: "HEAD", cache: "no-store" }).then(function(r){
      if (r.status !== 503 && r.status !== 502 && r.status !== 504) location.reload();
      else setTimeout(retry, 2000);
    }).catch(function(){ setTimeout(retry, 2000); });
  }
  setTimeout(retry, 1500);
</script></body></html>`;

function sendWarmingPage(res: BaseCtx["res"]): void {
  if (res.headersSent || res.destroyed || res.writableEnded) {
    res.end();
    return;
  }
  res.writeHead(503, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": "2",
  });
  res.end(WARMING_PAGE_HTML);
}

export async function proxyReach(
  ctx: BaseCtx,
  reach: Reach,
  subPath: string,
  viewer?: string,
  opts: ProxyOptions = {},
): Promise<void> {
  const { req, res, deps, url, method } = ctx;
  if (res.destroyed) return;
  if (reach.status === "not_found") return sendJson(res, 404, { error: "not_found" });
  if (reach.status === "denied")
    return sendJson(res, 403, { error: "forbidden", message: "not in the deployment's scope" });
  const { host, port } = reach.endpoint;
  const upstreamKey = `${host}:${port}`;
  const shieldedUntil = throttledUpstreams.get(upstreamKey) ?? 0;
  if (Date.now() < shieldedUntil) {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(Math.max(1, Math.ceil((shieldedUntil - Date.now()) / 1000))),
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ error: "throttled", message: "deployment is rate limited upstream" }));
    return;
  }
  let bufferedBody: Buffer | null = null;
  const headers: Record<string, string | string[]> = {
    ...forwardableHeaders(req),
    host: endpointAuthority(reach),
    ...reach.endpoint.proxyHeaders,
  };

  if (viewer && ctx.secret) {
    headers[PORTAL_IDENTITY_HEADER] = await mintPortalIdentity(
      { p: viewer, exp: Date.now() + 60_000 },
      viewerIdentityKey(ctx.secret, reach.id),
    );
  }
  if (/(?:^|,)\s*chunked\s*$/i.test(String(req.headers["transfer-encoding"] ?? ""))) {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > PROXY_BUFFER_MAX_BYTES)
          return sendJson(res, 413, { error: "payload_too_large", message: "request body too large" });
        chunks.push(chunk as Buffer);
      }
    } catch {
      res.destroy();
      return;
    }
    bufferedBody = Buffer.concat(chunks);
    headers["content-length"] = String(bufferedBody.length);
  }
  if (res.destroyed) return;
  if (reach.endpoint.httpVersion === "2") {
    proxyReachHttp2(ctx, reach, subPath, headers, bufferedBody, opts);
    return;
  }
  const htmlNav = wantsWarmingPage(req, method);
  const up = (reach.endpoint.tls ? httpsRequest : httpRequest)(
    {
      ...endpointTransport(reach.endpoint),
      hostname: host,
      port,
      path: subPath + url.search,
      method,
      headers,
    },
    (upRes) => {
      up.setTimeout(0);
      upRes.on("error", () => res.destroy());
      writeUpstreamHead(res, upstreamKey, upRes.statusCode ?? 502, upRes.headers, upRes, opts);
      upRes.pipe(res);
    },
  );
  up.setTimeout(warmingDialTimeoutMs(upstreamKey, htmlNav, deps.deployDialTimeoutMs ?? DEPLOY_DIAL_TIMEOUT_MS), () => {
    if (!sendUpstreamFailure(res, htmlNav, true)) res.end();
    up.destroy();
  });
  up.on("error", () => {
    if (!sendUpstreamFailure(res, htmlNav, false)) res.end();
  });
  req.on("error", () => up.destroy());
  if (bufferedBody !== null) up.end(bufferedBody);
  else req.pipe(up);
}

interface DeploymentFetchResult {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: Buffer;
  truncated: boolean;
}

function boundedResponseBody(
  stream: NodeJS.ReadableStream & { destroy(error?: Error): void },
  maxBytes: number,
  timeoutMs = AGENT_FETCH_TIMEOUT_MS,
): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timeout = setTimeout(() => stream.destroy(new Error("timeout")), Math.max(1, timeoutMs));
    timeout.unref();
    const finish = (truncated: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ body: Buffer.concat(chunks, Math.min(size, maxBytes)), truncated });
      if (truncated) stream.destroy();
    };
    stream.on("data", (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const remaining = maxBytes - size;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      size += Math.min(chunk.length, Math.max(remaining, 0));
      if (chunk.length > remaining) finish(true);
    });
    stream.on("end", () => finish(false));
    const fail = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error ?? new Error("upstream aborted"));
    };
    stream.on("error", fail);
    stream.on("aborted", fail);
  });
}

function deploymentFetchHttp1(
  endpoint: OkReach,
  path: string,
  maxBytes: number,
  deadline: number,
): Promise<DeploymentFetchResult> {
  return new Promise((resolve, reject) => {
    const { host, port, tls, proxyHeaders } = endpoint.endpoint;
    const request = (tls ? httpsRequest : httpRequest)(
      {
        ...endpointTransport(endpoint.endpoint),
        hostname: host,
        port,
        path,
        method: "GET",
        headers: { ...proxyHeaders, "accept-encoding": "identity" },
      },
      async (response) => {
        clearTimeout(timeout);
        try {
          const collected = await boundedResponseBody(response, maxBytes, deadline - Date.now());
          resolve({ status: response.statusCode ?? 502, headers: response.headers, ...collected });
        } catch (error) {
          reject(error);
        }
      },
    );
    const timeout = setTimeout(() => request.destroy(new Error("timeout")), Math.max(1, deadline - Date.now()));
    timeout.unref();
    request.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.end();
  });
}

function deploymentFetchHttp2(
  endpoint: OkReach,
  path: string,
  maxBytes: number,
  deadline: number,
): Promise<DeploymentFetchResult> {
  return new Promise((resolve, reject) => {
    const origin = endpointOrigin(endpoint);
    const connection = deploymentHttp2Session(origin);
    const stream = connection.session.request({
      ":method": "GET",
      ":path": path,
      ":authority": endpointAuthority(endpoint),
      "accept-encoding": "identity",
      ...endpoint.endpoint.proxyHeaders,
    });
    connection.activeStreams++;
    let headers: Record<string, string | string[] | number | undefined> = {};
    stream.on("response", (responseHeaders) => {
      headers = responseHeaders;
    });
    boundedResponseBody(stream, maxBytes, deadline - Date.now())
      .then((collected) => resolve({ status: Number(headers[":status"] ?? 502), headers, ...collected }))
      .catch(reject);
    stream.once("close", () => releaseDeploymentHttp2Stream(origin, connection));
    stream.end();
  });
}

export function normalizedDeploymentFetchPath(raw: string | null): string | null {
  const path = raw ?? "/";
  if (!path.startsWith("/") || path.includes("\\") || path.includes("\0")) return null;
  try {
    let decodedPath = path.split("?", 1)[0]!;
    for (let depth = 0; depth < 8; depth++) {
      const next = decodeURIComponent(decodedPath);
      if (
        next.includes("\\") ||
        next.includes("\0") ||
        next.split("/").some((segment) => segment === "." || segment === "..")
      )
        return null;
      if (next === decodedPath) break;
      if (depth === 7) return null;
      decodedPath = next;
    }
    const normalized = new URL(path, "http://deployment.invalid");
    if (normalized.origin !== "http://deployment.invalid") return null;
    return normalized.pathname + normalized.search;
  } catch {
    return null;
  }
}

function redirectPath(
  endpoint: OkReach,
  location: string | string[] | number | undefined,
  currentPath: string,
): string | null {
  if (typeof location !== "string") return null;
  try {
    const origin = endpointOrigin(endpoint);
    const next = new URL(location, `${origin}${currentPath}`);
    if (next.origin !== origin) return null;
    return normalizedDeploymentFetchPath(next.pathname + next.search);
  } catch {
    return null;
  }
}

export async function fetchDeploymentResponse(
  endpoint: OkReach,
  initialPath: string,
  maxBytes: number,
): Promise<DeploymentFetchResult> {
  let path = initialPath;
  const deadline = Date.now() + AGENT_FETCH_TIMEOUT_MS;
  for (let redirects = 0; ; redirects++) {
    const response =
      endpoint.endpoint.httpVersion === "2"
        ? await deploymentFetchHttp2(endpoint, path, maxBytes, deadline)
        : await deploymentFetchHttp1(endpoint, path, maxBytes, deadline);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects >= AGENT_FETCH_MAX_REDIRECTS) throw new Error("too many redirects");
    const next = redirectPath(endpoint, response.headers.location, path);
    if (!next) throw new Error("redirect leaves deployment");
    path = next;
  }
}
