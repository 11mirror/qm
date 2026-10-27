import { isBearerSecret, isStrongSigningSecret } from "../../auth/source-auth.ts";
import { constantTimeEqual } from "../../util/crypto.ts";
import type { BackgroundOwnership } from "../../runs/background-ownership.ts";
import { isObj, refuse } from "./shared.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult } from "./route.ts";

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048;
}

function status(ctx: ApiCtx, state: BackgroundOwnership): RouteResult {
  const control = ctx.deps.backgroundOwnership!;
  return ok({
    protocol: 2,
    deploymentId: control.deploymentId,
    instanceId: control.instanceId,
    ownerDeploymentId: state.ownerDeploymentId,
    setAt: state.setAt,
    setBy: state.setBy,
    active: control.active(),
  });
}

export function requireDeploymentControl(ctx: ApiCtx): true | null {
  const control = ctx.deps.backgroundOwnership;
  const secret = ctx.deps.deploymentControlSecret;
  if (
    !control ||
    !ctx.secret ||
    !ctx.auth ||
    !isStrongSigningSecret(secret) ||
    !isBearerSecret(secret) ||
    secret === ctx.secret
  )
    throw refuse(503, { error: "background_control_unavailable" });
  const bearer = ctx.req.headers.authorization;
  if (!constantTimeEqual(typeof bearer === "string" ? bearer : "", `Bearer ${secret}`))
    throw refuse(401, { error: "unauthorized" });
  return true;
}

async function backgroundWork(ctx: ApiCtx): Promise<RouteResult> {
  if (!requireDeploymentControl(ctx)) return;
  const control = ctx.deps.backgroundOwnership!;
  if (ctx.method === "GET") return status(ctx, await control.store.get());
  const body = ctx.body;
  if (
    !isObj(body) ||
    !Object.keys(body).every((key) => ["ownerDeploymentId", "expectedOwnerDeploymentId"].includes(key)) ||
    !(body.ownerDeploymentId === null || identity(body.ownerDeploymentId)) ||
    !(
      body.expectedOwnerDeploymentId === undefined ||
      body.expectedOwnerDeploymentId === null ||
      identity(body.expectedOwnerDeploymentId)
    )
  ) {
    return reply(400, { error: "invalid_background_request" });
  }
  return status(
    ctx,
    await control.store.set({
      ownerDeploymentId: body.ownerDeploymentId,
      setBy: control.deploymentId,
      ...(body.expectedOwnerDeploymentId !== undefined
        ? { expectedOwnerDeploymentId: body.expectedOwnerDeploymentId }
        : {}),
    }),
  );
}

export const backgroundWorkRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/background-work", auth: "source", handle: backgroundWork },
  { method: "POST", path: "/v1/background-work", actor: "system", auth: "source", handle: backgroundWork },
];
