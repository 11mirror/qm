import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { type App } from "../app.ts";
import { errMessage } from "../../util/errors.ts";
import { type ApiCtx, type BaseCtx, ok, reply, type RouteResult } from "./route.ts";
import { verifyDeployGitAccess } from "../../deploy/access-token.ts";

export const deploymentId = async (app: App, idOrName: string): Promise<string | undefined> =>
  (await app.getDeployment(idOrName))?.id;

function deploymentGitParts(pathname: string): { id: string; tail: string } | null {
  const prefix = "/v1/deployments/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const marker = "/git/";
  const markerAt = rest.indexOf(marker);
  if (markerAt < 0) return null;
  const tail = rest.slice(markerAt + marker.length);
  if (!tail) return null;
  try {
    return { id: decodeURIComponent(rest.slice(0, markerAt)), tail };
  } catch {
    return null;
  }
}

export function isDeploymentGitRoute(method: string, pathname: string): boolean {
  const parts = deploymentGitParts(pathname);
  if (!parts) return false;
  return (
    (method === "GET" && parts.tail === "info/refs") ||
    (method === "POST" && (parts.tail === "git-upload-pack" || parts.tail === "git-receive-pack"))
  );
}

function gitServiceOf(tail: string, url: URL): "git-upload-pack" | "git-receive-pack" | null {
  if (tail === "git-upload-pack" || tail === "git-receive-pack") return tail;
  if (tail === "info/refs") {
    const s = url.searchParams.get("service");
    if (s === "git-upload-pack" || s === "git-receive-pack") return s;
  }
  return null;
}

function gitTokenFrom(ctx: BaseCtx): string | null {
  const authz = ctx.req.headers.authorization;
  if (typeof authz !== "string") return null;
  const basic = /^basic\s+(.+)$/i.exec(authz);
  if (basic) {
    const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    const user = colon < 0 ? decoded : decoded.slice(0, colon);
    const pass = colon < 0 ? "" : decoded.slice(colon + 1);
    return pass || user || null;
  }
  return /^bearer\s+(.+)$/i.exec(authz)?.[1] ?? null;
}

async function readRequestBytes(req: BaseCtx["req"]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function headerEnd(buf: Buffer): { headEnd: number; bodyStart: number } | null {
  const crlf = buf.indexOf("\r\n\r\n");
  if (crlf >= 0) return { headEnd: crlf, bodyStart: crlf + 4 };
  const lf = buf.indexOf("\n\n");
  if (lf >= 0) return { headEnd: lf, bodyStart: lf + 2 };
  return null;
}

async function runGitHttpBackend(input: {
  repoPath: string;
  tail: string;
  method: string;
  query: string;
  contentType?: string;
  body: Buffer;
}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const repoRoot = dirname(input.repoPath);
  const repoName = basename(input.repoPath);
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    GIT_PROJECT_ROOT: repoRoot,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${repoName}/${input.tail}`,
    REQUEST_METHOD: input.method,
    QUERY_STRING: input.query,
    CONTENT_TYPE: input.contentType ?? "",
    CONTENT_LENGTH: String(input.body.length),
    REMOTE_USER: "deployment-git",
  };
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "http.receivepack=true", "http-backend"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      const out = Buffer.concat(stdout);
      const split = headerEnd(out);
      if ((code ?? 0) !== 0 || !split) {
        reject(new Error(`git http-backend exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of out.subarray(0, split.headEnd).toString("utf8").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (name.toLowerCase() === "status") {
          status = Number(value.split(/\s+/)[0]) || 200;
        } else {
          headers[name] = value;
        }
      }
      resolve({ status, headers, body: out.subarray(split.bodyStart) });
    });
    child.stdin.end(input.body);
  });
}

export async function serveDeploymentGit(ctx: BaseCtx): Promise<RouteResult> {
  const parts = deploymentGitParts(ctx.pathname);
  if (!parts) return reply(404, { error: "not_found" });
  const forbid = (message: string): RouteResult => reply(403, { error: "forbidden", message });
  const service = gitServiceOf(parts.tail, ctx.url);
  if (!service) return forbid("unsupported deployment git service");
  const isPush = service === "git-receive-pack";
  if (isPush && !ctx.secret)
    return reply(503, { error: "unavailable", message: "deployment git push requires core signing" });
  let access: Awaited<ReturnType<typeof verifyDeployGitAccess>> = null;
  if (ctx.secret) {
    const token = gitTokenFrom(ctx);
    access = token ? await verifyDeployGitAccess(ctx.secret, token) : null;
    if (!access) {
      ctx.res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Basic realm="deployment git"',
      });
      ctx.res.end(JSON.stringify({ error: "unauthorized", message: "deployment git token required" }));
      return;
    }
    if (access.deploymentId !== parts.id) return forbid("token is for a different deployment");
    if (isPush && access.permission !== "write") return forbid("deployment git token is read-only");
    if (
      access.principalId &&
      !(await ctx.app.authorizesDeploymentGitAccess(parts.id, access.principalId, access.permission))
    )
      return forbid("deployment git access has been revoked");
    if (isPush && !access.principalId) return forbid("deployment git write access has been revoked");
  }
  const repoPath = await ctx.app.deploymentGitRepoPath(parts.id);
  if (!repoPath) return reply(404, { error: "not_found" });
  try {
    const body = ctx.method === "POST" ? await readRequestBytes(ctx.req) : Buffer.alloc(0);
    const runBackend = () =>
      runGitHttpBackend({
        repoPath,
        tail: parts.tail,
        method: ctx.method,
        query: ctx.url.searchParams.toString(),
        contentType: typeof ctx.req.headers["content-type"] === "string" ? ctx.req.headers["content-type"] : undefined,
        body,
      });
    const result = isPush
      ? await ctx.app.runDeploymentGitPush(parts.id, async () => {
          if (
            access?.principalId &&
            !(await ctx.app.authorizesDeploymentGitAccess(parts.id, access.principalId, "write"))
          ) {
            const body = Buffer.from(
              JSON.stringify({ error: "forbidden", message: "deployment git write access has been revoked" }),
            );
            return {
              result: {
                status: 403,
                headers: { "content-type": "application/json", "content-length": String(body.length) },
                body,
              },
              ok: false,
            };
          }
          const r = await runBackend();
          return { result: r, ok: r.status >= 200 && r.status < 300 };
        })
      : await runBackend();
    ctx.res.writeHead(result.status, result.headers);
    ctx.res.end(result.body);
  } catch (e) {
    console.error("[deploy-git] request failed:", errMessage(e));
    return reply(500, { error: "git_failed", message: "deployment git request failed" });
  }
}

function gitUrlBase(ctx: ApiCtx): string {
  if (ctx.deps.apiBaseUrl) return ctx.deps.apiBaseUrl;
  if (ctx.deps.publicUrl) return ctx.deps.publicUrl;
  const host = (ctx.req.headers["x-forwarded-host"] as string) ?? ctx.req.headers.host ?? "localhost";
  const proto = (ctx.req.headers["x-forwarded-proto"] as string) ?? "http";
  return `${proto}://${host}`;
}

export async function withGitUrl<T extends { id: string }>(ctx: ApiCtx, d: T, principalId: string): Promise<T> {
  if (!ctx.secret) return d;
  const git = await ctx.app.deploymentGitUrlFor(d.id, principalId, { secret: ctx.secret, baseUrl: gitUrlBase(ctx) });
  return git ? { ...d, gitUrl: git.url } : d;
}

export async function deploymentGitUrl(ctx: ApiCtx): Promise<RouteResult> {
  const { app, params, capability } = ctx;
  if (!capability) return reply(403, { error: "forbidden", message: "a git URL requires an agent capability token" });
  if (!ctx.secret) return reply(503, { error: "unavailable", message: "core signing secret not configured" });
  const result = await app.deploymentGitUrlFor(params.id!, capability.actorId, {
    secret: ctx.secret,
    baseUrl: gitUrlBase(ctx),
  });
  if (!result) return reply(403, { error: "forbidden", message: "no access to this deployment" });
  return ok(result);
}
