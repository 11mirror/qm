import { previewFile } from "./file-open.ts";
import { html, nothing } from "lit";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  Upload,
  type IconNode,
} from "lucide";
import { api, fileContentUrl, webFetch, withBase } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { browserRenderableImage, formatBytes, relTime } from "./ui";
import { icon } from "./icons";
import { ensureContexts, personalScopeId, scopeTitle } from "./contexts";
import { appState } from "./shell";
import { artifactPage, groupBy, listPageTpl, listSelect } from "./list-page";
import { isTouch } from "./viewport";

interface FileItem {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
  createdAt: number;
  createdInScope?: string;
  ownerScopeId?: string;
  openable: boolean;
}
type FileRow = FileItem & { shared: boolean };

const PAGE_SIZE = 60;
let fileRows: FileRow[] = [];
let filesNotice = "";
let filesType: "all" | "image" | "document" | "other" = "all";
let filesOwnership: "all" | "owned" | "shared" = "all";
let filesDragActive = false;
let filesUploading = false;
let filesLoadingMore = false;
let filesNextCursor: string | null = null;
const page = artifactPage("files", "files-page", "files");
let filesRequestSeq = 0;
let filesLoadAllQueued = false;

function fileScope(f: FileItem): string | null {
  return f.createdInScope ?? (f.ownerScopeId?.startsWith("personal:") ? f.ownerScopeId : null) ?? personalScopeId();
}

function typeOf(f: FileItem): "image" | "document" | "other" {
  if (browserRenderableImage(f.mimetype)) return "image";
  if (f.mimetype.startsWith("text/") || /(?:pdf|document|sheet|presentation|json|xml|csv)/i.test(f.mimetype))
    return "document";
  return "other";
}

const VISUALS: Array<[string, IconNode, RegExp, RegExp?]> = [
  ["pdf", FileText, /pdf/, /\.pdf$/],
  ["spreadsheet", FileSpreadsheet, /spreadsheet|excel|csv|tab-separated/, /\.(csv|tsv|xlsx?|ods)$/],
  ["presentation", Presentation, /presentation|powerpoint/, /\.(pptx?|key|odp)$/],
  ["code", FileJson, /json/, /\.json$/],
  ["archive", FileArchive, /zip|archive|compressed|tar|gzip/, /\.(zip|tar|gz|tgz|rar|7z)$/],
  ["audio", FileAudio, /^audio\//],
  ["video", FileVideo, /^video\//],
  ["code", FileCode, /javascript|typescript|xml|html|css|shell|python/, /\.(jsx?|tsx?|html|css|py|sh|sql|xml|ya?ml)$/],
];

function fileVisual(f: FileItem): { glyph: IconNode; kind: string } {
  const name = f.name.toLowerCase();
  const mime = f.mimetype.toLowerCase();
  if (browserRenderableImage(mime)) return { glyph: FileImage, kind: "image" };
  const [kind, glyph] = VISUALS.find(([, , m, n]) => m.test(mime) || n?.test(name)) ?? [];
  if (kind && glyph) return { glyph, kind };
  if (mime.startsWith("text/") || typeOf(f) === "document") return { glyph: FileText, kind: "document" };
  return { glyph: File, kind: "generic" };
}

function visibleFiles(): FileRow[] {
  return fileRows
    .filter((f) => page.inScope(fileScope(f)) && page.matches(`${f.name} ${f.mimetype}`))
    .filter((f) => filesOwnership === "all" || (filesOwnership === "shared") === f.shared)
    .filter((f) => filesType === "all" || typeOf(f) === filesType)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function drawFiles(loading = false): void {
  const visible = visibleFiles();
  const filtered = Boolean(page.scope || page.query.trim() || filesType !== "all" || filesOwnership !== "all");
  let dropLabel = isTouch() ? "Choose files to upload" : "Drop files here or choose files";
  if (filesDragActive) dropLabel = "Drop files";
  else if (filesUploading) dropLabel = "Uploading…";
  const refilter = (apply: () => void) => {
    apply();
    drawFiles();
    void loadMoreFiles(true);
  };
  page.paint(
    listPageTpl({
      title: "Files",
      search: {
        value: page.query,
        placeholder: "Search file names and types…",
        onInput: (value) => refilter(() => (page.query = value)),
      },
      filters: html`<div class="list-toolbar">
          ${listSelect(
            "Ownership",
            filesOwnership,
            [
              ["all", "All files"],
              ["owned", "Yours"],
              ["shared", "Shared"],
            ],
            (v) => refilter(() => (filesOwnership = v as typeof filesOwnership)),
          )}
          ${listSelect(
            "Type",
            filesType,
            [
              ["all", "All types"],
              ["image", "Images"],
              ["document", "Documents"],
              ["other", "Other"],
            ],
            (v) => refilter(() => (filesType = v as typeof filesType)),
          )}
        </div>
        <button
          class="file-drop ${filesDragActive ? "dragging" : ""}"
          type="button"
          ?disabled=${filesUploading}
          @click=${pickFiles}
          @dragenter=${onFileDrag}
          @dragover=${onFileDrag}
          @dragleave=${onFileDrag}
          @drop=${onFileDrag}
        >
          ${icon(Upload, 16)}<span>${dropLabel}</span>
        </button>`,
      notice: filesNotice || (loading && !fileRows.length ? "Loading files…" : ""),
      rows: [],
      groups: groupBy(visible, (f) => fileScope(f) ?? "").map((group) => ({
        title: scopeTitle(fileScope(group.items[0]!)),
        rows: group.items.map(fileRow),
      })),
      rowsClass: "file-list",
      empty: filtered ? "No files match these filters." : "No files yet.",
      footer: filesNextCursor
        ? html`<div class="list-footer">
            <button class="btn" type="button" ?disabled=${filesLoadingMore} @click=${() => void loadMoreFiles()}>
              ${filesLoadingMore ? "Loading…" : "Load more"}
            </button>
          </div>`
        : undefined,
    }),
    drawFiles,
  );
}

function fileRow(f: FileRow) {
  const contentUrl = fileContentUrl(f.id, f.name);
  const visual = fileVisual(f);
  const content = html`
    <span class="file-row-icon ${visual.kind}">${icon(visual.glyph, 18)}</span>
    <span class="list-row-title" dir="auto">${f.name}</span>
    <span class="list-row-meta"
      ><span>${formatBytes(f.sizeBytes)}</span><span>${relTime(f.createdAt)}</span>${
        f.openable ? nothing : html`<span>Unavailable</span>`
      }</span
    >
  `;
  return f.openable
    ? html`<a
        class="list-row file-row"
        href=${contentUrl}
        target="_blank"
        rel="noreferrer"
        @click=${(event: MouseEvent) => previewFile(event, f.name, contentUrl, f.mimetype)}
        >${content}</a
      >`
    : html`<article class="list-row file-row">${content}</article>`;
}

async function fileSha256(file: globalThis.File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadOne(file: globalThis.File): Promise<void> {
  const scope = page.scope ?? personalScopeId();
  const q = new URLSearchParams();
  if (scope) q.set("scope", scope);
  q.set("sha", await fileSha256(file));
  q.set("name", file.name || "file");
  const r = await webFetch(withBase(`/api/files/upload?${q.toString()}`), {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (r.ok) return;
  const text = (await r.text()).trim();
  let body: { message?: string; error?: string } | null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { message: text || undefined };
  }
  throw new Error(body?.message ?? body?.error ?? `Upload failed (${r.status})`);
}

async function uploadFiles(files: globalThis.File[]): Promise<void> {
  const picked = files.filter((f) => f.size >= 0);
  if (!picked.length || filesUploading) return;
  filesUploading = true;
  filesNotice = `Uploading ${picked.length} ${picked.length === 1 ? "file" : "files"}…`;
  drawFiles();
  let uploaded = 0;
  try {
    for (const file of picked) {
      await uploadOne(file);
      uploaded++;
    }
    filesNotice = `Uploaded ${picked.length} ${picked.length === 1 ? "file" : "files"}.`;
    await loadFiles(appState.viewRenderSeq);
  } catch (e) {
    filesNotice = `${uploaded ? `Uploaded ${uploaded} of ${picked.length}. ` : ""}${errMessage(e, "Upload failed.")}`;
    if (uploaded) await loadFiles(appState.viewRenderSeq);
    else drawFiles();
  } finally {
    filesUploading = false;
    filesDragActive = false;
    drawFiles();
  }
}

function pickFiles(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = () => void uploadFiles(Array.from(input.files ?? []));
  input.click();
}

function onFileDrag(e: DragEvent): void {
  if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
  if (e.type !== "dragleave") e.preventDefault();
  else if (e.relatedTarget instanceof Node && (e.currentTarget as HTMLElement).contains(e.relatedTarget)) return;
  if (e.type === "drop") {
    e.stopPropagation();
    void uploadFiles(Array.from(e.dataTransfer?.files ?? []));
  }
  const active = e.type === "dragenter" || e.type === "dragover";
  if (filesDragActive === active) return;
  filesDragActive = active;
  drawFiles();
}

async function fetchFilePage(cursor?: string, scope = page.scope) {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) q.set("cursor", cursor);
  if (scope) q.set("scope", scope);
  const r = await api<{ owned?: FileItem[]; shared?: FileItem[]; nextCursor?: string }>(`/api/files?${q.toString()}`);
  const rows: FileRow[] = [
    ...(r.owned ?? []).map((f) => ({ ...f, shared: false })),
    ...(r.shared ?? []).map((f) => ({ ...f, shared: true })),
  ];
  return { rows, nextCursor: r.nextCursor ?? null };
}

async function loadMoreFiles(all = false): Promise<void> {
  if (all && !page.query.trim() && filesType === "all" && filesOwnership !== "owned") return;
  if (filesLoadingMore) {
    filesLoadAllQueued ||= all;
    return;
  }
  if (!filesNextCursor) return;
  const requestSeq = filesRequestSeq;
  const scope = page.scope;
  filesLoadingMore = true;
  drawFiles();
  try {
    do {
      const next = await fetchFilePage(filesNextCursor, scope);
      if (requestSeq !== filesRequestSeq) return;
      const byId = new Map(fileRows.map((f) => [f.id, f]));
      for (const row of next.rows) byId.set(row.id, row);
      fileRows = [...byId.values()];
      filesNextCursor = next.nextCursor;
    } while (all && filesNextCursor);
  } catch (e) {
    if (requestSeq !== filesRequestSeq) return;
    filesNotice = errMessage(e, all ? "Failed to load all matching files." : "Failed to load more files.");
  }
  if (requestSeq !== filesRequestSeq) return;
  const queued = filesLoadAllQueued && !all;
  filesLoadAllQueued = false;
  filesLoadingMore = false;
  drawFiles();
  if (queued) void loadMoreFiles(true);
}

async function loadFiles(seq: number): Promise<void> {
  const requestSeq = ++filesRequestSeq;
  filesLoadAllQueued = false;
  filesLoadingMore = false;
  await ensureContexts();
  drawFiles(true);
  try {
    const page = await fetchFilePage();
    if (requestSeq !== filesRequestSeq || seq !== appState.viewRenderSeq || appState.currentView !== "files") return;
    fileRows = page.rows;
    filesNextCursor = page.nextCursor;
    void loadMoreFiles(true);
  } catch (e) {
    if (requestSeq !== filesRequestSeq || seq !== appState.viewRenderSeq || appState.currentView !== "files") return;
    filesNotice = errMessage(e, "Failed to load files.");
  }
  drawFiles();
}

export async function renderFiles(): Promise<void> {
  if (appState.currentView !== "files") return;
  if (page.adoptScope()) fileRows = [];
  const seq = appState.viewRenderSeq;
  filesNotice = "";
  filesNextCursor = null;
  await loadFiles(seq);
}
