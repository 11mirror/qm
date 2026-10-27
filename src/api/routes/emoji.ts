import { runEmojiUpload } from "../../connectors/emoji-upload-service.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, reply, type Route, type RouteResult } from "./route.ts";

async function addEmoji(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body, capability } = ctx;
  if (!capability) return reply(401, { error: "unauthorized", message: "agent capability token required" });
  if (!deps.browserSessionStore) {
    return reply(404, {
      error: "not_supported",
      message: "the emoji uploader isn't available in this deployment",
    });
  }
  const b = isObj(body) ? body : {};
  const name = typeof b.name === "string" ? b.name : "";
  const imageBase64 = typeof b.image === "string" ? b.image : "";
  if (!name || !imageBase64) {
    return reply(400, {
      error: "bad_request",
      message: "name (string) and image (base64 PNG/GIF) are required",
    });
  }
  const connectorWorkspace = deps.directory ? (await deps.directory.meta()).workspaceUrl : null;
  const result = await runEmojiUpload(
    {
      principalId: capability.actorId,
      sessionStore: deps.browserSessionStore,
      ...(connectorWorkspace ? { connectorWorkspace } : {}),
    },
    { name, imageBase64, ...(typeof b.workspace === "string" && b.workspace ? { workspace: b.workspace } : {}) },
  );
  return reply(result.ok ? 200 : 422, result);
}

export const emojiRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/emoji", auth: "either", handle: addEmoji },
];
