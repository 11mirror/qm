import { randomUUID } from "node:crypto";
import { isObj } from "./shared.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult } from "./route.ts";
import { collectNamedOutbound, parseOutboundFiles, type ArtifactRegistration } from "../../core/attachments.ts";
import type { SandboxHandle } from "../../sandbox/sandbox.ts";
import {
  accessConversationSandbox,
  SandboxAccessError,
  type SandboxResource,
} from "../../sandbox/sandbox-resources.ts";
import { resolveEnvironmentId } from "../../environments/environment-store.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { scopeId, type OutgoingAttachment } from "../../types.ts";
import { fail, HttpError } from "../http.ts";

function messageTs(v: unknown): string | undefined {
  return isObj(v) && typeof v.ts === "string" && v.ts.trim() ? v.ts : undefined;
}

function reachRefusal(failure: { status: number; error: string; message: string; candidates?: unknown }): HttpError {
  return new HttpError(failure.status, {
    error: failure.error,
    message: failure.message,
    ...(failure.candidates ? { candidates: failure.candidates } : {}),
  });
}

async function reachAttachments(
  { app, deps }: ApiCtx,
  capability: NonNullable<ApiCtx["capability"]>,
  b: Record<string, unknown>,
  target: Parameters<ApiCtx["app"]["resolveReachTarget"]>[0],
  files: Extract<ReturnType<typeof parseOutboundFiles>, { ok: true }>["files"],
  requestedSandboxId: string | undefined,
): Promise<OutgoingAttachment[]> {
  const { sandbox, blobTransfer } = deps;
  const needsSandbox = files.some((f) => typeof f === "string");
  if (!blobTransfer || (needsSandbox && !sandbox) || (requestedSandboxId && !deps.sandboxResources))
    throw fail(
      501,
      "not_configured",
      "file attachments aren't available on this server — the sandbox/blob store isn't wired",
    );
  const pre = await app.resolveReachTarget(target, capability.actorId);
  if (!pre.ok && !(pre.error === "group_not_found" && Array.isArray(b.participants))) throw reachRefusal(pre);
  const envScope = await resolveEnvironmentId(deps.environments, capability.scopeId);
  const register: ArtifactRegistration | undefined = deps.files
    ? {
        store: deps.files,
        ownerScopeId: scopeId("personal", capability.actorId),
        createdBy: capability.actorId,
        createdInScope: capability.scopeId,
        seed: `reach:${randomUUID()}`,
        onError: (e) =>
          deps.errors?.record(
            {
              category: "file_store",
              code: "register_failed",
              message: errMessage(e),
              scopeLabel: capability.scopeId,
            },
            e,
          ),
      }
    : undefined;
  let resource: SandboxResource | undefined;
  if (requestedSandboxId) {
    try {
      resource = await accessConversationSandbox(
        deps.sandboxResources,
        capability.actorId,
        requestedSandboxId,
        (scope) => scope === capability.scopeId || scope === envScope,
      );
    } catch (e) {
      if (!(e instanceof SandboxAccessError)) throw e;
      throw fail(403, "forbidden", "sandbox_id isn't a computer this conversation can read files from");
    }
  }
  let provisioned: Promise<SandboxHandle> | undefined;
  const handle = () =>
    (provisioned ??= resource
      ? sandbox!.provision([{ scopeId: resource.ownerScopeId, mountPath: "", mode: "rw" }], {
          sandboxId: resource.id,
        })
      : sandbox!.provision([{ scopeId: envScope, mountPath: "", mode: "rw" }]));
  try {
    const r = await collectNamedOutbound(sandbox, handle, files, blobTransfer, register, [], (id) =>
      app.openFileForViewer(id, capability.actorId),
    );
    const bad = [
      ...r.missing.map((p) => `${p} (not found)`),
      ...r.empty.map((p) => `${p} (empty)`),
      ...r.oversized.map((p) => `${p} (too large)`),
    ];
    if (bad.length)
      throw fail(
        400,
        "attach_failed",
        `couldn't attach: ${bad.join(", ")} — nothing was sent; fix the file(s) and retry`,
      );
    return r.attachments;
  } finally {
    if (provisioned) {
      const used = await provisioned.catch(() => undefined);
      if (used)
        await sandbox!.teardown(used, { keepWarm: true }).catch(swallowAs("reach: sandbox teardown", undefined));
    }
  }
}

async function reachNow(ctx: ApiCtx): Promise<RouteResult> {
  const { app, deps, body, capability } = ctx;
  if (!capability) return reply(403, { error: "forbidden", message: "reach requires an agent capability token" });
  const rate = await deps.rateLimiter?.check(`reach:${capability.actorId}`);
  if (rate && !rate.allowed)
    return reply(429, { error: "rate_limited", message: "too many outbound actions; try again later" });
  const b = isObj(body) ? body : {};
  let text: string | undefined;
  if (typeof b.text === "string") text = b.text;
  else if (typeof b.message === "string") text = b.message;
  const reactTs = messageTs(b.react);
  const emoji = isObj(b.react) ? b.react.emoji : undefined;
  const react = reactTs && typeof emoji === "string" && emoji.trim() ? { messageTs: reactTs, emoji } : undefined;
  const deleteTs = messageTs(b.delete);
  const del = deleteTs ? { messageTs: deleteTs } : undefined;
  let threadTs: string | undefined;
  if (b.threadTs !== undefined) {
    if (typeof b.threadTs !== "string" || !/^\d+\.\d+$/.test(b.threadTs.trim()))
      return reply(400, {
        error: "bad_request",
        message:
          'threadTs must be the parent message\'s ts string, e.g. "1723497600.123456" — find it via /v1/surface-context',
      });
    threadTs = b.threadTs.trim();
    if (react || del)
      return reply(400, {
        error: "bad_request",
        message: "threadTs threads a text post — react/delete already name their target message ts",
      });
  }
  const target = {
    ...(typeof b.recipient === "string" ? { recipient: b.recipient } : {}),
    ...(typeof b.channel === "string" ? { channel: b.channel } : {}),
    ...(Array.isArray(b.participants)
      ? { participants: b.participants.filter((p): p is string => typeof p === "string") }
      : {}),
  };
  const hasNamedTarget = Object.keys(target).length > 0;
  if (react && del)
    return reply(400, {
      error: "bad_request",
      message: "react and delete are separate actions — send one at a time",
    });
  const filesParsed = parseOutboundFiles(b.files);
  if (!filesParsed.ok) return reply(400, { error: "bad_request", message: filesParsed.message });
  const files = filesParsed.files;
  let requestedSandboxId: string | undefined;
  if (b.sandbox_id !== undefined) {
    if (typeof b.sandbox_id !== "string" || !b.sandbox_id.trim())
      return reply(400, { error: "bad_request", message: "sandbox_id must be a sandbox id string" });
    if (files.some((f) => typeof f === "string")) requestedSandboxId = b.sandbox_id.trim();
  }
  if (files.length && (react || del))
    return reply(400, {
      error: "bad_request",
      message: "files compose into a text post — a react/delete carries no attachments",
    });
  if (!react && !del && (text === undefined || text.trim() === ""))
    return reply(400, {
      error: "bad_request",
      message: "text (the exact message to send), react ({ ts, emoji }), or delete ({ ts }) required",
    });
  if ((react || del) && typeof b.recipient === "string")
    return reply(400, {
      error: "bad_request",
      message:
        "react/delete targets a message in a channel, group DM, or this conversation — name a channel or participants, not a recipient",
    });
  if (!del && !hasNamedTarget)
    return reply(400, {
      error: "bad_request",
      message: react
        ? "react targets a message in a channel or group DM — name a channel or participants"
        : "name a recipient (a teammate), a channel, or a group DM's participants",
    });
  const attachments = files.length
    ? await reachAttachments(ctx, capability, b, target, files, requestedSandboxId)
    : undefined;
  const result = await app.reachNow({
    senderId: capability.actorId,
    senderScope: capability.scopeId,
    ...(text !== undefined ? { text } : {}),
    ...(threadTs !== undefined ? { threadTs } : {}),
    ...(react ? { react } : {}),
    ...(del ? { delete: del } : {}),
    ...target,
    ...(attachments?.length ? { attachments } : {}),
    ...(typeof b.unfurlLinks === "boolean" ? { unfurlLinks: b.unfurlLinks } : {}),
    ...(capability.destination ? { currentDestination: capability.destination } : {}),
  });
  if (!result.ok) throw reachRefusal(result);
  return ok({
    ok: true,
    ...(result.recipient ? { recipient: result.recipient } : {}),
    ...(result.channel ? { channel: result.channel } : {}),
    ...(result.group ? { group: result.group } : {}),
  });
}

export const reachRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/reach", auth: "either", handle: reachNow },
];
