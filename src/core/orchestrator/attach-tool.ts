import type { OutgoingAttachment } from "../../types.ts";
import { type Sandbox, type SandboxHandle } from "../../sandbox/sandbox.ts";
import type { BlobTransferStore } from "../../persistence/blob-transfer.ts";
import type { AttachFiles, AttachResult, PostedFileMeta } from "../../tools/primitives.ts";
import {
  collectNamedOutbound,
  parseOutboundFiles,
  type OutboundFile,
  type OpenStoredFile,
  discardOutbound,
  type ArtifactRegistration,
} from "../attachments.ts";

export interface AttachToolsContext {
  sandbox: Sandbox;
  provision: (sandboxId?: string) => Promise<SandboxHandle>;
  blobTransfer: BlobTransferStore;
  fileRegistration: ArtifactRegistration;
  openStored?: OpenStoredFile;
}

export interface StagedAttachments {
  attach: AttachFiles;
  staged: () => OutgoingAttachment[];
}

interface StagedEntry {
  attachment: OutgoingAttachment;
  created: ReadonlySet<string>;
}

export function unattachable(r: Record<"missing" | "empty" | "oversized" | "overTotal", string[]>): string[] {
  return [
    ...r.missing.map((p) => `${p} (not found)`),
    ...r.empty.map((p) => `${p} (empty)`),
    ...r.oversized.map((p) => `${p} (too large)`),
    ...r.overTotal.map((p) => `${p} (too large alongside the files already attached)`),
  ];
}

export function fileMetas(attachments: readonly OutgoingAttachment[]): PostedFileMeta[] {
  return attachments.map((a) => ({
    name: a.name,
    mimetype: a.mimetype,
    sizeBytes: a.sizeBytes,
    ...(a.artifactId ? { artifactId: a.artifactId } : {}),
  }));
}

export function createAttachStaging(ctx: AttachToolsContext): StagedAttachments {
  const staged = new Map<string, StagedEntry>();
  let calls = 0;
  const attach = async (files: readonly OutboundFile[], sandboxId?: string): Promise<AttachResult> => {
    const parsed = parseOutboundFiles(files);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const keyed = new Map(
      parsed.files.map((file) => [
        typeof file === "string"
          ? JSON.stringify(["path", sandboxId ?? null, file])
          : JSON.stringify(["file", file.file_id]),
        file,
      ]),
    );
    const paths = [...keyed.values()];
    const keys = [...keyed.keys()];
    if (!paths.length) return { ok: false, message: "attach needs at least one file" };
    const register = { ...ctx.fileRegistration, seed: `${ctx.fileRegistration.seed}:attach:${calls}` };
    calls += 1;
    const kept = [...staged.entries()].filter(([path]) => !keys.includes(path)).map(([, entry]) => entry.attachment);
    const r = await collectNamedOutbound(
      ctx.sandbox,
      () => ctx.provision(sandboxId),
      paths,
      ctx.blobTransfer,
      register,
      kept.map((attachment) => attachment.name),
      ctx.openStored,
      kept.reduce((sum, attachment) => sum + attachment.sizeBytes, 0),
    );
    const bad = unattachable(r);
    if (bad.length)
      return {
        ok: false,
        message: `couldn't attach: ${bad.join(", ")} — nothing was staged; fix the path(s) and retry`,
      };
    for (const [i, attachment] of r.attachments.entries()) {
      const path = keys[i]!;
      const superseded = staged.get(path);
      staged.set(path, { attachment, created: r.createdArtifactIds });
      if (superseded) {
        const referenced = [...staged.values()].some(
          (entry) => entry.attachment.artifactId === superseded.attachment.artifactId,
        );
        await discardOutbound(
          superseded.attachment,
          ctx.blobTransfer,
          register,
          referenced ? undefined : superseded.created,
        );
      }
    }
    return {
      ok: true,
      files: fileMetas(r.attachments),
      staged: staged.size,
    };
  };
  return { attach, staged: () => [...staged.values()].map((e) => e.attachment) };
}
