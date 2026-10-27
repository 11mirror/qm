import type { Webhook } from "../../types.ts";
import { WEBHOOK_SCHEMES } from "../../webhooks/verifiers.ts";
import type { CreateWebhookInput } from "../../webhooks/webhook-store.ts";
import { canAdministerWebhook, editWebhookTask } from "../control-service.ts";
import { fail, readRawBody, refusal } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type BaseCtx, ok, reply, type Route, type RouteResult } from "./route.ts";

function isCreateWebhook(b: unknown): b is CreateWebhookInput {
  if (!isObj(b)) return false;
  const v = b.verification;
  return (
    typeof b.ownerScopeId === "string" &&
    typeof b.owner === "string" &&
    typeof b.createdBy === "string" &&
    typeof b.action === "string" &&
    isObj(v) &&
    typeof v.scheme === "string" &&
    (WEBHOOK_SCHEMES as readonly string[]).includes(v.scheme) &&
    typeof v.secret === "string" &&
    v.secret.length > 0 &&
    (b.filters === undefined || isWebhookFilters(b.filters)) &&
    (b.destination === undefined || isObj(b.destination))
  );
}

function isWebhookFilters(value: unknown): value is Webhook["filters"] {
  return (
    Array.isArray(value) &&
    value.every(
      (filter) =>
        isObj(filter) &&
        typeof filter.path === "string" &&
        filter.path.trim().length > 0 &&
        Array.isArray(filter.in) &&
        filter.in.length > 0 &&
        filter.in.every((candidate) => typeof candidate === "string" && candidate.trim().length > 0),
    )
  );
}

export function redactWebhook(w: Webhook): Webhook {
  if (!w.verification.secret) return w;
  return { ...w, verification: { ...w.verification, secret: "***" } };
}

async function incomingWebhook(ctx: BaseCtx): Promise<RouteResult> {
  const { req, res, deps, params } = ctx;
  if (!deps.webhookReceiver) {
    req.resume();
    return reply(404, { error: "not_found" });
  }
  const out = await deps.webhookReceiver.deliver(params.id!, { headers: req.headers, rawBody: await readRawBody(req) });
  if (out.status === 200) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(out.body);
    return;
  }
  if (out.status === 202) return reply(202, { ok: true });
  if (out.status === 401) return reply(401, { error: "unauthorized", message: "signature verification failed" });
  return reply(404, { error: "not_found" });
}

async function createWebhook(ctx: ApiCtx): Promise<RouteResult> {
  const { app, deps, body } = ctx;
  const v = isObj(body) ? body.verification : undefined;
  if (isObj(body) && (!isObj(v) || typeof v.scheme !== "string"))
    return reply(400, { error: "unsupported_verification", message: "verification requires a scheme" });
  if (isObj(body) && body.filters !== undefined && !isWebhookFilters(body.filters))
    return reply(400, {
      error: "invalid_filters",
      message: "every filter requires a path and at least one value",
    });
  if (!isCreateWebhook(body)) return reply(400, { error: "bad_request", message: "expected a CreateWebhookInput" });
  try {
    const webhook = await app.createWebhook(body);
    return ok({ webhook, url: inboundUrl(deps.publicUrl, webhook.id) });
  } catch (e) {
    throw refusal(400, "webhook_create_failed", e);
  }
}

const WEBHOOK_ERROR_STATUS: Record<string, number> = { bad_request: 400, forbidden: 403, not_found: 404 };

function inboundUrl(publicBase: string | undefined, id: string): string {
  const incomingPath = `/v1/webhooks/incoming/${id}`;
  return publicBase ? `${publicBase.replace(/\/$/, "")}${incomingPath}` : incomingPath;
}

async function listWebhooks(ctx: ApiCtx): Promise<RouteResult> {
  const { app, deps, actor, url } = ctx;
  const all = await app.listWebhooks();
  const viewer = actor?.p ?? url.searchParams.get("viewer");
  const isViewer = viewer ? await app.personMatcher(viewer) : undefined;
  const allowed = viewer
    ? await Promise.all(all.map((webhook) => canAdministerWebhook(app, webhook, viewer, isViewer)))
    : all.map(() => true);
  const visible = all.filter((_webhook, index) => allowed[index]);
  return ok({
    webhooks: visible.map((webhook) => ({ ...redactWebhook(webhook), url: inboundUrl(deps.publicUrl, webhook.id) })),
  });
}

async function listWebhookEvents(ctx: ApiCtx): Promise<RouteResult> {
  const { app, params, actor, url } = ctx;
  const webhook = await app.getWebhook(params.id!);
  const viewer = actor?.p ?? url.searchParams.get("viewer");
  if (!viewer || !webhook || !(await canAdministerWebhook(app, webhook, viewer)))
    return reply(404, { error: "not_found" });
  return ok({ events: await app.listWebhookEvents(webhook.id, viewer) });
}

const setWebhookEnabled =
  (enabled: boolean) =>
  async (ctx: ApiCtx): Promise<RouteResult> => {
    const { app, params, actor, url } = ctx;
    const id = params.id!;
    const webhook = await app.getWebhook(id);
    if (!webhook) throw fail(404, "not_found");
    const principalId = actor?.p ?? url.searchParams.get("principalId");
    if (principalId && !(await canAdministerWebhook(app, webhook, principalId))) {
      const portalCaller = Boolean(actor);
      return reply(portalCaller ? 403 : 404, {
        error: portalCaller ? "forbidden" : "not_found",
        ...(portalCaller ? { message: "not your webhook" } : {}),
      });
    }
    await app.setWebhookEnabled(id, enabled);
    return ok({ ok: true });
  };

async function updateWebhook(ctx: ApiCtx): Promise<RouteResult> {
  const { app, deps, params, actor, url, body } = ctx;
  const action = isObj(body) && typeof body.action === "string" ? body.action : "";
  const principalId = actor?.p ?? url.searchParams.get("principalId");
  if (!principalId) return reply(404, { error: "not_found" });
  const r = await editWebhookTask(app, params.id!, action, principalId);
  if (!r.ok) return reply(WEBHOOK_ERROR_STATUS[r.code] ?? 400, { error: r.code, message: r.message });
  return ok({ webhook: redactWebhook(r.webhook), url: inboundUrl(deps.publicUrl, r.webhook.id) });
}

export const webhookRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/webhooks/incoming/:id", auth: "public", handle: incomingWebhook },
];

export const webhookRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/webhooks", actor: "body.createdBy", auth: "source", handle: createWebhook },
  { method: "GET", path: "/v1/webhooks", actor: "query.viewer", auth: "source", handle: listWebhooks },
  { method: "GET", path: "/v1/webhooks/:id/events", actor: "query.viewer", auth: "source", handle: listWebhookEvents },
  {
    method: "POST",
    path: "/v1/webhooks/:id/update",
    actor: "query.principalId",
    auth: "source",
    handle: updateWebhook,
  },
  {
    method: "POST",
    path: "/v1/webhooks/:id/disable",
    actor: "query.principalId",
    auth: "source",
    handle: setWebhookEnabled(false),
  },
  {
    method: "POST",
    path: "/v1/webhooks/:id/enable",
    actor: "query.principalId",
    auth: "source",
    handle: setWebhookEnabled(true),
  },
];
