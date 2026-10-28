import { isSideChatAnchor } from "../../sessions/side-chat.ts";
import { SideChatAnchorError } from "../app-types.ts";
import { suggestedActivityRoutes } from "./suggested-activities.ts";
import { sessionSharingRoutes } from "./session-sharing.ts";
import type { PendingApproval, ScopeId, Session } from "../../types.ts";
import { type SessionPageStatus } from "../app-types.ts";
import { contentDispositionAttachment, contentTypeWithUtf8Charset, fail, pipeToResponse } from "../http.ts";
import { audit, isObj } from "./shared.ts";
import {
  UI_STATE_KEY_PATTERN,
  UI_STATE_MAX_BYTES,
  UI_STATE_MAX_FUTURE_SKEW_MS,
  uiStateId,
} from "../../surfaces/ui-state.ts";
import { redactWebhook } from "./webhooks.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult, withActor } from "./route.ts";
import type { ItemKind } from "../../sessions/items.ts";
import {
  sessionCapability,
  listAgentApis,
  selfMemory,
  createSkill,
  updateSkill,
  deleteSkill,
  restoreSkill,
  listSkills,
  getSkillDetail,
} from "./surface-agent.ts";
import {
  getSurfaceConfig,
  getRuntimeConfig,
  putRuntimeConfig,
  getChannelHeaderPin,
  putChannelHeaderPin,
  getInstructions,
  postInstructions,
} from "./surface-config.ts";
import {
  withBodyPrincipal,
  found,
  bodyField,
  badRequest,
  withQuery,
  WINDOW_ERROR,
  AGENT_ONLY,
} from "./surface-shared.ts";

const SYSTEM_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "ContextCompaction",
  "Error",
  "Stop",
  "Retraction",
  "Wake",
]);

const regenerateSessionTitle = withBodyPrincipal(async ({ app, params }, principalId) =>
  found(await app.regenerateTitle(params.id!, principalId)),
);

const detachSession = withBodyPrincipal(async ({ app, params }, principalId) =>
  found(await app.detachSession(params.id!, principalId)),
);

const cancelSessionGoal = withBodyPrincipal(async ({ app, params }, principalId) => {
  const out = await app.cancelSessionGoal(params.id!, principalId);
  if (!out) throw fail(404, "not_found");
  if (!out.cancelled)
    throw fail(
      409,
      out.reason,
      out.reason === "busy"
        ? "The conversation is still finishing a reply. Try again in a moment."
        : "This conversation has no active or paused goal to cancel.",
    );
  return ok(out);
});

const forkSession = withBodyPrincipal(async (ctx, principalId) => {
  const upToSeq = bodyField(ctx, "upToSeq");
  if (upToSeq !== undefined && (typeof upToSeq !== "number" || !Number.isInteger(upToSeq) || upToSeq < 0))
    throw badRequest("upToSeq must be a non-negative integer");
  const sideChat = bodyField(ctx, "sideChat");
  if (sideChat !== undefined && !isSideChatAnchor(sideChat))
    throw badRequest("sideChat needs entrySeq, quote, and occurrence");
  try {
    return found(
      await ctx.app.forkSession(ctx.params.id!, principalId, {
        upToSeq: upToSeq as number | undefined,
        ...(sideChat ? { sideChat } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof SideChatAnchorError) throw badRequest(error.message);
    throw error;
  }
});

function agentConversation(session: Session) {
  return {
    id: session.id,
    title: session.title,
    type: session.type,
    scopeId: session.scopeId,
    threadRef: session.threadRef,
    surface: session.surface,
    createdAt: session.createdAt,
    archived: session.archived === true,
    pinned: session.pinned === true,
    color: session.color ?? null,
    unread: session.unread === true,
    lastActivityAt: session.lastActivityAt ?? session.createdAt,
  };
}

function transcriptWindow(
  url: URL,
  defaultTailTurns?: number,
): { tailTurns?: number; sinceSeq?: number; beforeSeq?: number } | null {
  const windowParam = (name: "tailTurns" | "sinceSeq" | "beforeSeq", min: number): number | undefined | null => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min ? n : null;
  };
  const requestedTailTurns = windowParam("tailTurns", 1);
  const sinceSeq = windowParam("sinceSeq", 0);
  const beforeSeq = windowParam("beforeSeq", 1);
  if (requestedTailTurns === null || sinceSeq === null || beforeSeq === null) return null;
  const tailTurns = requestedTailTurns ?? (sinceSeq === undefined ? defaultTailTurns : undefined);
  if (tailTurns === undefined && sinceSeq === undefined && beforeSeq === undefined) return {};
  return {
    ...(tailTurns !== undefined ? { tailTurns } : {}),
    ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
  };
}

const getSession = withQuery("viewer", async ({ app, url, params }, viewer) => {
  const window = transcriptWindow(url);
  if (!window) throw badRequest(WINDOW_ERROR);
  return found(await app.getSessionForViewer(params.id!, viewer, Object.keys(window).length ? window : undefined));
});

async function getAgentConversation(ctx: ApiCtx): Promise<RouteResult> {
  const { app, url, capability } = ctx;
  if (!capability) return reply(401, AGENT_ONLY);
  if (url.searchParams.has("sinceSeq")) throw badRequest("agent transcript paging supports tailTurns and beforeSeq");
  const window = transcriptWindow(url, 20);
  if (!window) throw badRequest(WINDOW_ERROR);
  const view = await app.getSessionForViewer(ctx.params.id!, capability.actorId, window);
  if (!view) return reply(404, { error: "not_found", message: "not a conversation you can see" });
  return ok({
    session: agentConversation(view.session),
    items: view.items.filter((item) => !SYSTEM_KINDS.has(item.kind)),
    ...(view.earlierItems ? { earlierItems: view.earlierItems } : {}),
  });
}

const getSessionItem = withQuery("viewer", async ({ app, params }, viewer) => {
  const seq = Number(params.seq);
  if (!Number.isInteger(seq) || seq < 0) throw badRequest("seq must be a non-negative integer");
  return found(await app.getSessionItemForViewer(params.id!, viewer, seq));
});

const listSessionApprovals = withQuery("viewer", async (ctx, viewer) => {
  const id = ctx.params.id!;
  const approvals = await ctx.app.listSessionApprovals(id, viewer);
  return ok({ approvals: [...approvals, ...(await credentialApprovals(ctx, id, viewer))] });
});

async function credentialApprovals(ctx: ApiCtx, sessionId: string, viewer: string): Promise<PendingApproval[]> {
  const kc = ctx.deps.keychain;
  const approvals = ctx.deps.keychainApprovals;
  if (!kc || !approvals) return [];
  const out: PendingApproval[] = [];
  for (const ask of await kc.listAsks({ ownerId: viewer })) {
    if (ask.status !== "pending") continue;
    const view = await approvals.get(ask.id, viewer);
    if (!view || (view.sessionId !== sessionId && view.requesterSessionId !== sessionId)) continue;
    out.push({
      requestId: `keychain:${ask.id}`,
      command: view.accountLabel ? `${view.service} (${view.accountLabel})` : view.service,
      summary: `Use your ${view.service} credential in ${view.conversation}`,
      reason: "Credential approval",
      grantModes: { session: false, always: true },
      blocksInput: false,
    });
  }
  return out;
}

const getSessionBackground = withQuery("viewer", async ({ app, params }, viewer) =>
  found(await app.sessionBackground(params.id!, viewer)),
);

const getSessionBackgroundOutput = withQuery("viewer", async ({ app, url, params }, viewer) => {
  const sinceCursor = Math.max(0, Number(url.searchParams.get("sinceCursor") ?? "0") || 0);
  return found(await app.readSessionBackgroundOutput(params.id!, params.pid!, viewer, sinceCursor));
});

async function getFileContent(ctx: ApiCtx): Promise<RouteResult> {
  const { res, app, capability, actor } = ctx;
  const id = ctx.params.id!;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return reply(401, { error: "capability_required" });
  const opened = await app.openFileForViewer(id, viewer);
  if (!opened) return reply(404, { error: "not_found" });
  res.writeHead(200, {
    "content-type": contentTypeWithUtf8Charset(opened.mimetype || "application/octet-stream"),
    "content-length": String(opened.sizeBytes),
    "content-disposition": contentDispositionAttachment(opened.name, "inline"),
  });
  pipeToResponse(res, opened.stream, "file read failed");
}

async function listFiles(ctx: ApiCtx): Promise<RouteResult> {
  const { app, url, capability, actor } = ctx;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return reply(401, { error: "capability_required" });
  const limitRaw = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const scope = url.searchParams.get("scope");
  const nameQuery = url.searchParams.get("q")?.trim();
  const page = await app.listFilesForViewer(
    viewer,
    {
      ...(limitRaw ? { limit: Number(limitRaw) } : {}),
      ...(cursor ? { cursor } : {}),
      ...(nameQuery ? { nameQuery } : {}),
    },
    scope ? (scope as ScopeId) : undefined,
  );
  return ok(page);
}

async function uploadFile(ctx: ApiCtx): Promise<RouteResult> {
  const { app, deps, body } = ctx;
  if (!deps.blobTransfer) return reply(501, { error: "not_configured", message: "blob transfer store not wired" });
  const b = isObj(body) ? body : {};
  const principalId = typeof b.principalId === "string" ? b.principalId.trim() : "";
  const blobId = typeof b.blobId === "string" ? b.blobId.trim() : "";
  const name = typeof b.name === "string" ? b.name : "";
  const mimetype = typeof b.mimetype === "string" ? b.mimetype : undefined;
  const scopeId = typeof b.scopeId === "string" && b.scopeId ? (b.scopeId as ScopeId) : undefined;
  if (!principalId || !blobId || !name)
    return reply(400, { error: "bad_request", message: "principalId, blobId, and name required" });
  const opened = await deps.blobTransfer.open(blobId);
  if (!opened) return reply(404, { error: "not_found", message: "staged blob not found" });
  try {
    const file = await app.uploadFileForViewer(principalId, {
      ...(scopeId ? { scopeId } : {}),
      name,
      ...(mimetype ? { mimetype } : {}),
      data: opened.stream,
    });
    if (!file) {
      opened.stream.destroy();
      return reply(403, { error: "forbidden", message: "you can only upload to your own contexts" });
    }
    return ok({ file });
  } finally {
    await deps.blobTransfer.delete(blobId);
  }
}

type ConversationPatch = {
  title?: string | null;
  archived?: boolean;
  pinned?: boolean;
  color?: string | null;
  readAt?: number;
};

const flagField =
  (key: "archived" | "pinned") =>
  (value: unknown, patch: ConversationPatch): string | void => {
    if (typeof value !== "boolean") return `${key} must be a boolean`;
    patch[key] = value;
  };

const PATCH_FIELDS = {
  unread: (value: unknown, patch: ConversationPatch): string | void => {
    if (typeof value !== "boolean") return "unread must be a boolean";
    patch.readAt = value ? 0 : Date.now();
  },
  title: (value: unknown, patch: ConversationPatch): string | void => {
    if (value !== null && typeof value !== "string") return "title must be a string or null";
    patch.title = (typeof value === "string" ? value.trim().slice(0, 200) : null) || null;
  },
  archived: flagField("archived"),
  pinned: flagField("pinned"),
  color: (value: unknown, patch: ConversationPatch): string | void => {
    if (value !== null && !(typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)))
      return "color must be '#rrggbb' or null";
    patch.color = typeof value === "string" ? value.toLowerCase() : null;
  },
};

function conversationPatch(
  body: unknown,
  fields: (keyof typeof PATCH_FIELDS)[],
  required: string,
): ConversationPatch | string {
  const b = isObj(body) ? body : {};
  const patch: ConversationPatch = {};
  for (const field of fields) {
    const error = field in b ? PATCH_FIELDS[field](b[field], patch) : undefined;
    if (error) return error;
  }
  return Object.keys(patch).length ? patch : required;
}

const patchSession = withBodyPrincipal(async ({ app, body, params }, principalId) => {
  const patch = conversationPatch(
    body,
    ["unread", "title", "archived", "pinned", "color"],
    "title, archived, pinned, color, or unread required",
  );
  if (typeof patch === "string") throw badRequest(patch);
  const session = await app.updateSession(params.id!, principalId, patch);
  if (!session) throw fail(404, "not_found");
  return ok({ session });
});

async function listAgentConversations(ctx: ApiCtx): Promise<RouteResult> {
  const { app, capability } = ctx;
  if (!capability) return reply(401, AGENT_ONLY);
  const sessions = await app.listSessions(capability.actorId);
  return ok({ conversations: sessions.map(agentConversation) });
}

async function patchAgentConversation(ctx: ApiCtx): Promise<RouteResult> {
  const { app, capability, body } = ctx;
  if (!capability) return reply(401, AGENT_ONLY);
  const patch = conversationPatch(
    body,
    ["archived", "pinned", "title", "color"],
    "archived, pinned, title, or color required",
  );
  if (typeof patch === "string") throw badRequest(patch);
  const session = await app.updateSession(ctx.params.id!, capability.actorId, patch);
  if (!session) return reply(404, { error: "not_found", message: "not a conversation you can see" });
  audit(ctx.deps, {
    principalId: capability.actorId,
    action: "conversation.update",
    resource: session.id,
    scopeLabel: session.scopeId,
    detail: JSON.stringify(patch),
  });
  return ok({
    conversation: {
      ...agentConversation(session),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
    },
  });
}

const DEFAULT_SESSION_PAGE = 50;

const listSessions = withQuery("principalId", async ({ app, url }, principalId) => {
  const n = Number(url.searchParams.get("limit") ?? DEFAULT_SESSION_PAGE);
  const before = parseSessionCursor(url.searchParams.get("before"));
  const status = url.searchParams.get("status") ?? "active";
  if (!Number.isInteger(n) || n < 1 || before === null || !isSessionPageStatus(status))
    throw badRequest("limit must be a positive integer, before a cursor, status active, archived or waiting");
  const page = await app.listSessionPage(principalId, {
    limit: n,
    ...(before ? { before } : {}),
    status,
    ...(url.searchParams.get("surface") ? { surface: url.searchParams.get("surface")! } : {}),
    ...(url.searchParams.get("scope") ? { scopeId: url.searchParams.get("scope")! } : {}),
    ...(url.searchParams.get("q")?.trim() ? { titleQuery: url.searchParams.get("q")!.trim() } : {}),
  });
  return ok({
    sessions: page.sessions,
    ...(page.pinned ? { pinned: page.pinned } : {}),
    ...(page.hasArchived !== undefined ? { hasArchived: page.hasArchived } : {}),
    nextCursor: page.next ? `${page.next.activity}.${page.next.id}` : null,
  });
});

function isSessionPageStatus(value: string): value is SessionPageStatus {
  return value === "active" || value === "archived" || value === "waiting";
}

function parseSessionCursor(raw: string | null): { activity: number; id: string } | undefined | null {
  if (raw === null || raw === "") return undefined;
  const dot = raw.indexOf(".");
  const activity = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  return dot > 0 && Number.isSafeInteger(activity) && id ? { activity, id } : null;
}

const listSideChats = withQuery("principalId", async ({ app, params }, principalId) => {
  const sessions = await app.sideChats(principalId, params.id!);
  return found(sessions && { sessions });
});
const expandSideChat = withBodyPrincipal(async ({ app, params }, principalId) => {
  const session = await app.expandSideChat(principalId, params.id!);
  return found(session && { session });
});
const listSessionChildren = withQuery("principalId", async ({ app, params }, principalId) => {
  const children = await app.sessionChildren(principalId, params.id!);
  return found(children && { sessions: children });
});

async function getSessionRow(ctx: ApiCtx): Promise<RouteResult> {
  const { app, url } = ctx;
  const principalId = url.searchParams.get("principalId");
  const id = url.searchParams.get("id") ?? undefined;
  const threadRef = url.searchParams.get("threadRef") ?? undefined;
  if (!principalId || (!id && !threadRef)) throw badRequest("principalId and id or threadRef required");
  const session = await app.sessionRow(principalId, id ? { id } : { threadRef });
  if (!id && !session) return ok({ session: null });
  return found(session && { session });
}

async function searchResources(ctx: ApiCtx): Promise<RouteResult> {
  const principalId = ctx.actor?.p ?? ctx.url.searchParams.get("principalId");
  if (!principalId) return reply(400, { error: "bad_request" });
  const query = (ctx.url.searchParams.get("q") ?? "").slice(0, 500);
  return ok(await ctx.app.searchResources(principalId, query));
}

const searchSessions = withQuery("principalId", async ({ app, url }, principalId) => {
  const rawLimit = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  return ok({ hits: await app.searchSessions(principalId, url.searchParams.get("q") ?? "", limit) });
});

const listContexts = withQuery("principalId", async ({ app }, principalId) =>
  ok({ contexts: await app.listContexts(principalId) }),
);

const listScopeResources = withQuery("principalId", async ({ app, url }, principalId) => {
  const scope = url.searchParams.get("scope");
  if (!scope) throw badRequest("scope required");
  const out = await app.listScopeResources(principalId, scope as ScopeId);
  if (!out) throw fail(404, "not_found", "not a context you can see");
  return ok({ ...out, webhooks: out.webhooks.map(redactWebhook) });
});

async function getUiState(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, url } = ctx;
  const principalId = url.searchParams.get("principalId");
  const key = url.searchParams.get("key") ?? "";
  if (!principalId || !UI_STATE_KEY_PATTERN.test(key))
    return reply(400, { error: "bad_request", message: "principalId and a valid key required" });
  if (!deps.uiState) return reply(404, { error: "not_found" });
  const rec = await deps.uiState.get(uiStateId(principalId, key));
  return ok(rec ?? { value: null, updatedAt: 0 });
}

async function putUiState(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body } = ctx;
  const b = body as { principalId?: unknown; key?: unknown; value?: unknown; updatedAt?: unknown };
  const principalId = typeof b.principalId === "string" ? b.principalId : "";
  const key = typeof b.key === "string" ? b.key : "";
  if (!principalId || !UI_STATE_KEY_PATTERN.test(key))
    return reply(400, { error: "bad_request", message: "principalId and a valid key required" });
  if (b.value === undefined) return reply(400, { error: "bad_request", message: "value required" });
  if (Buffer.byteLength(JSON.stringify(b.value)) > UI_STATE_MAX_BYTES)
    return reply(413, { error: "payload_too_large", message: "ui state too large" });
  if (!deps.uiState) return reply(404, { error: "not_found" });
  const claimed = typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt) ? b.updatedAt : Date.now();
  const updatedAt = Math.min(claimed, Date.now() + UI_STATE_MAX_FUTURE_SKEW_MS);
  const result = await deps.uiState.storeIfNewer(uiStateId(principalId, key), { value: b.value, updatedAt });
  return ok(result);
}

export const surfaceRoutes: ReadonlyArray<Route<ApiCtx>> = [
  ...sessionSharingRoutes,
  ...suggestedActivityRoutes,
  { method: "POST", path: "/v1/session-cap", actor: "system", auth: "source", handle: sessionCapability },
  { method: "GET", path: "/v1/conversations", auth: "either", handle: listAgentConversations },
  { method: "GET", path: "/v1/conversations/:id", auth: "either", handle: getAgentConversation },
  { method: "POST", path: "/v1/conversations/:id", auth: "either", handle: patchAgentConversation },
  { method: "GET", path: "/v1/ui-state", actor: "query.principalId", auth: "source", handle: getUiState },
  { method: "PUT", path: "/v1/ui-state", actor: "body.principalId", auth: "source", handle: putUiState },
  { method: "GET", path: "/v1/apis", auth: "either", handle: listAgentApis },
  { method: "GET", path: "/v1/surface-config", auth: "source", handle: getSurfaceConfig },
  { method: "GET", path: "/v1/runtime-config", actor: "query.principalId", auth: "source", handle: getRuntimeConfig },
  { method: "PUT", path: "/v1/runtime-config", actor: "body.principalId", auth: "source", handle: putRuntimeConfig },
  {
    method: "GET",
    path: "/v1/channel-header-pin",
    actor: "query.principalId",
    auth: "either",
    handle: getChannelHeaderPin,
  },
  {
    method: "PUT",
    path: "/v1/channel-header-pin",
    actor: "body.principalId",
    auth: "either",
    handle: putChannelHeaderPin,
  },
  { method: "GET", path: "/v1/instructions", auth: "either", handle: getInstructions },
  { method: "POST", path: "/v1/instructions", actor: "body.actorId", auth: "either", handle: postInstructions },
  ...withActor("body.principalId", [
    { method: "POST", path: "/v1/sessions/:id/title", auth: "source", handle: regenerateSessionTitle },
    { method: "POST", path: "/v1/sessions/:id/expand", auth: "source", handle: expandSideChat },
    { method: "POST", path: "/v1/sessions/:id/fork", auth: "source", handle: forkSession },
    { method: "POST", path: "/v1/sessions/:id/detach", auth: "source", handle: detachSession },
    { method: "POST", path: "/v1/sessions/:id/goal/cancel", auth: "source", handle: cancelSessionGoal },
    { method: "POST", path: "/v1/files/upload", auth: "source", handle: uploadFile },
    { method: "POST", path: "/v1/sessions/:id", auth: "source", handle: patchSession },
    { method: "PATCH", path: "/v1/memory", auth: "source", handle: selfMemory },
    { method: "DELETE", path: "/v1/memory", auth: "source", handle: selfMemory },
    { method: "POST", path: "/v1/skills", auth: "either", handle: createSkill },
    { method: "PUT", path: "/v1/skills/:id", auth: "either", handle: updateSkill },
    { method: "DELETE", path: "/v1/skills/:id", auth: "either", handle: deleteSkill },
    { method: "POST", path: "/v1/skills/:id/restore", auth: "either", handle: restoreSkill },
  ]),
  ...withActor("query.principalId", [
    { method: "GET", path: "/v1/resources/search", auth: "source", handle: searchResources },
    { method: "GET", path: "/v1/sessions/search", auth: "source", handle: searchSessions },
    { method: "GET", path: "/v1/sessions", auth: "source", handle: listSessions },
    { method: "GET", path: "/v1/sessions/row", auth: "source", handle: getSessionRow },
    { method: "GET", path: "/v1/sessions/:id/side-chats", auth: "source", handle: listSideChats },
    { method: "GET", path: "/v1/sessions/:id/children", auth: "source", handle: listSessionChildren },
    { method: "GET", path: "/v1/contexts", auth: "source", handle: listContexts },
    { method: "GET", path: "/v1/scope-resources", auth: "source", handle: listScopeResources },
    { method: "GET", path: "/v1/memory", auth: "source", handle: selfMemory },
    { method: "GET", path: "/v1/skills", auth: "source", handle: listSkills },
    { method: "GET", path: "/v1/skills/:id", auth: "either", handle: getSkillDetail },
  ]),
  ...withActor("query.viewer", [
    { method: "GET", path: "/v1/sessions/:id/approvals", auth: "source", handle: listSessionApprovals },
    { method: "GET", path: "/v1/sessions/:id/background", auth: "source", handle: getSessionBackground },
    {
      method: "GET",
      path: "/v1/sessions/:id/background/:pid/output",
      auth: "source",
      handle: getSessionBackgroundOutput,
    },
    { method: "GET", path: "/v1/sessions/:id/items/:seq", auth: "source", handle: getSessionItem },
    { method: "GET", path: "/v1/sessions/:id", auth: "source", handle: getSession },
    { method: "GET", path: "/v1/files/:id/content", auth: "either", handle: getFileContent },
    { method: "GET", path: "/v1/files", auth: "either", handle: listFiles },
  ]),
];
