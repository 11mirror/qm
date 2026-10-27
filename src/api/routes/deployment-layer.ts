import { errMessage } from "../../util/errors.ts";
import {
  DeploymentLayerPersistedError,
  DeploymentLayerValidationError,
  type DeploymentLayerBundle,
  type StoredDeploymentLayer,
} from "../../deployment/deployment-layer-store.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult } from "./route.ts";

const persisted = (record: StoredDeploymentLayer) => ({
  version: record.version,
  contentHash: record.contentHash,
  durable: true,
  resolved: record.resolved,
});

function bundleFrom(body: unknown): DeploymentLayerBundle | null {
  if (!isObj(body) || body.contract !== 1 || !Array.isArray(body.tools) || !Array.isArray(body.skills)) return null;
  return body as unknown as DeploymentLayerBundle;
}

async function getDeploymentLayer(ctx: ApiCtx): Promise<RouteResult> {
  const store = ctx.deps.deploymentLayer;
  if (!store) return reply(404, { error: "not_found" });
  const record = await store.get();
  const live = store.live();
  if (!record)
    return ok({
      contract: 1,
      version: 0,
      contentHash: null,
      source: live.source,
      resolved: live.resolved,
    });
  return ok({
    contract: 1,
    version: record.version,
    contentHash: record.contentHash,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    status: (await store.isApplied(record.contentHash)) ? "applied" : "degraded",
    runtimeContentHash: live.contentHash,
    source: live.source,
    bundle: record.bundle,
    resolved: live.resolved,
  });
}

async function putDeploymentLayer(ctx: ApiCtx): Promise<RouteResult> {
  const store = ctx.deps.deploymentLayer;
  if (!store) return reply(404, { error: "not_found" });
  const bundle = bundleFrom(ctx.body);
  if (!bundle) {
    return reply(400, { error: "bad_request", message: "contract: 1, tools[], and skills[] required" });
  }
  try {
    const record = await store.put(bundle, "source-authenticated deployment CLI");
    return ok({ ok: true, ...persisted(record) });
  } catch (error) {
    if (error instanceof DeploymentLayerPersistedError)
      return reply(202, {
        ok: true,
        status: "degraded",
        message: errMessage(error),
        ...persisted(error.record),
      });
    if (error instanceof DeploymentLayerValidationError)
      return reply(400, { error: "invalid_deployment_layer", message: errMessage(error) });
    throw error;
  }
}

export const deploymentLayerRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/deployment-layer", auth: "source", handle: getDeploymentLayer },
  { method: "PUT", path: "/v1/deployment-layer", actor: "system", auth: "source", handle: putDeploymentLayer },
];
