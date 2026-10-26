import { disclosedMemory } from "../../memory/disclosure.ts";
import type { MemoryEdit, MemoryService } from "../../memory/memory-service.ts";
import { suggestedActivityRoutes } from "./suggested-activities.ts";
import { runtimeConfigBody, userRuntimeConfigBody, webuiModelEnabled } from "../runtime-config.ts";
import { sessionSharingRoutes } from "./session-sharing.ts";
import type { PendingApproval, ScopeId, Session } from "../../types.ts";
import { parseScopeId, scopeId as makeScopeId } from "../../types.ts";
import type { Skill, SkillResolution } from "../../skills/skill-store.ts";
import { ByteSourceTooLargeError } from "../../files/durable-byte-store.ts";
import { defaultModel, modelSupported, thinkingLevelsFor, fastModeModelIds } from "../../model/pi-models.ts";
import { builtInModelCatalog, selectableCatalog, selectableModelCatalog } from "../../model/model-catalog.ts";
import { errMessage } from "../../util/errors.ts";
import { SoulUpdateDeniedError, type SessionPageStatus } from "../app-types.ts";
import { renderAgentApis } from "../agent-api-catalog.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../../auth/capability-token.ts";
import { contentTypeWithUtf8Charset, pipeToResponse, sendJson } from "../http.ts";
import { resolveBranding } from "../../resolution/branding.ts";
import { audit, isObj } from "./shared.ts";
import {
  UI_STATE_KEY_PATTERN,
  UI_STATE_MAX_BYTES,
  UI_STATE_MAX_FUTURE_SKEW_MS,
  storeUiState,
  uiStateId,
} from "../../surfaces/ui-state.ts";
import { redactWebhook } from "./webhooks.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";
import type { ItemKind } from "../../sessions/items.ts";
import { livePersonCapability, SHARED_SKILL_TRIGGER_REFUSAL } from "../artifact-share.ts";
import { tenant } from "../../tenant.ts";

const SYSTEM_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "ContextCompaction",
  "Error",
  "Stop",
  "Retraction",
  "Wake",
]);

function sharedSkillCreateBlock(capability: ApiCtx["capability"]): string | null {
  if (!capability) return null;
  if (parseScopeId(capability.scopeId).kind === "personal") return null;
  if (livePersonCapability(capability)) return null;
  return SHARED_SKILL_TRIGGER_REFUSAL;
}

const AGENT_ONLY = { error: "capability_required", message: "this endpoint is for the agent self-API" };
const WINDOW_ERROR = "tailTurns and beforeSeq must be positive integers, sinceSeq a non-negative one";

function badRequest(res: ApiCtx["res"], message: string): void {
  return sendJson(res, 400, { error: "bad_request", message });
}

function found(res: ApiCtx["res"], value: unknown): void {
  return value ? sendJson(res, 200, value) : sendJson(res, 404, { error: "not_found" });
}

function bodyField(ctx: ApiCtx, name: string): unknown {
  return isObj(ctx.body) ? ctx.body[name] : undefined;
}

function bodyPrincipal(ctx: ApiCtx): string | null {
  const principalId = bodyField(ctx, "principalId");
  return typeof principalId === "string" && principalId ? principalId : null;
}

function withQuery(
  name: "viewer" | "principalId",
  handle: (ctx: ApiCtx, id: string) => Promise<void>,
): (ctx: ApiCtx) => Promise<void> {
  return async (ctx) => {
    const id = ctx.url.searchParams.get(name);
    return id ? handle(ctx, id) : badRequest(ctx.res, `${name} required`);
  };
}

function withBodyPrincipal(
  handle: (ctx: ApiCtx, principalId: string) => Promise<void>,
): (ctx: ApiCtx) => Promise<void> {
  return async (ctx) => {
    const principalId = bodyPrincipal(ctx);
    return principalId ? handle(ctx, principalId) : badRequest(ctx.res, "principalId required");
  };
}

const regenerateSessionTitle = withBodyPrincipal(async ({ res, app, params }, principalId) =>
  found(res, await app.regenerateTitle(params.id!, principalId)),
);

const detachSession = withBodyPrincipal(async ({ res, app, params }, principalId) =>
  found(res, await app.detachSession(params.id!, principalId)),
);

const cancelSessionGoal = withBodyPrincipal(async ({ res, app, params }, principalId) => {
  const out = await app.cancelSessionGoal(params.id!, principalId);
  if (!out) return sendJson(res, 404, { error: "not_found" });
  if (!out.cancelled)
    return sendJson(res, 409, {
      error: out.reason,
      message:
        out.reason === "busy"
          ? "The conversation is still finishing a reply. Try again in a moment."
          : "This conversation has no active or paused goal to cancel.",
    });
  return sendJson(res, 200, out);
});

const forkSession = withBodyPrincipal(async (ctx, principalId) => {
  const upToSeq = bodyField(ctx, "upToSeq");
  if (upToSeq !== undefined && (typeof upToSeq !== "number" || !Number.isInteger(upToSeq) || upToSeq < 0))
    return badRequest(ctx.res, "upToSeq must be a non-negative integer");
  const options = upToSeq !== undefined ? { upToSeq: upToSeq as number } : undefined;
  return found(ctx.res, await ctx.app.forkSession(ctx.params.id!, principalId, options));
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

const getSession = withQuery("viewer", async ({ res, app, url, params }, viewer) => {
  const window = transcriptWindow(url);
  if (!window) return badRequest(res, WINDOW_ERROR);
  return found(res, await app.getSessionForViewer(params.id!, viewer, Object.keys(window).length ? window : undefined));
});

async function getAgentConversation(ctx: ApiCtx): Promise<void> {
  const { res, app, url, capability } = ctx;
  if (!capability) return sendJson(res, 401, AGENT_ONLY);
  if (url.searchParams.has("sinceSeq"))
    return badRequest(res, "agent transcript paging supports tailTurns and beforeSeq");
  const window = transcriptWindow(url, 20);
  if (!window) return badRequest(res, WINDOW_ERROR);
  const view = await app.getSessionForViewer(ctx.params.id!, capability.actorId, window);
  if (!view) return sendJson(res, 404, { error: "not_found", message: "not a conversation you can see" });
  return sendJson(res, 200, {
    session: agentConversation(view.session),
    items: view.items.filter((item) => !SYSTEM_KINDS.has(item.kind)),
    ...(view.earlierItems ? { earlierItems: view.earlierItems } : {}),
  });
}

const getSessionItem = withQuery("viewer", async ({ res, app, params }, viewer) => {
  const seq = Number(params.seq);
  if (!Number.isInteger(seq) || seq < 0) return badRequest(res, "seq must be a non-negative integer");
  return found(res, await app.getSessionItemForViewer(params.id!, viewer, seq));
});

const listSessionApprovals = withQuery("viewer", async (ctx, viewer) => {
  const id = ctx.params.id!;
  const approvals = await ctx.app.listSessionApprovals(id, viewer);
  return sendJson(ctx.res, 200, { approvals: [...approvals, ...(await credentialApprovals(ctx, id, viewer))] });
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

const getSessionBackground = withQuery("viewer", async ({ res, app, params }, viewer) =>
  found(res, await app.sessionBackground(params.id!, viewer)),
);

const getSessionBackgroundOutput = withQuery("viewer", async ({ res, app, url, params }, viewer) => {
  const sinceCursor = Math.max(0, Number(url.searchParams.get("sinceCursor") ?? "0") || 0);
  return found(res, await app.readSessionBackgroundOutput(params.id!, params.pid!, viewer, sinceCursor));
});

async function getFileContent(ctx: ApiCtx): Promise<void> {
  const { res, app, capability, actor } = ctx;
  const id = ctx.params.id!;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return sendJson(res, 401, { error: "capability_required" });
  const opened = await app.openFileForViewer(id, viewer);
  if (!opened) return sendJson(res, 404, { error: "not_found" });
  res.writeHead(200, {
    "content-type": contentTypeWithUtf8Charset(opened.mimetype || "application/octet-stream"),
    "content-length": String(opened.sizeBytes),
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(opened.name)}`,
  });
  pipeToResponse(res, opened.stream, "file read failed");
}

async function listFiles(ctx: ApiCtx): Promise<void> {
  const { res, app, url, capability, actor } = ctx;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return sendJson(res, 401, { error: "capability_required" });
  const limitRaw = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const scope = url.searchParams.get("scope");
  const page = await app.listFilesForViewer(
    viewer,
    {
      ...(limitRaw ? { limit: Number(limitRaw) } : {}),
      ...(cursor ? { cursor } : {}),
    },
    scope ? (scope as ScopeId) : undefined,
  );
  return sendJson(res, 200, page);
}

async function uploadFile(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, body } = ctx;
  if (!deps.blobTransfer)
    return sendJson(res, 501, { error: "not_configured", message: "blob transfer store not wired" });
  const b = isObj(body) ? body : {};
  const principalId = typeof b.principalId === "string" ? b.principalId.trim() : "";
  const blobId = typeof b.blobId === "string" ? b.blobId.trim() : "";
  const name = typeof b.name === "string" ? b.name : "";
  const mimetype = typeof b.mimetype === "string" ? b.mimetype : undefined;
  const scopeId = typeof b.scopeId === "string" && b.scopeId ? (b.scopeId as ScopeId) : undefined;
  if (!principalId || !blobId || !name)
    return sendJson(res, 400, { error: "bad_request", message: "principalId, blobId, and name required" });
  const opened = await deps.blobTransfer.open(blobId);
  if (!opened) return sendJson(res, 404, { error: "not_found", message: "staged blob not found" });
  try {
    const file = await app.uploadFileForViewer(principalId, {
      ...(scopeId ? { scopeId } : {}),
      name,
      ...(mimetype ? { mimetype } : {}),
      data: opened.stream,
    });
    if (!file) {
      opened.stream.destroy();
      return sendJson(res, 403, { error: "forbidden", message: "you can only upload to your own contexts" });
    }
    return sendJson(res, 200, { file });
  } catch (e) {
    if (e instanceof ByteSourceTooLargeError)
      return sendJson(res, 413, { error: "payload_too_large", message: e.message });
    throw e;
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

const patchSession = withBodyPrincipal(async ({ res, app, body, params }, principalId) => {
  const patch = conversationPatch(
    body,
    ["unread", "title", "archived", "pinned", "color"],
    "title, archived, pinned, color, or unread required",
  );
  if (typeof patch === "string") return badRequest(res, patch);
  const session = await app.updateSession(params.id!, principalId, patch);
  if (!session) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { session });
});

async function listAgentConversations(ctx: ApiCtx): Promise<void> {
  const { res, app, capability } = ctx;
  if (!capability) return sendJson(res, 401, AGENT_ONLY);
  const sessions = await app.listSessions(capability.actorId);
  return sendJson(res, 200, { conversations: sessions.map(agentConversation) });
}

async function patchAgentConversation(ctx: ApiCtx): Promise<void> {
  const { res, app, capability, body } = ctx;
  if (!capability) return sendJson(res, 401, AGENT_ONLY);
  const patch = conversationPatch(
    body,
    ["archived", "pinned", "title", "color"],
    "archived, pinned, title, or color required",
  );
  if (typeof patch === "string") return badRequest(res, patch);
  const session = await app.updateSession(ctx.params.id!, capability.actorId, patch);
  if (!session) return sendJson(res, 404, { error: "not_found", message: "not a conversation you can see" });
  audit(ctx.deps, {
    principalId: capability.actorId,
    action: "conversation.update",
    resource: session.id,
    scopeLabel: session.scopeId,
    detail: JSON.stringify(patch),
  });
  return sendJson(res, 200, {
    conversation: {
      ...agentConversation(session),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
    },
  });
}

const DEFAULT_SESSION_PAGE = 50;

const listSessions = withQuery("principalId", async ({ res, app, url }, principalId) => {
  const n = Number(url.searchParams.get("limit") ?? DEFAULT_SESSION_PAGE);
  const before = parseSessionCursor(url.searchParams.get("before"));
  const status = url.searchParams.get("status") ?? "active";
  if (!Number.isInteger(n) || n < 1 || before === null || !isSessionPageStatus(status))
    return badRequest(res, "limit must be a positive integer, before a cursor, status active, archived or waiting");
  const page = await app.listSessionPage(principalId, {
    limit: n,
    ...(before ? { before } : {}),
    status,
    ...(url.searchParams.get("surface") ? { surface: url.searchParams.get("surface")! } : {}),
    ...(url.searchParams.get("scope") ? { scopeId: url.searchParams.get("scope")! } : {}),
    ...(url.searchParams.get("q")?.trim() ? { titleQuery: url.searchParams.get("q")!.trim() } : {}),
  });
  return sendJson(res, 200, {
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

const listSessionChildren = withQuery("principalId", async ({ res, app, params }, principalId) => {
  const children = await app.sessionChildren(principalId, params.id!);
  return found(res, children && { sessions: children });
});

async function getSessionRow(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const principalId = url.searchParams.get("principalId");
  const id = url.searchParams.get("id") ?? undefined;
  const threadRef = url.searchParams.get("threadRef") ?? undefined;
  if (!principalId || (!id && !threadRef)) return badRequest(res, "principalId and id or threadRef required");
  const session = await app.sessionRow(principalId, id ? { id } : { threadRef });
  return found(res, session && { session });
}

async function searchResources(ctx: ApiCtx): Promise<void> {
  const principalId = ctx.actor?.p ?? ctx.url.searchParams.get("principalId");
  if (!principalId) return sendJson(ctx.res, 400, { error: "bad_request" });
  const query = (ctx.url.searchParams.get("q") ?? "").slice(0, 500);
  return sendJson(ctx.res, 200, await ctx.app.searchResources(principalId, query));
}

const searchSessions = withQuery("principalId", async ({ res, app, url }, principalId) => {
  const rawLimit = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  return sendJson(res, 200, { hits: await app.searchSessions(principalId, url.searchParams.get("q") ?? "", limit) });
});

const listContexts = withQuery("principalId", async ({ res, app }, principalId) =>
  sendJson(res, 200, { contexts: await app.listContexts(principalId) }),
);

const listScopeResources = withQuery("principalId", async ({ res, app, url }, principalId) => {
  const scope = url.searchParams.get("scope");
  if (!scope) return badRequest(res, "scope required");
  const out = await app.listScopeResources(principalId, scope as ScopeId);
  if (!out) return sendJson(res, 404, { error: "not_found", message: "not a context you can see" });
  return sendJson(res, 200, { ...out, webhooks: out.webhooks.map(redactWebhook) });
});

async function getUiState(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const principalId = url.searchParams.get("principalId");
  const key = url.searchParams.get("key") ?? "";
  if (!principalId || !UI_STATE_KEY_PATTERN.test(key))
    return sendJson(res, 400, { error: "bad_request", message: "principalId and a valid key required" });
  if (!deps.uiState) return sendJson(res, 404, { error: "not_found" });
  const rec = await deps.uiState.get(uiStateId(principalId, key));
  return sendJson(res, 200, rec ?? { value: null, updatedAt: 0 });
}

async function putUiState(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const b = body as { principalId?: unknown; key?: unknown; value?: unknown; updatedAt?: unknown };
  const principalId = typeof b.principalId === "string" ? b.principalId : "";
  const key = typeof b.key === "string" ? b.key : "";
  if (!principalId || !UI_STATE_KEY_PATTERN.test(key))
    return sendJson(res, 400, { error: "bad_request", message: "principalId and a valid key required" });
  if (b.value === undefined) return sendJson(res, 400, { error: "bad_request", message: "value required" });
  if (Buffer.byteLength(JSON.stringify(b.value)) > UI_STATE_MAX_BYTES)
    return sendJson(res, 413, { error: "payload_too_large", message: "ui state too large" });
  if (!deps.uiState) return sendJson(res, 404, { error: "not_found" });
  const claimed = typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt) ? b.updatedAt : Date.now();
  const updatedAt = Math.min(claimed, Date.now() + UI_STATE_MAX_FUTURE_SKEW_MS);
  const result = await storeUiState(deps.uiState, uiStateId(principalId, key), { value: b.value, updatedAt });
  return sendJson(res, 200, result);
}

export async function memoryFacts(memory: MemoryService, scope: ScopeId) {
  return ((await memory.facts?.(scope)) ?? []).map(({ id, text, createdAt, updatedAt }) => ({
    id,
    text,
    createdAt,
    updatedAt,
  }));
}

export function parseEdits(body: unknown): MemoryEdit[] | string {
  const facts = (isObj(body) ? body : {}).facts;
  if (!Array.isArray(facts) || !facts.length) return "facts (non-empty array of {id, text}) required";
  const edits = facts.flatMap((fact): MemoryEdit[] =>
    isObj(fact) && typeof fact.id === "string" && typeof fact.text === "string" && fact.text.trim()
      ? [{ id: fact.id, text: fact.text }]
      : [],
  );
  return edits.length === facts.length ? edits : "every fact needs a string id and non-empty text";
}

export function parseIds(body: unknown): string[] | string {
  const ids = (isObj(body) ? body : {}).ids;
  return Array.isArray(ids) && ids.length && ids.every((id) => typeof id === "string" && id.trim())
    ? (ids as string[])
    : "ids (non-empty string array) required";
}

async function selfMemory(ctx: ApiCtx): Promise<void> {
  const { res, deps, url, method, body } = ctx;
  const principalId =
    method === "GET" ? url.searchParams.get("principalId") : (body as { principalId?: unknown }).principalId;
  if (typeof principalId !== "string" || !principalId)
    return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  if (!deps.memory) return sendJson(res, 404, { error: "not_found" });
  const scope = makeScopeId("personal", principalId);
  const viewerId = ctx.actor?.p ?? principalId;
  const actor = deps.identity?.classify(viewerId) ?? { id: viewerId, type: "internal" as const };
  const viewerScope = makeScopeId("personal", viewerId);
  const memory = disclosedMemory(deps.memory, {
    actor,
    targetScope: viewerScope,
    nativeScopes: [viewerScope],
    audience: [actor],
    open: true,
    config: deps.config,
    isCurrentSharedScopeMember: (person, target) => ctx.app.isCurrentSharedScopeMember(person, target),
    currentScopeMembers: (target) => ctx.app.currentScopeMembers(target),
  });
  if (method === "PATCH") {
    const edits = parseEdits(body);
    if (typeof edits === "string") return sendJson(res, 400, { error: "bad_request", message: edits });
    await memory.edit?.(scope, edits, principalId);
  } else if (method === "DELETE") {
    const ids = parseIds(body);
    if (typeof ids === "string") return sendJson(res, 400, { error: "bad_request", message: ids });
    await memory.delete?.(scope, ids, principalId);
  }
  const action = method === "GET" ? "memory.self.read" : "memory.self.update";
  audit(deps, { principalId, action, resource: "memory", scopeLabel: scope });
  return sendJson(res, 200, { scopeId: scope, facts: await memoryFacts(memory, scope) });
}

async function sessionCapability(ctx: ApiCtx): Promise<void> {
  const { res, deps, actor } = ctx;
  if (!actor) return sendJson(res, 401, { error: "unauthorized", message: "portal identity required" });
  const secret = deps.capabilitySecret ?? ctx.secret;
  if (!secret) return sendJson(res, 503, { error: "not_configured", message: "capability secret not set" });
  const token = await mintCapabilityToken(
    { actorId: actor.p, scopeId: makeScopeId("personal", actor.p), exp: Date.now() + CAPABILITY_TTL_MS },
    secret,
    deps.capabilityTokenCompression,
  );
  return sendJson(res, 200, { token });
}

async function listAgentApis(ctx: ApiCtx): Promise<void> {
  const { res, deps, capability } = ctx;
  if (!capability) return sendJson(res, 401, { error: "unauthorized", message: "agent capability token required" });
  const admin: { isAdmin: boolean; role?: string } = deps.admin
    ? await deps.admin.adminStatusOf({ id: capability.actorId, type: "internal" }).catch(() => ({ isAdmin: false }))
    : { isAdmin: false };
  audit(deps, {
    principalId: capability.actorId,
    action: "apis.list",
    resource: "apis",
    scopeLabel: capability.scopeId,
  });
  return sendJson(
    res,
    200,
    renderAgentApis(capability, { isAdmin: admin.isAdmin, ...(admin.role ? { role: admin.role } : {}) }),
  );
}

export function parseFacts(body: unknown): string[] | string {
  const b = (isObj(body) ? body : {}) as { facts?: unknown };
  const facts = Array.isArray(b.facts)
    ? b.facts.filter((f): f is string => typeof f === "string" && f.trim() !== "")
    : [];
  if (facts.length === 0) return "facts (non-empty string array) required";
  if (facts.length > 20) return "at most 20 facts per call";
  return facts;
}

const listSkills = withQuery("principalId", async ({ res, app, url }, principalId) => {
  const includeShadowed = url.searchParams.get("includeShadowed") === "1";
  const resolved = (await app.listVisibleSkills(principalId)).filter(
    (r): r is SkillResolution & { skill: Skill } => r.skill !== null,
  );
  const archivedChecks = await Promise.all(
    (await app.listSkills())
      .filter((skill) => skill.status === "archived")
      .map(async (skill) => ({ skill, manageable: await app.canManageSkill(skill, principalId) })),
  );
  const archived = archivedChecks.filter((row) => row.manageable).map(({ skill }) => ({ skill, shadowed: [] }));
  const visible = resolved.flatMap((row) => [
    { skill: row.skill, shadowed: row.shadowed },
    ...(includeShadowed ? row.shadowed.map((skill) => ({ skill, shadowed: [] })) : []),
  ]);
  const skills = await Promise.all(
    [...visible, ...archived].map(async (r) => ({
      id: r.skill.id,
      name: r.skill.manifest.name,
      description: r.skill.manifest.description,
      scope: parseScopeId(r.skill.scopeId).kind ?? r.skill.scopeId,
      scopeId: r.skill.scopeId,
      shadowed: r.shadowed.length > 0,
      status: r.skill.status,
      version: r.skill.version,
      source: r.skill.pack ? "pack" : "native",
      pack: r.skill.pack,
      assetCount: r.skill.manifest.files?.length ?? 0,
      requiredCapabilities: r.skill.manifest.requiredCapabilities,
      editable: await app.canManageSkill(r.skill, principalId),
    })),
  );
  return sendJson(res, 200, { skills });
});

function skillReader(ctx: ApiCtx, fallback: unknown): string | null {
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p ?? (typeof fallback === "string" ? fallback : "");
  if (!ctx.capability && !ctx.actor && ctx.secret) {
    sendJson(ctx.res, 401, { error: "capability_required" });
    return null;
  }
  if (principalId) return principalId;
  badRequest(ctx.res, "principalId required");
  return null;
}

function skillView(skill: Skill) {
  return {
    id: skill.id,
    name: skill.manifest.name,
    description: skill.manifest.description,
    body: skill.manifest.body,
    status: skill.status,
    version: skill.version,
  };
}

async function getSkillDetail(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  const principalId = skillReader(ctx, ctx.url.searchParams.get("principalId"));
  if (!principalId) return;
  const skill = await app.getSkill(ctx.params.id!);
  if (
    !skill ||
    (!(await app.canManageSkill(skill, principalId)) &&
      !(await app.listVisibleSkills(principalId)).some((row) => row.skill?.id === skill.id))
  ) {
    return sendJson(res, 404, { error: "not_found" });
  }
  return sendJson(res, 200, {
    skill: {
      ...skillView(skill),
      scope: parseScopeId(skill.scopeId).kind ?? skill.scopeId,
      scopeId: skill.scopeId,
      createdBy: skill.createdBy,
      pack: skill.pack,
      files: (skill.manifest.files ?? []).map((file) => ({ path: file.path, executable: file.executable === true })),
      requiredCapabilities: skill.manifest.requiredCapabilities,
      grantedCapabilities: skill.grantedCapabilities,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
      editable: await app.canManageSkill(skill, principalId),
    },
  });
}

async function restoreSkill(ctx: ApiCtx): Promise<void> {
  const principalId = skillReader(ctx, bodyField(ctx, "principalId"));
  if (!principalId) return;
  const restored = await ctx.app.restoreOwnedSkill(ctx.params.id!, principalId);
  return restored ? sendJson(ctx.res, 200, { ok: true }) : sendJson(ctx.res, 404, { error: "not_found" });
}

function skillOwner(ctx: ApiCtx): string | null {
  return ctx.capability ? ctx.capability.actorId : bodyPrincipal(ctx);
}

async function updateSkill(ctx: ApiCtx): Promise<void> {
  const { res, app, capability } = ctx;
  const principalId = skillOwner(ctx);
  if (principalId === null) return badRequest(res, "principalId required");
  const patch: { description?: string; body?: string } = {};
  for (const field of ["description", "body"] as const) {
    const value = bodyField(ctx, field);
    if (value !== undefined && typeof value !== "string") return badRequest(res, `${field} must be a string`);
    if (typeof value === "string") patch[field] = value;
  }
  const liveActor = capability ? livePersonCapability(capability) : true;
  const updated = await app.updateOwnedSkill(ctx.params.id!, principalId, patch, { liveActor });
  if (updated === "trigger_blocked")
    return sendJson(res, 403, { error: "forbidden", message: SHARED_SKILL_TRIGGER_REFUSAL });
  if (!updated) return sendJson(res, 404, { error: "not_found", message: "no such skill, or it isn't yours to edit" });
  return sendJson(res, 200, { skill: skillView(updated) });
}

async function deleteSkill(ctx: ApiCtx): Promise<void> {
  const { res, app, capability } = ctx;
  const principalId = skillOwner(ctx);
  if (principalId === null) return badRequest(res, "principalId required");
  const liveActor = capability ? livePersonCapability(capability) : true;
  const outcome = await app.deleteOwnedSkill({ principalId, id: ctx.params.id!, liveActor });
  if (outcome === "missing") return sendJson(res, 404, { error: "not_found", message: "no such skill" });
  if (outcome === "trigger_blocked")
    return sendJson(res, 403, { error: "forbidden", message: SHARED_SKILL_TRIGGER_REFUSAL });
  if (outcome === "forbidden")
    return sendJson(res, 403, { error: "forbidden", message: "that skill isn't yours to archive" });
  return sendJson(res, 200, { ok: true });
}

async function createSkill(ctx: ApiCtx): Promise<void> {
  const { res, app, capability } = ctx;
  const blocked = sharedSkillCreateBlock(capability);
  if (blocked) return sendJson(res, 403, { error: "forbidden", message: blocked });
  const principalId = skillOwner(ctx);
  if (principalId === null) return badRequest(res, "principalId required");
  let homeScope = capability?.scopeId;
  const requestedScope = bodyField(ctx, "scopeId");
  if (!capability && typeof requestedScope === "string" && requestedScope !== makeScopeId("personal", principalId)) {
    if (!(await app.managesScope(principalId, requestedScope as ScopeId)))
      return sendJson(res, 403, { error: "forbidden", message: "you cannot create a skill in that context" });
    homeScope = requestedScope as ScopeId;
  }
  if (homeScope && (parseScopeId(homeScope).kind === "org" || parseScopeId(homeScope).kind === "team")) {
    return sendJson(res, 403, {
      error: "forbidden",
      message: "a skill cannot be created in an org or team scope — promote a published skill instead",
    });
  }
  const fields = {
    name: bodyField(ctx, "name"),
    description: bodyField(ctx, "description"),
    body: bodyField(ctx, "body"),
  };
  for (const [field, value] of Object.entries(fields))
    if (typeof value !== "string" || !value.trim()) return badRequest(res, `${field} required`);
  const created = await app.createOwnedSkill({
    principalId,
    ...(homeScope ? { homeScope } : {}),
    name: fields.name as string,
    description: fields.description as string,
    body: fields.body as string,
  });
  if (!created)
    return sendJson(res, 409, {
      error: "exists",
      message: "a skill of that name already exists here — edit it instead",
    });
  return sendJson(res, 201, { skill: skillView(created) });
}

async function getSurfaceConfig(ctx: ApiCtx): Promise<void> {
  await ctx.deps.refreshModels?.();
  const { res, deps } = ctx;
  if (!deps.config) return sendJson(res, 404, { error: "not_found" });
  const [webuiModels, baseModel, externalSlackParticipants, branding] = await Promise.all([
    deps.config.getWebuiModelsDurable(tenant().orgScope),
    deps.config.getBaseModelDurable(tenant().orgScope),
    deps.config.getExternalSlackParticipantsDurable(tenant().orgScope),
    resolveBranding(deps.config, tenant().orgScope, deps.brandingDefault),
  ]);
  const managedKeys = deps.modelCredentials ? await deps.modelCredentials.availability() : null;
  const providerStatus = managedKeys ?? deps.providerKeys;
  const catalog = managedKeys?.openrouter
    ? await selectableModelCatalog(deps.modelCredentialFetch)
    : builtInModelCatalog();
  const allowed = selectableCatalog(catalog).map((model) => model.id);
  const configuredPicker = webuiModels?.filter((id) => modelSupported(id)) ?? [];
  const resolvedBase = modelSupported(baseModel ?? undefined) ? baseModel! : defaultModel(deps.baseModelDefault);
  const resolvedBranding = Object.fromEntries(
    (["orgName", "accent", "mark", "markUrl", "selfLabel"] as const).flatMap((key) =>
      branding[key] ? [[key, branding[key]]] : [],
    ),
  );
  return sendJson(res, 200, {
    webuiModels: webuiModels != null ? configuredPicker : allowed,
    baseModel: resolvedBase,
    ...(providerStatus && {
      modelProviderConfigured: Boolean(
        providerStatus.anthropic ||
        providerStatus.openai ||
        providerStatus.openrouter ||
        providerStatus.modelIds?.size ||
        deps.companySubscriptionAuth,
      ),
    }),
    externalSlackParticipants,
    ...(Object.keys(resolvedBranding).length ? { branding: resolvedBranding } : {}),
  });
}

async function runtimeTarget(ctx: ApiCtx): Promise<{ actorId: string; scope: ScopeId } | null> {
  const requested = (name: string) => {
    const value = bodyField(ctx, name);
    return typeof value === "string" ? value : ctx.url.searchParams.get(name);
  };
  const actorId = ctx.capability?.actorId ?? requested("principalId");
  const scope = (ctx.capability?.scopeId ?? requested("scopeId")) as ScopeId | null;
  if (!actorId || !scope) return null;
  const parsed = parseScopeId(scope);
  const allowed =
    (parsed.kind === "personal" && parsed.ref === actorId) ||
    (parsed.kind !== "org" && (Boolean(ctx.capability) || (await ctx.app.belongsToScope(actorId, scope))));
  return allowed ? { actorId, scope } : null;
}

async function getRuntimeConfig(ctx: ApiCtx): Promise<void> {
  const account = ctx.url.searchParams.get("account");
  if (account !== null && account !== "company") return sendJson(ctx.res, 400, { error: "invalid_account" });
  if (!ctx.deps.config) return sendJson(ctx.res, 404, { error: "not_found" });
  const target = await runtimeTarget(ctx);
  if (!target) return sendJson(ctx.res, 403, { error: "forbidden" });
  await ctx.deps.refreshModels?.();
  return sendJson(
    ctx.res,
    200,
    account === "company"
      ? await runtimeConfigBody(ctx, target.scope)
      : await userRuntimeConfigBody(ctx, target.scope, target.actorId),
  );
}

async function putRuntimeConfig(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.config || !isObj(ctx.body)) return sendJson(ctx.res, 400, { error: "bad_request" });
  const target = await runtimeTarget(ctx);
  if (!target) return sendJson(ctx.res, 403, { error: "forbidden" });
  await ctx.deps.refreshModels?.();
  const config = ctx.deps.config;
  if (ctx.body.inherit === true) await config.setRuntimeSelection(target.scope, null);
  else if (ctx.body.keep === true) {
    const runtime = await config.getRuntimeSelectionDurable(target.scope);
    if (runtime) await config.acknowledgeRuntimeSelection(target.scope);
    else {
      const legacyModel = await config.getBaseModelOwnDurable(target.scope);
      if (legacyModel && modelSupported(legacyModel) && (await webuiModelEnabled(ctx, legacyModel))) {
        await config.setRuntimeSelection(target.scope, { modelId: legacyModel });
      }
    }
  } else {
    const modelId = ctx.body.modelId;
    if (typeof modelId !== "string" || !modelSupported(modelId))
      return sendJson(ctx.res, 400, { error: "model_not_supported" });
    if (!(await webuiModelEnabled(ctx, modelId))) return sendJson(ctx.res, 400, { error: "model_not_enabled" });
    const effortLevel = ctx.body.effortLevel ?? "auto";
    if (typeof effortLevel !== "string" || !thinkingLevelsFor(modelId).includes(effortLevel))
      return sendJson(ctx.res, 400, { error: "effort_not_supported" });
    const fastMode = ctx.body.fastMode ?? false;
    if (typeof fastMode !== "boolean") return sendJson(ctx.res, 400, { error: "fast_mode_invalid" });
    const choice = { modelId, effortLevel, fastMode: fastMode && fastModeModelIds().includes(modelId) };
    if ((await config.getModelAccountDurable(target.actorId)) !== "company") {
      const available = await userRuntimeConfigBody(ctx, target.scope, target.actorId);
      if (!available.models.includes(modelId)) return sendJson(ctx.res, 400, { error: "account_runtime_unavailable" });
    }
    await config.setRuntimeSelection(target.scope, choice);
  }
  audit(ctx.deps, {
    principalId: target.actorId,
    action: "runtime-config.update",
    resource: "runtime-config",
    scopeLabel: target.scope,
  });
  return sendJson(ctx.res, 200, await userRuntimeConfigBody(ctx, target.scope, target.actorId));
}

async function getChannelHeaderPin(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.config) return sendJson(ctx.res, 404, { error: "not_found" });
  const target = await runtimeTarget(ctx);
  if (!target) return sendJson(ctx.res, 403, { error: "forbidden" });
  const [on, configured, def] = await Promise.all([
    ctx.deps.config.getChannelHeaderPinDurable(target.scope),
    ctx.deps.config.getChannelHeaderPinOverrideDurable(target.scope),
    ctx.deps.config.getChannelHeaderPinDefaultDurable(),
  ]);
  return sendJson(ctx.res, 200, { scopeId: target.scope, on, configured, default: def });
}

async function putChannelHeaderPin(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.config || !isObj(ctx.body)) return sendJson(ctx.res, 400, { error: "bad_request" });
  if (ctx.capability && !livePersonCapability(ctx.capability))
    return sendJson(ctx.res, 403, { error: "live_actor_required" });
  const target = await runtimeTarget(ctx);
  if (!target) return sendJson(ctx.res, 403, { error: "forbidden" });
  if (typeof ctx.body.on !== "boolean" && ctx.body.on !== null)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "expected { on: boolean | null } (null reverts to the org default)",
    });
  await ctx.deps.config.setChannelHeaderPin(target.scope, ctx.body.on);
  audit(ctx.deps, {
    principalId: target.actorId,
    action: "channel-header-pin.update",
    resource: "channel-header-pin",
    scopeLabel: target.scope,
  });
  return sendJson(ctx.res, 200, {
    scopeId: target.scope,
    on: ctx.body.on ?? (await ctx.deps.config.getChannelHeaderPinDefaultDurable()),
    configured: ctx.body.on,
  });
}

function getSoul(ctx: ApiCtx): void {
  const { res, app, url, capability } = ctx;
  const scopeIdVal = capability?.scopeId ?? url.searchParams.get("scopeId");
  if (!scopeIdVal) return sendJson(res, 400, { error: "bad_request", message: "scopeId required" });
  return sendJson(res, 200, app.getSoul(scopeIdVal));
}

export async function postSoul(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  const b = body as { scopeId?: unknown; content?: unknown; actorId?: unknown };
  const scopeIdVal = capability ? capability.scopeId : b.scopeId;
  const actorId = capability ? capability.actorId : b.actorId;
  const content = b.content;
  if (typeof content !== "string" || typeof scopeIdVal !== "string" || typeof actorId !== "string")
    return badRequest(res, capability ? "content (string) required" : "scopeId, content, actorId required");
  const allowSharedScope =
    Boolean(capability) ||
    (parseScopeId(scopeIdVal).kind !== "personal" && (await app.managesScope(actorId, scopeIdVal as ScopeId)));
  try {
    const version = await app.updateSoul(
      scopeIdVal,
      content,
      actorId,
      allowSharedScope ? { allowSharedScope: true } : undefined,
    );
    return sendJson(res, 200, { ok: true, version });
  } catch (e) {
    if (e instanceof SoulUpdateDeniedError)
      return sendJson(res, 403, { error: "soul_update_denied", message: e.message });
    return sendJson(res, 500, { error: "soul_update_failed", message: errMessage(e) });
  }
}

export const surfaceRoutes: ReadonlyArray<Route<ApiCtx>> = [
  ...sessionSharingRoutes,
  ...suggestedActivityRoutes,
  { method: "POST", path: "/v1/session-cap", actor: "system", auth: "source", handle: sessionCapability },
  { method: "GET", path: "/v1/conversations", auth: "either", handle: listAgentConversations },
  { method: "GET", path: "/v1/conversations/:id", auth: "either", handle: getAgentConversation },
  { method: "POST", path: "/v1/conversations/:id", auth: "either", handle: patchAgentConversation },
  { method: "GET", path: "/v1/ui-state", auth: "source", handle: getUiState },
  { method: "PUT", path: "/v1/ui-state", auth: "source", handle: putUiState },
  { method: "GET", path: "/v1/apis", auth: "either", handle: listAgentApis },
  { method: "GET", path: "/v1/surface-config", auth: "source", handle: getSurfaceConfig },
  { method: "GET", path: "/v1/runtime-config", auth: "source", handle: getRuntimeConfig },
  { method: "PUT", path: "/v1/runtime-config", auth: "source", handle: putRuntimeConfig },
  { method: "GET", path: "/v1/channel-header-pin", auth: "either", handle: getChannelHeaderPin },
  { method: "PUT", path: "/v1/channel-header-pin", auth: "either", handle: putChannelHeaderPin },
  { method: "GET", path: "/v1/soul", auth: "either", handle: getSoul },
  { method: "POST", path: "/v1/soul", actor: "body.actorId", auth: "either", handle: postSoul },
  ...withActor("body.principalId", [
    { method: "POST", path: "/v1/sessions/:id/title", auth: "source", handle: regenerateSessionTitle },
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
    { method: "POST", path: "/v1/skills/:id/restore", auth: "either", allowedInStrict: true, handle: restoreSkill },
  ]),
  ...withActor("query.principalId", [
    { method: "GET", path: "/v1/resources/search", auth: "source", handle: searchResources },
    { method: "GET", path: "/v1/sessions/search", auth: "source", handle: searchSessions },
    { method: "GET", path: "/v1/sessions", auth: "source", handle: listSessions },
    { method: "GET", path: "/v1/sessions/row", auth: "source", handle: getSessionRow },
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
