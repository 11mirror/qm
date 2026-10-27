import { externalAppSharingAllowed } from "../../feature-flags.ts";
import { DeployAccessError, type DeployAccessErrorCode } from "../../deploy/deploy-service.ts";
import { deploymentView, type App, type DeployInput, type RedeployInput } from "../app.ts";
import { swallow, swallowAs } from "../../util/errors.ts";
import { fail, isTextualContentType, refusal, verifySignedRoute } from "../http.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../auth/portal-identity.ts";
import { isObj } from "./shared.ts";
import { parseScopeId, type Permission } from "../../types.ts";
import { type ApiCtx, type BaseCtx, ok, reply, type Route, type RouteResult } from "./route.ts";
import { resolveShareTarget as resolveShareTargetGrammar, type ResolvedShareTarget } from "../artifact-share.ts";
import { EMBED_ANCESTORS_HINT, parseEmbedAncestors } from "../../deploy/embed-ancestors.ts";
import {
  withGitUrl,
  deploymentId,
  isDeploymentGitRoute,
  serveDeploymentGit,
  deploymentGitUrl,
} from "./deployment-git.ts";
import {
  APP_SLUG,
  proxyReach,
  normalizedDeploymentFetchPath,
  AGENT_FETCH_DEFAULT_MAX_BYTES,
  AGENT_FETCH_MAX_BYTES,
  fetchDeploymentResponse,
} from "./deployment-upstream.ts";

const isStringRecord = (v: unknown): v is Record<string, string> =>
  isObj(v) && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

function isRedeployInput(b: unknown): b is RedeployInput {
  return (
    isObj(b) &&
    typeof b.entrypoint === "string" &&
    Array.isArray(b.files) &&
    (b.homeFiles === undefined || Array.isArray(b.homeFiles)) &&
    (b.env === undefined || isStringRecord(b.env)) &&
    b.stampEnv === undefined &&
    (b.alwaysOn === undefined || typeof b.alwaysOn === "boolean")
  );
}

function isDeployInput(b: unknown): b is DeployInput {
  return isObj(b) && typeof b.ownerScopeId === "string" && typeof b.createdBy === "string" && isRedeployInput(b);
}

async function proxyDeployment(ctx: BaseCtx): Promise<RouteResult> {
  const { req, res, app, deps, secret, url, pathname, method } = ctx;
  const rest = pathname.slice("/d/".length);
  const slash = rest.indexOf("/");
  const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
  const subPath = slash === -1 ? "/" : rest.slice(slash);
  const principal = (req.headers["x-as-principal"] as string) ?? "";
  if (!(await verifySignedRoute(ctx, principal))) return;
  if (deps.requireSignedPortalIdentity || deps.production) {
    const psecret = deps.portalIdentitySecret ?? secret;
    const rawTok = req.headers[PORTAL_IDENTITY_HEADER];
    const tok = Array.isArray(rawTok) ? rawTok[0] : rawTok;
    const actor = psecret && tok ? await verifyPortalIdentity(tok, psecret, Date.now()) : null;
    if (!psecret || !actor || actor.p !== principal)
      return reply(403, { error: "forbidden", message: "portal identity required" });
    if (deps.identity) {
      await deps.identity.refresh();
      if (deps.identity.classify(actor.p).type !== "internal")
        return reply(403, { error: "forbidden", message: "principal is no longer active" });
    }
  }
  if (
    deps.deployAppsDomain &&
    deps.deployGateSecret &&
    deps.deployAppsSessionSecret &&
    method === "GET" &&
    String(req.headers["sec-fetch-dest"] ?? "") === "document"
  ) {
    const d = await app.getDeployment(id).catch(swallowAs("deployments: load deployment", null));
    const slug = d?.name ?? d?.id;
    if (d && slug && APP_SLUG.test(slug)) {
      res.writeHead(302, {
        location: `https://${slug}.${deps.deployAppsDomain}${subPath}${url.search}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
  }
  const reach = await app.reachDeployment(id, principal);
  return proxyReach(ctx, reach, subPath, principal, { sandbox: true });
}

async function createDeployment(ctx: ApiCtx): Promise<RouteResult> {
  const { app, body } = ctx;
  if (!isDeployInput(body)) return reply(400, { error: "bad_request", message: "expected a DeployInput" });
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p;
  if (principalId && body.createdBy !== principalId) return reply(403, { error: "forbidden" });
  try {
    return ok({ deployment: deploymentView(await app.deploy(body)) });
  } catch (e) {
    throw refusal(400, "deploy_failed", e);
  }
}

async function listDeployments(ctx: ApiCtx): Promise<RouteResult> {
  const { app, url, capability, actor } = ctx;
  const principalId = capability?.actorId ?? actor?.p ?? url.searchParams.get("principalId");
  if (!principalId) return ok({ deployments: (await app.listDeployments()).map(deploymentView) });
  const visible = await app.listDeploymentsForViewer(principalId);
  return ok({ deployments: await Promise.all(visible.map((d) => withGitUrl(ctx, d, principalId))) });
}

const LOGS_DEFAULT_TAIL_LINES = 200;
const LOGS_MAX_TAIL_LINES = 2000;

function boundedIntParam(ctx: ApiCtx, name: string, fallback: number, max: number): number {
  const raw = ctx.url.searchParams.get(name);
  const value = raw === null ? fallback : Number(raw);
  if (Number.isInteger(value) && value >= 1 && value <= max) return value;
  throw fail(400, "bad_request", `${name} must be an integer from 1 to ${max}`);
}

async function deploymentLogs(ctx: ApiCtx): Promise<RouteResult> {
  const { app, params, capability, actor } = ctx;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return reply(401, { error: "capability_required" });
  const tailLines = boundedIntParam(ctx, "tailLines", LOGS_DEFAULT_TAIL_LINES, LOGS_MAX_TAIL_LINES);
  const result = await app.deploymentLogsFor(params.id!, viewer, { tailLines });
  if (result.status !== "ok") return reply(404, { error: "not_found" });
  if (result.logs === null) return ok({ logs: null, message: "no logs available for this deployment" });
  return ok({ logs: result.logs });
}

async function fetchDeployment(ctx: ApiCtx): Promise<RouteResult> {
  const { app, params, capability, actor, url } = ctx;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return reply(401, { error: "capability_required" });
  const path = normalizedDeploymentFetchPath(url.searchParams.get("path"));
  if (!path) return reply(400, { error: "bad_request", message: "path must be a safe absolute path" });
  const maxBytes = boundedIntParam(ctx, "maxBytes", AGENT_FETCH_DEFAULT_MAX_BYTES, AGENT_FETCH_MAX_BYTES);
  const reach = await app.reachDeployment(params.id!, viewer);
  if (reach.status !== "ok") return reply(404, { error: "not_found" });
  try {
    const response = await fetchDeploymentResponse(reach, path, maxBytes);
    const rawContentType = response.headers["content-type"];
    const contentType = typeof rawContentType === "string" ? rawContentType : "application/octet-stream";
    const text = isTextualContentType(contentType);
    return ok({
      status: response.status,
      contentType,
      body: response.body.toString(text ? "utf8" : "base64"),
      ...(text ? {} : { encoding: "base64" }),
      truncated: response.truncated,
    });
  } catch (error) {
    swallow(`deployment fetch: ${params.id}`, error);
    return reply(502, { error: "upstream_unreachable" });
  }
}

export async function getDeployment(ctx: ApiCtx): Promise<RouteResult> {
  const { app, url, capability, params } = ctx;
  const principalId = capability ? capability.actorId : url.searchParams.get("principalId");
  const id = params.id!;
  let deployment;
  if (principalId) {
    deployment = (await app.listDeploymentsForViewer(principalId)).find((d) => d.id === id || d.name === id);
  } else {
    const stored = await app.getDeployment(id);
    deployment = stored ? deploymentView(stored) : undefined;
  }
  if (!deployment) return reply(404, { error: "not_found" });
  return ok({ deployment: principalId ? await withGitUrl(ctx, deployment, principalId) : deployment });
}

async function callerMayManageDeployment(ctx: ApiCtx, id: string): Promise<boolean> {
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p;
  return !principalId || ctx.app.canManageDeployment(id, principalId, ctx.capability?.scopeId);
}

function manageDeployment<T = undefined>(spec: {
  verb?: string;
  failure: string;
  parse?: { input: (body: unknown) => T | null | undefined; invalid: string };
  run: (ctx: ApiCtx, id: string, input: T) => Promise<unknown>;
}): (ctx: ApiCtx) => Promise<RouteResult> {
  return async (ctx) => {
    const { app, params, body } = ctx;
    const id = await deploymentId(app, params.id!);
    if (!id) throw fail(404, "not_found");
    if (!(await callerMayManageDeployment(ctx, id)))
      return reply(
        403,
        spec.verb
          ? { error: "forbidden", message: `only someone who manages this app can ${spec.verb}` }
          : { error: "forbidden" },
      );
    const input = spec.parse?.input(body);
    if (spec.parse && (input === undefined || input === null)) throw fail(400, "bad_request", spec.parse.invalid);
    try {
      return ok(await spec.run(ctx, id, input as T));
    } catch (e) {
      throw refusal(400, spec.failure, e);
    }
  };
}

const stringField = (field: string) => (body: unknown) => {
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
};

const rollbackDeployment = manageDeployment({
  failure: "rollback_failed",
  parse: {
    input: (body) => {
      const version = (body as { version?: unknown }).version;
      return typeof version === "number" ? version : undefined;
    },
    invalid: "version (number) required",
  },
  run: async ({ app }, id, version) => {
    await app.rollbackDeployment(id, version);
    return { ok: true };
  },
});

const redeployDeployment = manageDeployment({
  failure: "deploy_failed",
  parse: {
    input: (body) => (isRedeployInput(body) ? body : undefined),
    invalid:
      "entrypoint (string) and files (array) required; env must be a string map, homeFiles an array, alwaysOn a boolean",
  },
  run: async ({ app }, id, input) => ({ deployment: deploymentView(await app.redeploy(id, input)) }),
});

export const archiveDeployment = manageDeployment({
  verb: "archive it",
  failure: "archive_failed",
  run: async ({ app }, id) => {
    await app.archiveDeployment(id);
    return { ok: true };
  },
});

export const restoreDeployment = manageDeployment({
  verb: "restore it",
  failure: "restore_failed",
  run: async ({ app, capability, actor, body }, id) => {
    const principalId =
      capability?.actorId ??
      actor?.p ??
      (isObj(body) && typeof body.principalId === "string" ? body.principalId : undefined);
    return { deployment: { ...deploymentView(await app.restoreDeployment(id, principalId)), permission: "write" } };
  },
});

export const renameDeployment = manageDeployment({
  verb: "rename it",
  failure: "rename_failed",
  parse: { input: stringField("name"), invalid: "name (string) required" },
  run: async ({ app }, id, name) => ({ deployment: await app.renameDeployment(id, name) }),
});

export const setDeploymentDisplayName = manageDeployment({
  verb: "rename it",
  failure: "display_name_failed",
  parse: { input: stringField("displayName"), invalid: "displayName (string) required" },
  run: async ({ app }, id, displayName) => ({ deployment: await app.setDeploymentDisplayName(id, displayName) }),
});

const setDeploymentEmbedAncestors = manageDeployment({
  verb: "change this",
  failure: "embed_ancestors_failed",
  parse: {
    input: (body) => parseEmbedAncestors((body as { embedAncestors?: unknown }).embedAncestors),
    invalid: `embedAncestors (${EMBED_ANCESTORS_HINT}) required`,
  },
  run: async ({ app }, id, ancestors) => ({
    deployment: deploymentView(await app.setDeploymentEmbedAncestors(id, ancestors)),
  }),
});

export function resolveShareTarget(
  app: App,
  input: { scope?: string; recipient?: string; email?: string },
): Promise<ResolvedShareTarget> {
  return resolveShareTargetGrammar(app, input, {
    allowEmail: true,
    invalidScope: (scope) => `invalid scope "${scope}" — use "org" or a scope id like personal:<id> or org:<id>`,
    targetRequired: 'a target is required: pass `scope` ("org" or a scope id) or `recipient` (a teammate\'s name)',
  });
}

export async function getDeploymentShares(ctx: ApiCtx): Promise<RouteResult> {
  const { app, params, capability } = ctx;
  if (!capability) return reply(403, { error: "forbidden" });
  const deployment = await app.getDeployment(params.id!);
  if (!deployment) return reply(404, { error: "not_found" });
  if (deployment.ownerScopeId !== `personal:${capability.actorId}`)
    return reply(403, { error: "forbidden", message: "Only the owner can edit app permissions." });
  const externalSharing = await externalAppSharingAllowed(ctx.deps.featureFlags, deployment.ownerScopeId);
  return ok({
    public: deployment.public === true && externalSharing,
    externalSharing,
    grantees: await app.deploymentGrantees(deployment.id),
  });
}

export async function shareDeployment(ctx: ApiCtx): Promise<RouteResult> {
  const { app, params, body, capability } = ctx;
  if (!capability) return reply(403, { error: "forbidden", message: "sharing requires an agent capability token" });
  const b: Record<string, unknown> = isObj(body) ? body : {};
  const badRequest = (message: string): RouteResult => reply(400, { error: "bad_request", message });
  if (b.public !== undefined) {
    if (typeof b.public !== "boolean") return badRequest("public must be a boolean");
    if (b.scope !== undefined || b.recipient !== undefined || b.email !== undefined || b.access !== undefined)
      return badRequest("public access and person/scope access must be changed separately");
    try {
      const deployment = await app.setDeploymentPublic(params.id!, b.public, { createdBy: capability.actorId });
      return ok({
        ok: true,
        public: deployment.public === true,
        reach: deployment.public === true ? "anyone with the link" : "restricted",
        grantees: await app.deploymentGrantees(deployment.id),
      });
    } catch (e) {
      return sendShareFailure(e);
    }
  }
  if (b.email !== undefined && typeof b.email !== "string") return badRequest("email must be a string");
  if (b.email !== undefined && (b.scope !== undefined || b.recipient !== undefined))
    return badRequest("pass only one of email, scope, or recipient");
  const access = typeof b.access === "string" ? b.access.toLowerCase() : "view";
  if (access !== "view" && access !== "manage" && access !== "none")
    return badRequest('access must be "view", "manage", or "none"');
  const permission: Permission | null = { view: "read" as const, manage: "write" as const, none: null }[access];
  const target = await resolveShareTarget(app, {
    ...(typeof b.scope === "string" ? { scope: b.scope } : {}),
    ...(typeof b.recipient === "string" ? { recipient: b.recipient } : {}),
    ...(typeof b.email === "string" ? { email: b.email } : {}),
  });
  if (target.kind === "invalid") return badRequest(target.message);
  if (target.kind === "none")
    return reply(404, {
      error: "recipient_not_found",
      message: `no teammate matches "${String(b.recipient)}"`,
    });
  if (target.kind === "ambiguous")
    return reply(409, {
      error: "ambiguous_recipient",
      message: "more than one teammate matches",
      candidates: target.candidates,
    });
  try {
    const invite =
      typeof b.email === "string" && permission === "read"
        ? await app.inviteToDeployment(params.id!, b.email, capability.actorId)
        : undefined;
    const grantees =
      invite?.grantees ??
      (await app.shareDeployment(params.id!, target.scope, permission, { createdBy: capability.actorId }));
    const orgGrant = grantees.find((g) => parseScopeId(g.scope).kind === "org");
    let reach = "owner-only";
    if (orgGrant) reach = `everyone in ${parseScopeId(orgGrant.scope).ref}`;
    else if (grantees.length) reach = `${grantees.length} grantee${grantees.length === 1 ? "" : "s"}`;
    const deployment = await app.getDeployment(params.id!);
    return ok({
      ok: true,
      target: { scope: target.scope, label: target.label },
      access,
      reach,
      ...(invite ? { invitation: invite.invitation } : {}),
      public:
        deployment?.public === true &&
        (await externalAppSharingAllowed(ctx.deps.featureFlags, deployment.ownerScopeId)),
      grantees,
    });
  } catch (e) {
    return sendShareFailure(e);
  }
}

const DEPLOY_ACCESS_STATUS: Record<DeployAccessErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  external_sharing_disabled: 403,
  public_links_unavailable: 409,
};

function sendShareFailure(e: unknown): RouteResult {
  if (e instanceof DeployAccessError) return reply(DEPLOY_ACCESS_STATUS[e.code], { error: e.code, message: e.message });
  throw refusal(400, "share_failed", e);
}

export const deploymentRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { match: isDeploymentGitRoute, auth: "public", handle: serveDeploymentGit },
  { match: (_m, p) => p.startsWith("/d/"), auth: "source", handle: proxyDeployment },
];

export const deploymentRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/deployments", actor: "body.createdBy", auth: "source", handle: createDeployment },
  { method: "GET", path: "/v1/deployments", actor: "query.principalId", auth: "either", handle: listDeployments },
  { method: "GET", path: "/v1/deployments/:id", actor: "query.principalId", auth: "either", handle: getDeployment },
  { method: "GET", path: "/v1/deployments/:id/fetch", auth: "either", handle: fetchDeployment },
  { method: "GET", path: "/v1/deployments/:id/logs", auth: "either", handle: deploymentLogs },
  { method: "GET", path: "/v1/deployments/:id/git-url", auth: "either", handle: deploymentGitUrl },
  { method: "GET", path: "/v1/deployments/:id/share", actor: "person", auth: "either", handle: getDeploymentShares },
  { method: "POST", path: "/v1/deployments/:id/share", auth: "either", handle: shareDeployment },
  { method: "POST", path: "/v1/deployments/:id/rollback", auth: "source", handle: rollbackDeployment },
  { method: "POST", path: "/v1/deployments/:id/redeploy", auth: "source", handle: redeployDeployment },
  { method: "POST", path: "/v1/deployments/:id/archive", auth: "either", handle: archiveDeployment },
  { method: "POST", path: "/v1/deployments/:id/restore", auth: "either", handle: restoreDeployment },
  { method: "POST", path: "/v1/deployments/:id/name", auth: "either", handle: renameDeployment },
  { method: "POST", path: "/v1/deployments/:id/display-name", auth: "either", handle: setDeploymentDisplayName },
  { method: "POST", path: "/v1/deployments/:id/embed-ancestors", auth: "either", handle: setDeploymentEmbedAncestors },
];
