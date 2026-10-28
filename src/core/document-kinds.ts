import type { AttachmentMeta } from "../types.ts";

export const MAX_LLM_REQUEST_BYTES = 18_000_000;
const BASE64_BYTES_PER_RAW_BYTE = 4 / 3;
export const MAX_DOCUMENT_BYTES = Math.floor(MAX_LLM_REQUEST_BYTES / BASE64_BYTES_PER_RAW_BYTE);
const TEXT_EXTENSIONS = new Set(
  "asm bat c cc conf cpp css cxx def dic eml h hh htm html ics ifb in js json ksh list log markdown md mht mhtml mime mjs nws pl py rst s sql srt text txt vcf vtt xml ts tsx jsx sh bash zsh yml yaml toml rs go java rb php swift kt scala lua r jl perl tex cs graphql ndjson json5 dockerfile".split(
    " ",
  ),
);
const DOCUMENT_EXTENSIONS = new Set(
  "pdf xla xlb xlc xlm xls xlsx xlt xlw csv tsv iif doc docx dot odt rtf pages pot ppa pps ppt pptx pwz wiz key ods odp".split(
    " ",
  ),
);
export const OFFICE_FALLBACK_EXTENSIONS = new Set("pdf docx pptx xlsx odt odp ods rtf".split(" "));
const extension = (name: string): string => name.split(".").at(-1)!.toLowerCase();

export const MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  tsv: "text/tab-separated-values",
  eml: "message/rfc822",
  ics: "text/calendar",
  vcf: "text/vcard",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
};

const EXTENSION_BY_MIME = new Map([
  ...Object.entries(MIME_BY_EXTENSION).map(([ext, mime]) => [mime, ext] as const),
  ["text/rtf", "rtf"],
  ["application/javascript", "js"],
]);

export function documentExtension(file: { name: string; mimeType?: string; mimetype?: string }): string {
  const ext = extension(file.name);
  if (TEXT_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext)) return ext;
  const mime = (file.mimeType ?? file.mimetype ?? "").split(";")[0]!.trim().toLowerCase();
  return EXTENSION_BY_MIME.get(mime) ?? (mime.startsWith("text/") ? "txt" : ext);
}

export function isDocumentAttachment(file: { name: string; mimetype?: string }): boolean {
  const ext = documentExtension(file);
  return TEXT_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext);
}

export function isTextDocument(file: { name: string; mimeType?: string; mimetype?: string }): boolean {
  const ext = documentExtension(file);
  return TEXT_EXTENSIONS.has(ext) || ["csv", "tsv", "iif"].includes(ext);
}

const DOCUMENT_BYTES_PER_TOKEN = 4;

export function estimateDocumentTokens(file: { sizeBytes: number }): number {
  const bytes = Number.isFinite(file.sizeBytes) && file.sizeBytes > 0 ? file.sizeBytes : 0;
  return Math.ceil(bytes / DOCUMENT_BYTES_PER_TOKEN);
}

export function documentTokenCharges(
  files: readonly { name: string; mimeType?: string; mimetype?: string; sizeBytes: number }[],
  budget: number,
): number[] {
  const charges = files.map((file) => (isTextDocument(file) ? 0 : estimateDocumentTokens(file)));
  const fitted = files
    .map((file, index) => ({ index, estimate: estimateDocumentTokens(file) }))
    .filter(({ index }) => isTextDocument(files[index]!))
    .sort((a, b) => a.estimate - b.estimate);
  let remaining = Math.max(0, budget - charges.reduce((sum, tokens) => sum + tokens, 0));
  fitted.forEach(({ index, estimate }, position) => {
    const share = Math.floor(remaining / (fitted.length - position));
    charges[index] = Math.min(estimate, share);
    remaining -= charges[index]!;
  });
  return charges;
}

export function replayableDocumentMetas(payload: unknown): AttachmentMeta[] {
  const attachments = (payload as { attachments?: unknown } | null)?.attachments;
  if (!Array.isArray(attachments)) return [];
  return (attachments as AttachmentMeta[]).filter(
    (file) =>
      file?.direction === "in" &&
      typeof file.name === "string" &&
      typeof file.artifactId === "string" &&
      isDocumentAttachment(file),
  );
}

export function documentAttachmentTokens(payload: unknown): number {
  return replayableDocumentMetas(payload).reduce((sum, file) => sum + estimateDocumentTokens(file), 0);
}

export function fileContentRequest(artifactId: string): string {
  return `GET $AGENT_API_URL/v1/files/${artifactId}/content (header x-agent-capability: $AGENT_API_TOKEN)`;
}

export function documentStub(file: { name: string; artifactId?: string }): string {
  const where = file.artifactId
    ? `It is still saved as file ${file.artifactId}: read it with ${fileContentRequest(file.artifactId)} and extract only the parts you need.`
    : "It is still saved in this conversation's files.";
  return `${JSON.stringify(file.name)} is not included inline, to keep this conversation within the model's context. ${where}`;
}
