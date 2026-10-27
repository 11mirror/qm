import { isCronRuntime } from "../../cron/runtime.ts";
import type { Cron } from "../../types.ts";
import type { CreateCronInput } from "../../cron/cron-store.ts";
import { describeRunNowRefusal } from "../../cron/scheduler.ts";
import { userScheduleFromBody } from "../../cron/schedule.ts";
import { refusal } from "../http.ts";
import { refuse } from "./shared.ts";
import { z } from "zod";
import { notifyOwnerOfCronEdit } from "../../triggers/edit-notice.ts";
import { applyCronPatch, canAdministerCron } from "../control-service.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult, withActor } from "./route.ts";

const cronRuntime = z.custom<Cron["runtime"]>(isCronRuntime, "expected { modelId, effortLevel?, fastMode? }");
const cronSchedule = z.custom<unknown>((value) => userScheduleFromBody(value) !== null, "expected a valid schedule");

const createCronBody = z
  .looseObject({
    runtime: cronRuntime.optional(),
    schedule: cronSchedule,
    action: z.string().optional(),
    message: z.string().optional(),
    unattendedGrants: z.undefined({ error: "unattended grants can only be set from a live turn" }),
    ownerScopeId: z.string(),
    owner: z.string(),
    createdBy: z.string(),
    title: z.string().optional(),
    destination: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => b.action !== undefined || b.message !== undefined, "expected action or message");

const cronPatchBody = z.object({
  runtime: cronRuntime.optional(),
  title: z.string().optional(),
  action: z.string().optional(),
  task: z.string().optional(),
  schedule: cronSchedule.optional(),
  enabled: z.boolean().optional(),
  archived: z.boolean().optional(),
  unfurlLinks: z.boolean().optional(),
  unattendedGrants: z.array(z.string()).optional(),
  session: z.boolean().optional(),
});

async function gateSourceCron(ctx: ApiCtx, id: string, read = false): Promise<Cron | null> {
  const { app } = ctx;
  const cron = await app.getCron(id);
  const principalId = ctx.caller ?? null;
  if (cron && (!principalId || (await canAdministerCron(app, cron, principalId)))) return cron;
  if (cron && read && (await app.listCronsForViewer(principalId!)).visible.some((candidate) => candidate.id === id))
    return cron;
  throw refuse(404, { error: "not_found" });
}

async function createCron(ctx: ApiCtx): Promise<RouteResult> {
  const { app, body } = ctx;
  try {
    const cron = await app.createCron(body as CreateCronInput);
    return ok({ cron });
  } catch (e) {
    throw refusal(400, "cron_create_failed", e);
  }
}

async function listCrons(ctx: ApiCtx): Promise<RouteResult> {
  const { app, url } = ctx;
  const viewer = url.searchParams.get("viewer");
  if (!viewer) return ok({ crons: await app.listCrons() });
  const { owned, visible } = await app.listCronsForViewer(viewer);
  const decorate = async (cron: Cron) => ({
    ...cron,
    permission: (await canAdministerCron(app, cron, viewer)) ? "manage" : "read",
  });
  return ok({
    crons: await Promise.all(owned.map(decorate)),
    visible: await Promise.all(visible.map(decorate)),
  });
}

async function disableCron(ctx: ApiCtx): Promise<RouteResult> {
  const { app } = ctx;
  const id = ctx.params.id!;
  if (!(await gateSourceCron(ctx, id))) return;
  await app.setCronEnabled(id, false);
  return ok({ ok: true });
}

async function runCronNow(ctx: ApiCtx): Promise<RouteResult> {
  const { deps } = ctx;
  const id = ctx.params.id!;
  const cron = await gateSourceCron(ctx, id);
  if (!cron) return;
  if (!deps.scheduler) return reply(404, { error: "not_found", message: "scheduler not wired" });
  if (cron.archived || !cron.enabled)
    return reply(400, {
      error: "bad_request",
      message: `cron ${id} is ${cron.archived ? "archived" : "paused"} — enable it before firing it on demand`,
    });
  const result = await deps.scheduler.runNow(id);
  if (!result.started) {
    const refusal = describeRunNowRefusal(id, result)!;
    return reply(refusal.error === "already_running" ? 409 : 400, refusal);
  }
  return ok({ ok: true, fireKey: result.fireKey });
}

async function cronRuns(ctx: ApiCtx): Promise<RouteResult> {
  const { url, app } = ctx;
  const id = ctx.params.id!;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  const cron = await gateSourceCron(ctx, id);
  if (!cron) return;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    return reply(400, { error: "bad_request", message: "limit must be a positive integer" });
  const { runs, total } = await app.listCronFires(id, limit !== undefined ? { limit } : {});
  return ok({ cron: cron, runs, total });
}

async function cronById(ctx: ApiCtx): Promise<RouteResult> {
  const { app, method } = ctx;
  const body = ctx.body as z.infer<typeof cronPatchBody>;
  const id = ctx.params.id!;
  if (method === "GET") {
    const cron = await gateSourceCron(ctx, id, true);
    if (!cron) return;
    return ok({ cron });
  }
  const cron = await gateSourceCron(ctx, id);
  if (!cron) return;
  if (method === "DELETE") {
    await app.deleteCron(id);
    const editor = ctx.caller;
    if (editor) await notifyOwnerOfCronEdit(app, { cron, editorId: editor, changeSummary: ["deleted"] });
    return ok({ ok: true });
  }
  if ((cron.unattendedGrants?.length ?? 0) > 0)
    return reply(403, {
      error: "forbidden",
      message: "a privileged cron may only be patched by its owner from a live turn",
    });
  if (body.unattendedGrants !== undefined)
    return reply(400, {
      error: "bad_request",
      message: "unattended grants can only be set by the cron's owner from a live turn",
    });
  const { task, action, schedule, ...rest } = body;
  const text = action ?? task;
  const result = await applyCronPatch(
    app,
    cron,
    {
      ...rest,
      ...(text !== undefined ? { action: text } : {}),
      ...(schedule !== undefined ? { schedule: userScheduleFromBody(schedule)! } : {}),
    },
    { actorId: ctx.caller ?? cron.owner },
  );
  if (result.ok) return ok({ cron: result.cron });
  if (result.code === "not_found") return ok({ cron: null });
  return reply(result.code === "forbidden" ? 403 : 400, { error: result.code, message: result.message });
}

export const cronRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/crons",
    actor: "body.createdBy",
    auth: "source",
    body: createCronBody,
    handle: createCron,
  },
  { method: "GET", path: "/v1/crons", actor: "query.viewer", auth: "source", handle: listCrons },
  ...withActor("query.principalId", [
    { method: "POST", path: "/v1/crons/:id/disable", auth: "source", handle: disableCron },
    { method: "POST", path: "/v1/crons/:id/run", auth: "source", handle: runCronNow },
    { method: "GET", path: "/v1/crons/:id/runs", auth: "source", handle: cronRuns },
    { method: "GET", path: "/v1/crons/:id", auth: "source", handle: cronById },
    { method: "PATCH", path: "/v1/crons/:id", auth: "source", body: cronPatchBody, handle: cronById },
    { method: "DELETE", path: "/v1/crons/:id", auth: "source", handle: cronById },
  ]),
];
