import { toolManifest } from "../../harness/tool-manifest.ts";
import { personalScope } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

async function getToolManifest(ctx: ApiCtx): Promise<void> {
  const principal = ctx.actor?.p;
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const { deps } = ctx;
  const flag = async (name: "responsive_spine" | "persistent_subagents" | "ui_canvas") =>
    (await deps.featureFlags?.enabled(name, personalScope(principal))) === true;
  const tools = toolManifest({
    controlTools: Boolean(deps.signingSecret && deps.apiBaseUrl),
    surfaceTools: false,
    surfaceName: "web",
    delegateWork: false,
    sessionTools: (await flag("responsive_spine")) || (await flag("persistent_subagents")),
    readOnly: false,
    canvasInstall: await flag("ui_canvas"),
    adminOperations: (await deps.admin?.adminStatusOf({ id: principal, type: "internal" }))?.isAdmin === true,
    connectorTools: (await deps.mcpToolService?.toolDefsFor(principal)) ?? [],
    clientTools: [],
  });
  return sendJson(ctx.res, 200, { tools });
}

export const toolManifestRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/tool-manifest", actor: "query.principalId", auth: "source", handle: getToolManifest },
];
