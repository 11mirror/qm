import { isSubagentThreadRef } from "../../sessions/thread-ref.ts";
import { sessionTreeRoot } from "../../subagents/tree.ts";
import { isObj, refuse } from "./shared.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult } from "./route.ts";

export async function conversationRef(ctx: ApiCtx): Promise<string | null> {
  const { capability } = ctx;
  if (!capability)
    throw refuse(401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  if (!capability.threadRef)
    throw refuse(400, { error: "no_conversation", message: "this token isn't bound to a conversation" });
  if (!isSubagentThreadRef(capability.threadRef)) return capability.threadRef;
  const sessions = ctx.deps.sessions;
  const session = await sessions?.getByThread(capability.threadRef);
  const root = session && sessions ? await sessionTreeRoot(sessions, session) : null;
  if (!root || root.scopeId !== capability.scopeId || !(await sessions!.getForParticipant(root.id, capability.actorId)))
    throw refuse(403, { error: "forbidden", message: "the originating conversation is no longer accessible" });
  return root.threadRef;
}

async function addPin(ctx: ApiCtx): Promise<RouteResult> {
  const { app, body, capability } = ctx;
  const threadRef = await conversationRef(ctx);
  if (!threadRef) return;
  const b = isObj(body) ? body : {};
  const text = typeof b.text === "string" && b.text.trim() ? b.text.trim() : undefined;
  const seq = b.seq;
  if (seq !== undefined && (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0)) {
    return reply(400, { error: "bad_request", message: "seq must be a non-negative integer" });
  }
  if (!text && seq === undefined) {
    return reply(400, {
      error: "bad_request",
      message: "pass `text` (a note to pin) and/or `seq` (a transcript entry to pin)",
    });
  }
  const out = await app.pinConversationItem(threadRef, capability!.actorId, {
    ...(text ? { text } : {}),
    ...(seq !== undefined ? { entrySeq: seq } : {}),
  });
  if ("error" in out) {
    if (out.error === "not_found") return reply(404, { error: "not_found", message: "no such conversation" });
    if (out.error === "bad_entry") {
      return reply(404, { error: "entry_not_found", message: `no transcript entry with seq ${seq}` });
    }
    return reply(409, {
      error: "pin_limit",
      message: "this conversation already has the maximum number of pins — unpin something first",
    });
  }
  return ok({ ok: true, pin: out.pin });
}

async function listPins(ctx: ApiCtx): Promise<RouteResult> {
  const { app, capability } = ctx;
  const threadRef = await conversationRef(ctx);
  if (!threadRef) return;
  const pins = await app.listConversationPins(threadRef, capability!.actorId);
  if (pins === null) return reply(404, { error: "not_found", message: "no such conversation" });
  return ok({ pins });
}

async function removePin(ctx: ApiCtx): Promise<RouteResult> {
  const { app } = ctx;
  const threadRef = await conversationRef(ctx);
  if (!threadRef) return;
  const removed = await app.unpinConversationItem(threadRef, ctx.params.id!);
  if (removed === null) return reply(404, { error: "not_found", message: "no such conversation" });
  if (!removed) return reply(404, { error: "not_found", message: "no such pin" });
  return ok({ ok: true });
}

export const pinRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/pins", auth: "either", handle: addPin },
  { method: "GET", path: "/v1/pins", auth: "either", handle: listPins },
  { method: "DELETE", path: "/v1/pins/:id", auth: "either", handle: removePin },
];
