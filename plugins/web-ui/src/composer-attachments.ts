import type { Agent } from "@earendil-works/pi-agent-core";
import type { Attachment } from "@earendil-works/pi-web-ui";
import { FolderDropError, folderToZipFile, isFolderReadError, splitDropItems, type DropEntryLike } from "./folder-drop";
import { html, nothing, render } from "lit";
import { MAX_ATTACHMENT_BYTES, MAX_FILES_PER_MESSAGE, oversizeAttachmentNote, tooManyFilesNote } from "./attachments";
import { errMessage } from "../../chassis/src/errors";
import { bytesToBase64 } from "./paste-text";
import type { ConvCtx } from "./conv-types";
import type { createFileDragState } from "./file-open";

const LARGE_PASTE_CHARS = 2000;

export function textAttachment(id: string, fileName: string, mimeType: string, text: string): Attachment {
  const bytes = new TextEncoder().encode(text);
  const content = bytesToBase64(bytes);
  return { id, type: "document", fileName, mimeType, size: bytes.length, content, extractedText: text };
}

export async function loadAnyAttachment(file: File): Promise<Attachment> {
  try {
    const { loadAttachment } = await import("@earendil-works/pi-web-ui");
    return await loadAttachment(file);
  } catch {
    return {
      id: `${file.name}_${Date.now()}_${Math.random()}`,
      type: "document",
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      content: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    };
  }
}

function combineNote(existing: string, note: string | null): string {
  if (!note) return existing;
  return existing ? `${existing} ${note}` : note;
}

function dragHasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return types ? Array.from(types).includes("Files") : false;
}

export function attachmentSrc(a: Attachment): string {
  return a.content.startsWith("data:") ? a.content : `data:${a.mimeType};base64,${a.content}`;
}

export function openImagePreview(attachment: Attachment): void {
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog attachment-preview";
  dialog.setAttribute("aria-label", attachment.fileName);
  dialog.addEventListener(
    "close",
    () => {
      render(nothing, dialog);
      dialog.remove();
    },
    { once: true },
  );
  document.body.append(dialog);
  render(
    html`
      <div class="attachment-preview-head">
        <span dir="auto">${attachment.fileName}</span>
        <button type="button" class="btn compact" @click=${() => dialog.close()}>Close</button>
      </div>
      <div class="attachment-preview-body">
        <button
          type="button"
          aria-label="Toggle actual image size"
          @click=${(event: Event) => (event.currentTarget as HTMLElement).classList.toggle("actual-size")}
        >
          <img src=${attachmentSrc(attachment)} alt=${attachment.fileName} />
        </button>
      </div>
    `,
    dialog,
  );
  dialog.showModal();
}

export function createComposerAttachments({
  ctx,
  composerState,
  fileDrag,
  pastedTextIds,
  approvalPending,
}: {
  ctx: ConvCtx;
  composerState: {
    attachments: Attachment[];
    error: string;
    processingFiles: boolean;
    pasteView: { readonly id: string } | null;
  };
  fileDrag: ReturnType<typeof createFileDragState>;
  pastedTextIds: Set<string>;
  approvalPending: () => boolean;
}) {
  async function onComposerPaste(e: ClipboardEvent, agent: Agent): Promise<void> {
    const data = e.clipboardData;
    if (!data) return;
    const files = Array.from(data.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length) {
      e.preventDefault();
      await addFiles(files, agent);
      return;
    }
    const text = data.getData("text/plain");
    if (text.length <= LARGE_PASTE_CHARS) return;
    if (approvalPending() || composerState.processingFiles) return;
    if (composerState.attachments.length >= MAX_FILES_PER_MESSAGE) return;
    e.preventDefault();
    const names = new Set(composerState.attachments.map((a) => a.fileName));
    let n = 1;
    while (names.has(n === 1 ? "pasted-text.txt" : `pasted-text-${n}.txt`)) n++;
    const attachment = textAttachment(
      `paste_${Date.now()}_${Math.random()}`,
      n === 1 ? "pasted-text.txt" : `pasted-text-${n}.txt`,
      "text/plain",
      text,
    );
    pastedTextIds.add(attachment.id);
    composerState.attachments = [...composerState.attachments, attachment];
    ctx.chat.drawActiveChat(agent);
  }

  async function onFilesSelected(e: Event, agent: Agent): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await addFiles(files, agent);
  }

  function restageAttachments(attachments: Attachment[], note: string): void {
    const merged = [...attachments, ...composerState.attachments].filter(
      (a, i, all) => all.findIndex((b) => b.id === a.id) === i,
    );
    const dropped = merged.slice(MAX_FILES_PER_MESSAGE);
    composerState.attachments = merged.slice(0, MAX_FILES_PER_MESSAGE);
    composerState.error = combineNote(note, dropped.length ? tooManyFilesNote(dropped.map((a) => a.fileName)) : null);
  }

  function planAdmission(files: File[], folderCount: number): { files: File[]; folders: number; note: string | null } {
    const notes: string[] = [];
    const sized: File[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) notes.push(oversizeAttachmentNote(file.name));
      else sized.push(file);
    }
    const room = Math.max(0, MAX_FILES_PER_MESSAGE - composerState.attachments.length);
    const admittedFiles = sized.slice(0, room);
    const admittedFolders = Math.min(folderCount, Math.max(0, room - admittedFiles.length));
    const overflow = [
      ...sized.slice(room).map((f) => f.name),
      ...Array.from({ length: folderCount - admittedFolders }, () => "a folder"),
    ];
    if (overflow.length) notes.push(tooManyFilesNote(overflow));
    return { files: admittedFiles, folders: admittedFolders, note: notes.length ? notes.join(" ") : null };
  }

  async function addFiles(files: File[], agent: Agent, folders: DropEntryLike[] = []): Promise<void> {
    if ((!files.length && !folders.length) || approvalPending()) return;
    if (composerState.processingFiles) {
      composerState.error = "Still preparing the previous drop. Try again in a moment.";
      ctx.chat.drawActiveChat(agent);
      return;
    }
    composerState.processingFiles = true;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    const plan = planAdmission(files, folders.length);
    try {
      const zipped: File[] = [];
      for (const folder of folders.slice(0, plan.folders)) zipped.push(await folderToZipFile(folder));
      const loaded = await Promise.all([...plan.files, ...zipped].map((file) => loadAnyAttachment(file)));
      composerState.attachments = [...composerState.attachments, ...loaded];
      if (plan.note) composerState.error = plan.note;
    } catch (err) {
      let message: string;
      if (err instanceof FolderDropError) message = err.message;
      else if (isFolderReadError(err))
        message = "That drop included a folder this browser can't read. Zip it and drop the archive instead.";
      else message = errMessage(err, "Could not attach that file.");
      composerState.error = combineNote(plan.note ?? "", message);
    } finally {
      composerState.processingFiles = false;
      ctx.chat.drawActiveChat(agent);
    }
  }

  function onDragEnter(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    fileDrag.enter(e);
  }

  function onDragOver(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  async function onDrop(e: DragEvent, agent: Agent): Promise<void> {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    fileDrag.reset();
    const { files, folders } = splitDropItems(Array.from(e.dataTransfer?.items ?? []));
    if (!files.length && !folders.length) files.push(...Array.from(e.dataTransfer?.files ?? []));
    ctx.chat.drawActiveChat(agent);
    await addFiles(files, agent, folders);
  }

  function pickFiles(): void {
    if (approvalPending()) return;
    ctx.chat.state.host?.querySelector<HTMLInputElement>(".file-input")?.click();
  }

  function removeAttachment(id: string, agent: Agent): void {
    composerState.attachments = composerState.attachments.filter((a) => a.id !== id);
    pastedTextIds.delete(id);
    if (composerState.pasteView?.id === id) composerState.pasteView = null;
    ctx.chat.drawActiveChat(agent);
  }

  return {
    onComposerPaste,
    onDragEnter,
    onDragOver,
    onDrop,
    onFilesSelected,
    pickFiles,
    removeAttachment,
    restageAttachments,
  };
}
