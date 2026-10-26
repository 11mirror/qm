import { errMessage } from "./errors.ts";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

const HEALTH_PATHS: ReadonlySet<string> = new Set(["/healthz", "/readyz"]);

export interface HostRoute<T> {
  hosts: readonly string[];
  appsDomain?: string;
  target: T;
}

export interface HostTarget {
  request(req: IncomingMessage, res: ServerResponse): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function coreTenantHost(): Record<string, string> {
  const host = process.env.CORE_TENANT_HOST?.trim();
  return host ? { "x-forwarded-host": host } : {};
}

export function normalizeHost(raw: string | undefined): string | undefined {
  const first = raw?.split(",")[0]?.trim().toLowerCase();
  if (!first) return undefined;
  if (first.startsWith("[")) return first.slice(0, first.indexOf("]") + 1) || undefined;
  return first.replace(/:\d+$/, "").replace(/\.$/, "") || undefined;
}

export function requestHost(headers: IncomingHttpHeaders): string | undefined {
  const forwarded = headers["x-forwarded-host"];
  return normalizeHost(Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? normalizeHost(headers.host);
}

export function hostOfUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return normalizeHost(new URL(url).host);
  } catch {
    return undefined;
  }
}

export function routeForHost<T>(routes: readonly HostRoute<T>[], host: string | undefined): T | undefined {
  if (!host) return undefined;
  for (const route of routes) if (route.hosts.some((h) => normalizeHost(h) === host)) return route.target;
  for (const route of routes) {
    const apps = normalizeHost(route.appsDomain);
    if (apps && (host === apps || host.endsWith(`.${apps}`))) return route.target;
  }
  return undefined;
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

export function createHostFront(
  routes: () => readonly HostRoute<HostTarget>[],
  fallback: () => HostTarget | undefined,
): Server {
  const resolve = (req: IncomingMessage): HostTarget | undefined =>
    routeForHost(routes(), requestHost(req.headers)) ?? (HEALTH_PATHS.has(pathOf(req)) ? fallback() : undefined);
  const server = createServer((req, res) => {
    const target = resolve(req);
    if (target) return target.request(req, res);
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("unknown host\n");
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = resolve(req);
    if (target) return target.upgrade(req, socket, head);
    socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
  });
  return server;
}

export function proxyTarget(port: number): HostTarget {
  return {
    request(req, res) {
      const up = request(
        { host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, upRes.rawHeaders);
          upRes.pipe(res);
        },
      );
      up.on("error", (error) => {
        console.warn(`[tenant-host] worker on port ${port} unreachable: ${errMessage(error)}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end();
      });
      res.on("close", () => up.destroy());
      req.pipe(up);
    },
    upgrade(req, socket, head) {
      const up = request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers });
      up.on("upgrade", (upRes, upSocket, upHead) => {
        const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? "Switching Protocols"}`];
        for (let i = 0; i < upRes.rawHeaders.length; i += 2)
          lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (upHead.length) socket.write(upHead);
        if (head.length) upSocket.write(head);
        upSocket.pipe(socket).pipe(upSocket);
        upSocket.on("error", () => socket.destroy());
        socket.on("error", () => upSocket.destroy());
      });
      up.on("response", (upRes) => {
        socket.end(`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ""}\r\nconnection: close\r\n\r\n`);
      });
      up.on("error", (error) => {
        console.warn(`[tenant-host] worker on port ${port} refused an upgrade: ${errMessage(error)}`);
        socket.destroy();
      });
      up.end();
    },
  };
}
