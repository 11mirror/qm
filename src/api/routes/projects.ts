import { sendJson } from "../http.ts";
import { isObj, refuse } from "./shared.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";

type ProjectMutation = Awaited<ReturnType<ApiCtx["app"]["addProjectMember"]>>;

const MUTATION_ERRORS: Record<string, [number, string]> = {
  invalid_name: [400, "project name required"],
  invalid_channel: [400, "channel not found among the channels you can see"],
  channel_in_use: [409, "that channel already has its own workspace — it can't also be a project's home channel"],
  invalid_member: [400, "member must be an internal directory member and cannot be the project owner"],
};

function bodyText(ctx: ApiCtx, key: string): string {
  const value = isObj(ctx.body) ? ctx.body[key] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

function capabilityPrincipal(ctx: ApiCtx, requested: string): string | null {
  if (!ctx.capability) return requested;
  if (requested && requested !== ctx.capability.actorId) return refuse(ctx.res, 404, { error: "not_found" });
  return ctx.capability.actorId;
}

async function listProjects(ctx: ApiCtx): Promise<void> {
  const principalId = capabilityPrincipal(ctx, (ctx.url.searchParams.get("principalId") ?? "").trim());
  if (principalId === null) return;
  if (!principalId) return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId required" });
  return sendJson(ctx.res, 200, { projects: await ctx.app.listProjects(principalId) });
}

async function createProject(ctx: ApiCtx): Promise<void> {
  const principalId = capabilityPrincipal(ctx, bodyText(ctx, "principalId"));
  if (principalId === null) return;
  const name = bodyText(ctx, "name");
  if (!principalId || !name)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId and name required" });
  const project = await ctx.app.createProject(principalId, name);
  return project ? sendJson(ctx.res, 201, { project }) : sendJson(ctx.res, 403, { error: "forbidden" });
}

function projectMutation(
  field: string | null,
  call: (ctx: ApiCtx, principalId: string, value: string) => Promise<ProjectMutation>,
  read: (ctx: ApiCtx) => string = (ctx) => (field ? bodyText(ctx, field) : ""),
): (ctx: ApiCtx) => Promise<void> {
  return async (ctx) => {
    const principalId = capabilityPrincipal(ctx, bodyText(ctx, "principalId"));
    if (principalId === null) return;
    const value = read(ctx);
    if (!principalId || (field && !value))
      return sendJson(ctx.res, 400, {
        error: "bad_request",
        message: field ? `principalId and ${field} required` : "principalId required",
      });
    const result = await call(ctx, principalId, value);
    if (result.status === "ok") return sendJson(ctx.res, 200, { project: result.project });
    if (result.status === "not_found") return sendJson(ctx.res, 404, { error: "not_found" });
    if (result.status === "forbidden")
      return sendJson(ctx.res, ctx.capability ? 404 : 403, { error: ctx.capability ? "not_found" : "forbidden" });
    const [status, message] = MUTATION_ERRORS[result.status]!;
    return sendJson(ctx.res, status, { error: result.status, message });
  };
}

const renameProject = projectMutation("name", (ctx, principalId, name) =>
  ctx.app.renameProject(ctx.params.id!, principalId, name),
);
const addProjectMember = projectMutation("memberId", (ctx, principalId, memberId) =>
  ctx.app.addProjectMember(ctx.params.id!, principalId, memberId),
);
const removeProjectMember = projectMutation(
  "memberId",
  (ctx, principalId, memberId) => ctx.app.removeProjectMember(ctx.params.id!, principalId, memberId),
  (ctx) => ctx.params.memberId?.trim() ?? "",
);
const setProjectSlackChannel = projectMutation("channel", (ctx, principalId, channel) =>
  ctx.app.setProjectSlackChannel(ctx.params.id!, principalId, channel),
);
const clearProjectSlackChannel = projectMutation(null, (ctx, principalId) =>
  ctx.app.setProjectSlackChannel(ctx.params.id!, principalId, null),
);

export const projectRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/projects", actor: "query.principalId", auth: "either", handle: listProjects },
  ...withActor("body.principalId", [
    { method: "PATCH", path: "/v1/projects/:id", auth: "either", handle: renameProject },
    { method: "PUT", path: "/v1/projects/:id/slack-channel", auth: "either", handle: setProjectSlackChannel },
    { method: "DELETE", path: "/v1/projects/:id/slack-channel", auth: "either", handle: clearProjectSlackChannel },
    { method: "POST", path: "/v1/projects", auth: "either", handle: createProject },
    {
      method: "POST",
      path: "/v1/projects/:id/members",
      auth: "either",

      handle: addProjectMember,
    },
    {
      method: "DELETE",
      path: "/v1/projects/:id/members/:memberId",
      auth: "either",

      handle: removeProjectMember,
    },
  ]),
];
