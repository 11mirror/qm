import { errMessage } from "../../chassis/src/errors.ts";
import type { Attachment } from "@earendil-works/pi-web-ui";
import { base64ToBytes } from "./paste-text.ts";
import { ApiError, webFetch, withBase } from "./core-bridge.ts";
import { fileSha256 } from "./file-hash.ts";

export type PiAttachment = Omit<Attachment, "id" | "preview"> & { id?: string };

export interface CoreAttachment {
  name: string;
  mimetype: string;
  sizeBytes: number;
  blobId: string;
}

export const MAX_ATTACHMENT_BYTES = 1_000_000_000;
export const MAX_FILES_PER_MESSAGE = 10;

export function oversizeAttachmentNote(name: string): string {
  return `"${name}" is too large — files up to ~1 GB can be sent. It was left out.`;
}

export function tooManyFilesNote(names: string[]): string {
  const skipped = names.map((n) => `"${n}"`).join(", ");
  return `Skipped ${skipped} — too many files in one message (max ${MAX_FILES_PER_MESSAGE}).`;
}

interface SkippedAttachment {
  id?: string;
  name: string;
  note: string;
  permanent: boolean;
}

export interface AttachmentUpload {
  uploaded: CoreAttachment[];
  skipped: SkippedAttachment[];
}

export async function uploadAttachments(attachments: readonly PiAttachment[]): Promise<AttachmentUpload> {
  const uploaded: CoreAttachment[] = [];
  const skipped: SkippedAttachment[] = [];
  for (const a of attachments) {
    const skip = (note: string, permanent: boolean): void => {
      skipped.push({ ...(a.id ? { id: a.id } : {}), name: a.fileName, note, permanent });
    };
    if (typeof a.content !== "string" || a.content.length === 0) {
      skip(`"${a.fileName}" is empty. It was left out.`, true);
      continue;
    }
    if (a.size > MAX_ATTACHMENT_BYTES) {
      skip(oversizeAttachmentNote(a.fileName), true);
      continue;
    }
    try {
      uploaded.push(await toCoreAttachment(a));
    } catch (err) {
      if (err instanceof ApiError && err.status === 413) skip(oversizeAttachmentNote(a.fileName), true);
      else skip(`"${a.fileName}" couldn't be uploaded (${errMessage(err)}). Try again.`, false);
    }
  }
  return { uploaded, skipped };
}

async function toCoreAttachment(a: PiAttachment): Promise<CoreAttachment> {
  const bytes = base64ToBytes(a.content);
  const sha256 = await fileSha256(new Blob([bytes as unknown as ArrayBuffer]));
  const r = await webFetch(withBase(`/api/blobs?sha=${sha256}`), {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes as unknown as BodyInit,
  });
  if (!r.ok) throw new ApiError(`attachment upload failed: HTTP ${r.status}`, r.status);
  const { blobId, sizeBytes } = (await r.json()) as { blobId: string; sizeBytes: number };
  return { name: a.fileName, mimetype: a.mimeType, sizeBytes: sizeBytes ?? a.size, blobId };
}
