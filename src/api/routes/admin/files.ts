import { fileArtifactId, type FileArtifact } from "../../../files/file-artifact-store.ts";
import { MAX_ATTACHMENT_BYTES, safeAttachmentName } from "../../../core/attachments.ts";
import { mimeFromName } from "../../../core/document-kinds.ts";
import { contentDispositionAttachment, contentTypeWithUtf8Charset, pipeToResponse } from "../../http.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "../route.ts";
import { adminAt, badRequest, discoverScopes, notFound, scopedAdmin } from "./common.ts";

const FILE_PREVIEW_MAX_BYTES = 256 * 1024;
const FILES_PAGE_SIZE = 200;
const FILES_LIST_MAX = 2000;

const fileRow = (a: FileArtifact) => ({
  id: a.id,
  scopeId: a.ownerScopeId,
  name: a.name,
  path: a.path,
  mimetype: a.mimetype,
  size: a.sizeBytes,
  direction: a.direction,
  createdAt: a.createdAt,
  openable: a.blobKey != null,
});

async function adminFile(ctx: ApiCtx) {
  const { deps, url } = ctx;
  const id = url.searchParams.get("id") ?? "";
  if (!id) throw badRequest("id required");
  if (!deps.files) throw notFound();
  const art = await deps.files.get(id);
  if (!art) throw notFound();
  const authz = await adminAt(ctx, art.ownerScopeId);
  return { files: deps.files, id, art, authz };
}

export async function readAdminFile(ctx: ApiCtx): Promise<RouteResult> {
  const found = await adminFile(ctx);
  if (!found) return;
  const { files, id, art, authz } = found;
  authz.audit("file.read", art.path);
  const opened = await files.open(id);
  if (!opened) throw notFound();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of opened.stream) {
    const b = chunk as Buffer;
    if (total + b.length >= FILE_PREVIEW_MAX_BYTES) {
      chunks.push(b.subarray(0, FILE_PREVIEW_MAX_BYTES - total));
      truncated = true;
      opened.stream.destroy();
      break;
    }
    chunks.push(b);
    total += b.length;
  }
  const content = Buffer.concat(chunks).toString("utf8");
  const { ownerScopeId: scopeId, path, name, mimetype } = art;
  return ok({ id: art.id, scopeId, path, name, mimetype, content, truncated });
}

export async function downloadAdminFile(ctx: ApiCtx): Promise<RouteResult> {
  const { res } = ctx;
  const found = await adminFile(ctx);
  if (!found) return;
  const { files, id, art, authz } = found;
  const mime = art.mimetype.split(";")[0]!.trim().toLowerCase();
  const inline = /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain)$/.test(mime);
  authz.audit(inline ? "file.view" : "file.download", art.path);
  const opened = await files.open(id);
  if (!opened) throw notFound();
  res.writeHead(200, {
    "content-type": inline ? contentTypeWithUtf8Charset(art.mimetype) : "application/octet-stream",
    "content-length": String(opened.sizeBytes),
    "content-disposition": contentDispositionAttachment(art.name, inline ? "inline" : "attachment"),
    "x-content-type-options": "nosniff",
    ...(inline ? { "cache-control": "private, max-age=300", "content-security-policy": "sandbox" } : {}),
  });
  pipeToResponse(res, opened.stream, "file read failed");
}

export async function listAdminFiles(ctx: ApiCtx): Promise<RouteResult> {
  const { app, deps, url } = ctx;
  const authz = await scopedAdmin(ctx);
  const { scope, orgWide } = authz;
  const nameQuery = (url.searchParams.get("q") ?? "").trim();
  authz.audit("files.read", "files");
  if (!deps.files) return ok({ scopeId: scope, files: [] });
  const scopes = orgWide ? [...(await discoverScopes(app, deps)).keys()] : [scope];
  const files: ReturnType<typeof fileRow>[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.files.listOwnedByScopes(scopes, {
      limit: FILES_PAGE_SIZE,
      ...(nameQuery ? { nameQuery } : {}),
      ...(cursor ? { cursor } : {}),
    });
    files.push(...page.files.map(fileRow));
    cursor = page.nextCursor;
  } while (cursor && files.length < FILES_LIST_MAX);
  return ok({ scopeId: scope, files });
}

export async function uploadAdminFile(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body } = ctx;
  const authz = await scopedAdmin(ctx);
  if (!deps.files) return reply(404, { error: "not_found", message: "file store not wired" });
  if (!deps.blobTransfer) return reply(501, { error: "not_configured", message: "blob transfer store not wired" });
  const { actor, scope } = authz;
  const b = body as { blobId?: unknown; name?: unknown; mimetype?: unknown };
  const blobId = typeof b.blobId === "string" ? b.blobId.trim() : "";
  const name = safeAttachmentName(typeof b.name === "string" ? b.name : "");
  const mimetype =
    (typeof b.mimetype === "string" && b.mimetype ? b.mimetype : mimeFromName(name))
      .split(";")[0]!
      .trim()
      .toLowerCase() || mimeFromName(name);
  if (!blobId) throw badRequest("blobId required");
  const opened = await deps.blobTransfer.open(blobId);
  if (!opened) return reply(404, { error: "not_found", message: "staged blob not found" });
  const id = fileArtifactId(`admin-upload:${actor.id}:${scope}:${Date.now()}:${blobId}`, "in", 0);
  const path = `artifacts/${id}/${name}`;
  try {
    const { artifact } = await deps.files.put({
      id,
      ownerScopeId: scope,
      createdBy: actor.id,
      name,
      path,
      mimetype,
      data: opened.stream,
      direction: "in",
      createdInScope: scope,
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
    authz.audit("file.upload", path);
    return ok({ file: fileRow(artifact) });
  } finally {
    await deps.blobTransfer.delete(blobId);
  }
}
