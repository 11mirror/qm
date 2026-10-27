import type { SurfaceContextQuery, SurfaceContextResult } from "../../types.ts";
import { BLOB_TRANSFER_AUD, mintCapabilityToken } from "../../auth/capability-token.ts";
import { CAPABILITY_HEADER } from "../contract.ts";
import { HttpError } from "../http.ts";
import { isObj, refuse } from "./shared.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult } from "./route.ts";
import { awaitContextOutcome } from "../surface-context-puller.ts";
import { parseDeliveryTarget } from "../../slack/delivery.ts";
import { parseFileRef } from "../../surfaces/refs.ts";

const SURFACE_CONTEXT_MAX_MESSAGES = 200;
const SURFACE_CONTEXT_DEFAULT_MESSAGES = 100;
const FULFILL_WAIT_MS = 25_000;
const FULFILL_POLL_MS = 1_000;
const PENDING_WAIT_CAP_MS = 20_000;
const PENDING_POLL_MS = 1_000;
const FILE_DOWNLOAD_TTL_MS = 5 * 60_000;
const FILE_FULFILL_WAIT_MS = 120_000;

async function resolveSurfaceTarget(
  ctx: ApiCtx,
  b: Record<string, unknown>,
): Promise<{
  source: string;
  target: Pick<SurfaceContextQuery, "channelId" | "channelName" | "conversationTarget">;
} | null> {
  const { app, capability } = ctx;
  const cap = capability!;
  if (typeof b.channel === "string" && b.channel.trim()) {
    const ref = b.channel.trim().replace(/^#/, "");
    if (/^[CG][A-Z0-9]{6,}$/.test(ref)) {
      if (!(await app.channelVisibleTo(cap.actorId, ref))) throw await notVisible(ctx, cap.actorId, b.channel);
      return { source: "slack", target: { channelId: ref } };
    }
    const r = await app.resolveChannel(ref);
    if (r.kind === "none")
      throw refuse(404, { error: "channel_not_found", message: `no channel I'm in matches "${b.channel}"` });
    if (r.kind === "ambiguous")
      throw refuse(409, {
        error: "ambiguous_channel",
        message: `"${b.channel}" matches multiple channels — pass an exact name or id`,
        candidates: r.candidates.map((c) => ({ channelId: c.channelId, name: c.name })),
      });
    if (!(await app.channelVisibleTo(cap.actorId, r.channel.channelId, r.channel.isPrivate === true)))
      throw await notVisible(ctx, cap.actorId, `#${r.channel.name}`);
    return { source: "slack", target: { channelId: r.channel.channelId, channelName: r.channel.name } };
  }
  const dest = cap.destination;
  if (!dest?.target || dest.type !== "slack")
    throw refuse(400, {
      error: "no_conversation",
      message: "this conversation has no surface history to pull — name a channel instead",
    });
  return { source: dest.type, target: { conversationTarget: dest.target } };
}

async function rateLimitRecipient(ctx: ApiCtx): Promise<Pick<SurfaceContextQuery, "rateLimitRecipient">> {
  const cap = ctx.capability;
  if (!cap?.liveActor || cap.destination?.type !== "slack" || !cap.destination.target) return {};
  const member = await ctx.app.directoryMember(cap.actorId);
  return { rateLimitRecipient: { target: cap.destination.target, user: member?.slackId ?? cap.actorId } };
}

async function createSurfaceContextRequest(ctx: ApiCtx): Promise<RouteResult> {
  const { app, body, capability } = ctx;
  if (!capability)
    return reply(401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  const b = isObj(body) ? body : {};
  const count = Math.max(
    1,
    Math.min(
      SURFACE_CONTEXT_MAX_MESSAGES,
      typeof b.count === "number" ? Math.floor(b.count) : SURFACE_CONTEXT_DEFAULT_MESSAGES,
    ),
  );
  const before = typeof b.before === "string" && b.before.trim() ? b.before.trim() : undefined;
  const match = typeof b.match === "string" && b.match.trim() ? b.match.trim().slice(0, 200) : undefined;

  const resolved = await resolveSurfaceTarget(ctx, b);
  if (!resolved) return;
  const query: SurfaceContextQuery = {
    ...resolved.target,
    viewer: capability.actorId,
    count,
    ...(await rateLimitRecipient(ctx)),
    ...(before ? { before } : {}),
    ...(match ? { match } : {}),
    ...(b.live === true ? { live: true } : {}),
  };
  const request = await app.createContextRequest(resolved.source, query);
  return awaitOutcome(ctx, request.id, FULFILL_WAIT_MS, (result) =>
    ok({ ...(query.channelName ? { channel: `#${query.channelName}` } : {}), ...result }),
  );
}

async function createSurfaceFileRequest(ctx: ApiCtx): Promise<RouteResult> {
  const { app, body, capability } = ctx;
  if (!capability)
    return reply(401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  const b = isObj(body) ? body : {};
  const fileRef = typeof b.ref === "string" ? parseFileRef(b.ref) : undefined;
  if (typeof b.ref === "string" && !fileRef)
    return reply(400, { error: "bad_request", message: "`ref` is the [ref …] shown next to a file in a read" });
  const ts = fileRef?.ts ?? (typeof b.ts === "string" && b.ts.trim() ? b.ts.trim() : undefined);
  if (!ts)
    return reply(400, {
      error: "bad_request",
      message: "pass the file's `ref`, or the message's `ts` (find either via /v1/surface-context)",
    });
  const threadTs =
    fileRef?.threadTs ?? (typeof b.threadTs === "string" && b.threadTs.trim() ? b.threadTs.trim() : undefined);
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined;
  const here = capability.destination?.target ? parseDeliveryTarget(capability.destination.target).channel : undefined;
  const elsewhere = fileRef && fileRef.channel !== here && b.channel === undefined;
  const resolved = await resolveSurfaceTarget(ctx, elsewhere ? { ...b, channel: fileRef.channel } : b);
  if (!resolved) return;
  const query: SurfaceContextQuery = {
    ...resolved.target,
    count: 1,
    ...(await rateLimitRecipient(ctx)),
    file: {
      ts,
      ...(threadTs ? { threadTs } : {}),
      ...(fileRef ? { index: fileRef.index } : {}),
      ...(!fileRef && name ? { name } : {}),
    },
  };
  const request = await app.createContextRequest(resolved.source, query);
  return awaitOutcome(ctx, request.id, FILE_FULFILL_WAIT_MS, async (result) => {
    const file = result.file;
    if (!file)
      return reply(502, {
        error: "surface_error",
        message:
          "the surface can't fetch files yet (it may be mid-deploy) — tell the person plainly rather than retrying",
      });
    const token = await mintCapabilityToken(
      {
        actorId: capability.actorId,
        scopeId: capability.scopeId,
        ...(capability.scopeVersion ? { scopeVersion: capability.scopeVersion } : {}),
        ...(capability.botActor ? { botActor: true } : {}),
        ...(capability.liveActor ? { liveActor: true } : {}),
        ...(capability.members ? { members: capability.members } : {}),
        aud: BLOB_TRANSFER_AUD,
        blob: { dir: "read", id: file.blobId },
        exp: Date.now() + FILE_DOWNLOAD_TTL_MS,
      },
      (ctx.deps.capabilitySecret ?? ctx.secret)!,
    );
    const { blobId, ...meta } = file;
    return ok({
      file: meta,
      download: {
        path: `/v1/blobs/${encodeURIComponent(blobId)}`,
        header: CAPABILITY_HEADER,
        token,
        expiresInSeconds: Math.floor(FILE_DOWNLOAD_TTL_MS / 1000),
      },
      note: `run: curl -fsS -H "${CAPABILITY_HEADER}: <token>" "$AGENT_API_URL/v1/blobs/${encodeURIComponent(blobId)}" -o <path you choose — do NOT paste the posted filename into a shell unquoted>`,
    });
  });
}

async function notVisible(ctx: ApiCtx, actorId: string, label: string): Promise<HttpError> {
  const known = await ctx.app.directoryMember(actorId);
  return new HttpError(403, {
    error: known ? "not_visible" : "identity_unverified",
    message: known
      ? `I can only read a private channel you're in, and I can't confirm you're in ${label}.`
      : `I can't confirm your identity in this workspace — your login may not be linked to Slack — so I can't check whether you're in ${label}. Connecting / signing in with Slack should fix it.`,
  });
}

async function awaitOutcome(
  ctx: ApiCtx,
  requestId: string,
  waitMs: number,
  onDone: (result: SurfaceContextResult) => RouteResult | Promise<RouteResult>,
): Promise<RouteResult> {
  const { app } = ctx;
  const outcome = await awaitContextOutcome(app, requestId, { waitMs, pollMs: FULFILL_POLL_MS });
  if (outcome.status === "done") return onDone(outcome.result);
  if (outcome.status === "failed")
    return reply(502, { error: "surface_error", message: outcome.error ?? "the surface couldn't answer that" });
  return reply(504, { error: "surface_timeout", message: "the surface didn't answer in time — try again" });
}

async function listPendingContextRequests(ctx: ApiCtx): Promise<RouteResult> {
  const { app, url } = ctx;
  const source = url.searchParams.get("source") ?? "slack";
  const waitMs = Math.max(0, Math.min(PENDING_WAIT_CAP_MS, Number(url.searchParams.get("waitMs")) || 0));
  const deadline = Date.now() + waitMs;
  let requests = await app.pendingContextRequests(source);
  while (!requests.length && Date.now() < deadline) {
    await app.awaitContextRequestEvent("created", null, Math.min(PENDING_POLL_MS, deadline - Date.now()));
    requests = await app.pendingContextRequests(source);
  }
  return ok({ requests: requests.map((r) => ({ id: r.id, query: r.query })) });
}

async function fulfillContextRequest(ctx: ApiCtx): Promise<RouteResult> {
  const { app, body } = ctx;
  const id = ctx.params.id!;
  const b = isObj(body) ? body : {};
  const f = isObj(b.file) ? b.file : undefined;
  const file =
    f && typeof f.blobId === "string" && typeof f.name === "string" && typeof f.sizeBytes === "number"
      ? {
          blobId: f.blobId,
          name: f.name,
          sizeBytes: f.sizeBytes,
          ...(typeof f.mimetype === "string" ? { mimetype: f.mimetype } : {}),
          ...(typeof f.author === "string" ? { author: f.author } : {}),
        }
      : undefined;
  const g = isObj(b.group) ? b.group : undefined;
  const group = g && typeof g.groupId === "string" && g.groupId ? { groupId: g.groupId } : undefined;
  const outcome =
    typeof b.error === "string"
      ? { error: b.error }
      : {
          result: {
            messages: Array.isArray(b.messages) ? b.messages : [],
            ...(typeof b.hasMore === "boolean" ? { hasMore: b.hasMore } : {}),
            ...(typeof b.nextBefore === "string" ? { nextBefore: b.nextBefore } : {}),
            ...(typeof b.note === "string" ? { note: b.note } : {}),
            ...(Array.isArray(b.selfTs) ? { selfTs: b.selfTs.filter((ts) => typeof ts === "string") } : {}),
            ...(b.liveSearch === "unconfigured" || b.liveSearch === "unconnected" ? { liveSearch: b.liveSearch } : {}),
            ...(file ? { file } : {}),
            ...(group ? { group } : {}),
          } satisfies SurfaceContextResult,
        };
  const fulfilled = await app.fulfillContextRequest(id, outcome);
  return reply(
    fulfilled ? 200 : 404,
    fulfilled ? { ok: true } : { error: "not_found", message: "request expired or already answered" },
  );
}

export const contextRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/surface-context",
    actor: "system",
    auth: "either",

    handle: createSurfaceContextRequest,
  },
  { method: "POST", path: "/v1/surface-file", actor: "system", auth: "either", handle: createSurfaceFileRequest },
  { method: "GET", path: "/v1/surface-context/pending", auth: "source", handle: listPendingContextRequests },
  {
    method: "POST",
    path: "/v1/surface-context/:id/result",
    actor: "system",
    auth: "source",
    handle: fulfillContextRequest,
  },
];
