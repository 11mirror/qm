import type { IncomingMessage, ServerResponse } from "node:http";
import { findRoute } from "../../chassis/src/router.ts";

const ALLOWED_METHODS = "GET, POST";
const ALLOWED_HEADERS = "content-type";
const EXPOSED_HEADERS = "content-disposition";
const PREFLIGHT_MAX_AGE_S = 600;

export const CHAT_API_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/me" },
  { method: "POST", path: "/api/turn" },
  { method: "GET", path: "/api/runs/active" },
  { method: "GET", path: "/api/runs/:id" },
  { method: "GET", path: "/api/runs/:id/events" },
  { method: "POST", path: "/api/runs/:id/signal" },
  { method: "POST", path: "/api/runs/:id/withdraw" },
  { method: "GET", path: "/api/sessions" },
  { method: "GET", path: "/api/sessions/:id" },
  { method: "GET", path: "/api/sessions/:id/approvals" },
  { method: "POST", path: "/api/approvals/:id" },
  { method: "POST", path: "/api/blobs" },
  { method: "GET", path: "/api/files/:fileId/content" },
  { method: "GET", path: "/api/files/:fileId/content/:name" },
];

export { parseAllowedOrigins } from "../../chassis/src/allowed-origins.ts";

export function isChatApiRoute(method: string, pathname: string): boolean {
  const found = findRoute(CHAT_API_ROUTES, method, pathname);
  return !!found && found.params.fileId !== "by-name" && Object.values(found.params).every(Boolean);
}

export function prepareCors(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (allowed.size === 0) return undefined;
  const method = req.method === "OPTIONS" ? String(req.headers["access-control-request-method"] ?? "") : req.method;
  if (!isChatApiRoute(method ?? "", pathname)) return undefined;
  res.setHeader("vary", "Origin");
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !allowed.has(origin)) return undefined;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-expose-headers", EXPOSED_HEADERS);
  return origin;
}

export function answerPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": String(PREFLIGHT_MAX_AGE_S),
    "cache-control": "no-store",
  });
  res.end();
}
