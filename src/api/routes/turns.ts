import { renderSurfaceBriefing } from "../../core/orchestrator/prompt-blocks.ts";
import { fromJSONSchema, z, ZodObject } from "zod";
import type { ClientToolDeclaration, TurnRequest } from "../../types.ts";
import { samePerson } from "../../directory/person.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult } from "./route.ts";
import { zodMessage } from "./shared.ts";

const TURN_ORIGIN_KINDS = new Set<unknown>(["human", "ambient", "automation", "direct"]);

function isTurnRequest(body: unknown): body is TurnRequest {
  return (
    isObj(body) &&
    typeof body.text === "string" &&
    isObj(body.actor) &&
    typeof body.actor.externalId === "string" &&
    body.actor.externalId !== "" &&
    isObj(body.conversation)
  );
}

const MAX_CLIENT_TOOL_SCHEMA_CHARS = 16_000;

function convertsToObjectSchema(schema: Record<string, unknown>): boolean {
  try {
    return fromJSONSchema(schema as Parameters<typeof fromJSONSchema>[0]) instanceof ZodObject;
  } catch {
    return false;
  }
}

const clientToolInputSchema = z
  .looseObject({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  })
  .refine((schema) => JSON.stringify(schema).length <= MAX_CLIENT_TOOL_SCHEMA_CHARS, {
    message: `must be at most ${MAX_CLIENT_TOOL_SCHEMA_CHARS} characters of JSON`,
    abort: true,
  })
  .refine(convertsToObjectSchema, { message: "must convert to a plain object schema" });

const clientToolsSchema = z
  .array(
    z.object({
      name: z.string().regex(/^ui__[a-z0-9_]{1,60}$/),
      description: z
        .string()
        .max(2_000)
        .refine((description) => description.trim() !== "", { message: "must not be blank" }),
      inputSchema: clientToolInputSchema,
      timeoutMs: z.int().min(1_000).max(60_000).optional(),
    }),
  )
  .max(32)
  .refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length, {
    message: "names must be unique",
  });

const surfaceBriefingSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/),
  state: z.string().max(20_000).optional(),
  instructions: z.string().max(8_000).optional(),
});

const clientResultSchema = z.object({
  callId: z.string().min(1).max(256),
  result: z.object({
    content: z.string(),
    structured: z.unknown().optional(),
    isError: z.boolean().optional(),
    images: z
      .array(
        z.object({
          data: z.string().max(4_000_000).base64(),
          mimeType: z.enum(["image/png", "image/jpeg"]),
        }),
      )
      .max(4)
      .optional(),
  }),
});

function sanitizedTurnRequest(body: TurnRequest): { request: TurnRequest } | { error: string } {
  const {
    source: _source,
    slackSource: _slackSource,
    externalSlack: _externalSlack,
    spawned: _spawned,
    unattendedGrants: _unattendedGrants,
    redeliveryKey: _redeliveryKey,
    clientTools: rawClientTools,
    surfaceBriefing: rawSurfaceBriefing,
    ...rest
  } = body;
  if (typeof rest.idempotencyKey === "string" && rest.idempotencyKey.startsWith("slack:"))
    return { error: "idempotencyKey must not use the reserved slack: prefix" };
  if (!isObj(rest.origin) || !TURN_ORIGIN_KINDS.has(rest.origin.kind))
    return { error: "origin.kind must be human, ambient, automation or direct" };
  let origin = rest.origin;
  if (origin.kind === "automation") {
    const { useOwnerKeychain: _internalOnly, ...safe } = origin;
    origin = safe;
  }
  if (rest.desktopClientId !== undefined && !z.uuid().safeParse(rest.desktopClientId).success)
    return { error: "desktopClientId must be a UUID" };
  let clientTools: ClientToolDeclaration[] | undefined;
  if (rawClientTools !== undefined) {
    const parsed = clientToolsSchema.safeParse(rawClientTools);
    if (!parsed.success) return { error: zodMessage("clientTools", parsed.error) };
    clientTools = parsed.data;
  }
  let conversationHeader = rest.conversationHeader;
  if (rawSurfaceBriefing !== undefined) {
    const parsed = surfaceBriefingSchema.safeParse(rawSurfaceBriefing);
    if (!parsed.success) return { error: zodMessage("surfaceBriefing", parsed.error) };
    conversationHeader = [conversationHeader, renderSurfaceBriefing(parsed.data)].filter(Boolean).join("\n\n");
  }
  return {
    request: {
      ...rest,
      origin,
      ...(conversationHeader ? { conversationHeader } : {}),
      ...(clientTools?.length ? { clientTools } : {}),
    },
  };
}

function sendRunOutcome(succeeded: boolean, outcome: { reason?: string }): RouteResult {
  if (succeeded) return ok(outcome);
  if (outcome.reason === "not_found") return reply(404, { error: "not_found" });
  return reply(409, outcome);
}

async function postTurn(ctx: ApiCtx): Promise<RouteResult> {
  const { app, url, body } = ctx;
  if (!isTurnRequest(body)) return reply(400, { error: "bad_request", message: "expected a TurnRequest" });
  const wantAsync = url.searchParams.get("async") === "1" || body.async === true;
  const sanitized = sanitizedTurnRequest(body);
  if ("error" in sanitized) return reply(400, { error: "bad_request", message: sanitized.error });
  const result = await app.turn({ ...sanitized.request, async: wantAsync });
  if (result.status === "queued") return reply(202, result);
  return reply(result.status === "refused" ? 403 : 200, result);
}

async function getApproval(ctx: ApiCtx): Promise<RouteResult> {
  const { app, actor } = ctx;
  const id = ctx.params.id!;
  if (!id || id.includes("/")) return reply(404, { error: "not_found" });
  const record = await app.getApproval(id, actor?.p);
  return record ? ok(record) : reply(404, { error: "not_found" });
}

async function getPendingApproval(ctx: ApiCtx): Promise<RouteResult> {
  const { app, url, actor } = ctx;
  const threadRef = url.searchParams.get("threadRef") ?? "";
  if (!threadRef) return reply(400, { error: "bad_request", message: "threadRef required" });
  return ok({ pending: await app.pendingApprovalForThread(threadRef, actor?.p) });
}

async function postRunDeliveryState(ctx: ApiCtx): Promise<RouteResult> {
  const { app, body } = ctx;
  const id = ctx.params.id!;
  const editRef = isObj(body) && typeof body.editRef === "string" ? body.editRef : "";
  if (!id || !editRef) return reply(400, { error: "bad_request", message: "editRef required" });
  const found = await app.setRunDeliveryState(id, { editRef });
  if (!found) return reply(404, { error: "not_found" });
  return ok({ ok: true });
}

async function postRunSignal(ctx: ApiCtx): Promise<RouteResult> {
  const { app, actor } = ctx;
  const id = ctx.params.id!;
  const body = isObj(ctx.body) ? ctx.body : {};
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (kind !== "abort" && kind !== "steer" && kind !== "client_result")
    return reply(400, { error: "bad_request", message: "kind must be abort, steer or client_result" });
  if (kind === "client_result") {
    const run = await ctx.deps.runs?.get(id);
    if (run?.request.desktopClientId && body.desktopClientId !== run.request.desktopClientId)
      return reply(403, { error: "wrong_desktop_client" });
    const parsed = clientResultSchema.safeParse(body);
    if (!parsed.success)
      return reply(400, { error: "bad_request", message: zodMessage("client_result", parsed.error) });
    const outcome = await app.signalRun(id, { kind, ...parsed.data }, actor?.p);
    return sendRunOutcome(outcome.accepted, outcome);
  }
  const text = typeof body.text === "string" ? body.text : undefined;
  const queuedRunId = typeof body.queuedRunId === "string" ? body.queuedRunId : undefined;
  const ts = typeof body.ts === "string" && body.ts ? body.ts : undefined;
  let request: TurnRequest | undefined;
  if (body.request !== undefined) {
    if (!isTurnRequest(body.request))
      return reply(400, { error: "bad_request", message: "request must be a TurnRequest" });
    if (actor && !samePerson(body.request.actor.externalId, actor.p))
      return reply(403, { error: "forbidden", message: "portal identity does not match the requested actor" });
    const sanitized = sanitizedTurnRequest(body.request);
    if ("error" in sanitized) return reply(400, { error: "bad_request", message: sanitized.error });
    request = sanitized.request;
  }
  const outcome = await app.signalRun(
    id,
    {
      kind,
      ...(text !== undefined ? { text } : {}),
      ...(ts ? { ts } : {}),
      ...(request ? { request } : {}),
      ...(queuedRunId ? { queuedRunId } : {}),
    },
    actor?.p,
  );
  if (outcome.reason === "text_required")
    return reply(400, { error: "bad_request", message: "text required", ...outcome });
  if (outcome.reason === "conversation_mismatch")
    return reply(400, {
      error: "bad_request",
      message: "request conversation does not match the run",
      ...outcome,
    });
  return sendRunOutcome(outcome.accepted, outcome);
}

async function getRun(ctx: ApiCtx): Promise<RouteResult> {
  const { app, actor } = ctx;
  const id = ctx.params.id!;
  const run = await app.getRun(id, actor?.p);
  if (!run) return reply(404, { error: "not_found" });
  return ok(run);
}

async function getActiveRunForThread(ctx: ApiCtx): Promise<RouteResult> {
  const { app, url, actor } = ctx;
  const threadRef = url.searchParams.get("threadRef") ?? "";
  if (!threadRef) return reply(400, { error: "bad_request", message: "threadRef required" });
  const active = await app.activeRunForThread(threadRef, actor?.p);
  return ok({ runId: active?.runId ?? null, ...(active?.queued ? { queued: active.queued } : {}) });
}

async function patchQueuedRun(ctx: ApiCtx): Promise<RouteResult> {
  const { app, actor, body } = ctx;
  if (!isObj(body) || typeof body.text !== "string" || typeof body.expectedText !== "string")
    return reply(400, { error: "bad_request", message: "text and expectedText required" });
  const outcome = await app.editQueuedRun(ctx.params.id!, body.text, body.expectedText, actor?.p);
  if (outcome.reason === "empty_text") return reply(400, outcome);
  return sendRunOutcome(outcome.edited, outcome);
}

async function postRunWithdraw(ctx: ApiCtx): Promise<RouteResult> {
  const { app, actor } = ctx;
  const outcome = await app.withdrawRun(ctx.params.id!, actor?.p);
  return sendRunOutcome(outcome.withdrawn, outcome);
}

export const turnRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/turns", actor: "system", auth: "source", handle: postTurn },
  { method: "GET", path: "/v1/approvals/pending", actor: "person", auth: "source", handle: getPendingApproval },
  { method: "GET", path: "/v1/approvals/:id", actor: "person", auth: "source", handle: getApproval },
  {
    method: "POST",
    path: "/v1/runs/:id/delivery-state",
    actor: "system",
    auth: "source",
    handle: postRunDeliveryState,
  },
  { method: "POST", path: "/v1/runs/:id/signal", auth: "source", maxBodyBytes: 6_000_000, handle: postRunSignal },
  { method: "PATCH", path: "/v1/runs/:id/input", auth: "source", handle: patchQueuedRun },
  { method: "POST", path: "/v1/runs/:id/withdraw", auth: "source", handle: postRunWithdraw },
  { method: "GET", path: "/v1/runs/:id", actor: "person", auth: "source", handle: getRun },
  { method: "GET", path: "/v1/runs", actor: "person", auth: "source", handle: getActiveRunForThread },
];
