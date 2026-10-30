import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface KnowledgeManifest {
  schemaVersion: number;
  files: ManifestFile[];
}

export interface FinnyKnowledgeChunk {
  path: string;
  content: string;
  sha256: string;
  heading?: string;
}

export interface FinnyKnowledgeIndex {
  bundleDigest: `sha256:${string}`;
  fileCount: number;
  select(query: string, options?: { maxChunks?: number; maxChars?: number }): FinnyKnowledgeChunk[];
}

interface IndexedChunk extends FinnyKnowledgeChunk {
  terms: Set<string>;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);
const INDEXABLE_EXTENSIONS = new Set([".md", ".txt", ".json", ".html"]);
const MAX_INDEX_CHUNK_CHARS = 6_000;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function terms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]*/g)
      ?.filter((term) => term.length > 1 && !STOP_WORDS.has(term)) ?? [],
  );
}

function score(query: Set<string>, candidate: Set<string>): number {
  let value = 0;
  for (const term of query) if (candidate.has(term)) value += term.length > 5 ? 2 : 1;
  return value;
}

function safeManifestPath(root: string, relative: string): string {
  if (!relative || relative.includes("\0")) throw new Error("Finny knowledge manifest path is invalid");
  const absolute = resolve(root, relative);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!absolute.startsWith(prefix)) throw new Error("Finny knowledge manifest path escapes the bundle");
  return absolute;
}

function boundedSections(content: string, extension: string): Array<{ content: string; heading?: string }> {
  const sections: Array<{ content: string; heading?: string }> = [];
  if (extension === ".md") {
    let heading: string | undefined;
    let lines: string[] = [];
    const flush = () => {
      const value = lines.join("\n").trim();
      if (value) sections.push({ content: value, ...(heading ? { heading } : {}) });
      lines = [];
    };
    for (const line of content.split("\n")) {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (match) {
        flush();
        heading = match[2];
        lines.push(line);
      } else lines.push(line);
    }
    flush();
  } else sections.push({ content: content.trim() });

  return sections.flatMap((section) => {
    if (section.content.length <= MAX_INDEX_CHUNK_CHARS) return [section];
    const chunks: Array<{ content: string; heading?: string }> = [];
    for (let offset = 0; offset < section.content.length; offset += MAX_INDEX_CHUNK_CHARS) {
      chunks.push({
        content: section.content.slice(offset, offset + MAX_INDEX_CHUNK_CHARS),
        ...(section.heading ? { heading: section.heading } : {}),
      });
    }
    return chunks;
  });
}

function parseManifest(value: unknown): KnowledgeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Finny knowledge manifest is invalid");
  const manifest = value as Partial<KnowledgeManifest>;
  if (!Number.isInteger(manifest.schemaVersion) || !Array.isArray(manifest.files)) {
    throw new Error("Finny knowledge manifest is invalid");
  }
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !Number.isInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Finny knowledge manifest is invalid");
  }
  return manifest as KnowledgeManifest;
}

export async function loadFinnyKnowledgeIndex(directory: string): Promise<FinnyKnowledgeIndex> {
  const root = resolve(directory);
  const manifest = parseManifest(JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as unknown);
  const chunks: IndexedChunk[] = [];
  const digestRows: string[] = [];
  let indexedFiles = 0;
  for (const file of [...manifest.files].sort((left, right) => left.path.localeCompare(right.path))) {
    const path = safeManifestPath(root, file.path);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== file.size)
      throw new Error(`Finny knowledge size mismatch: ${file.path}`);
    const bytes = await readFile(path);
    const actual = sha256(bytes);
    if (actual !== file.sha256) throw new Error(`Finny knowledge digest mismatch: ${file.path}`);
    digestRows.push(`${file.path}\0${actual}\0${file.size}`);
    const extension = extname(file.path).toLowerCase();
    if (!INDEXABLE_EXTENSIONS.has(extension)) continue;
    indexedFiles += 1;
    for (const section of boundedSections(bytes.toString("utf8"), extension)) {
      const digest = sha256(section.content);
      chunks.push({
        path: file.path,
        content: section.content,
        sha256: digest,
        ...(section.heading ? { heading: section.heading } : {}),
        terms: terms(`${file.path}\n${section.heading ?? ""}\n${section.content}`),
      });
    }
  }
  const bundleDigest = `sha256:${sha256(digestRows.join("\n"))}` as const;
  return {
    bundleDigest,
    fileCount: indexedFiles,
    select(query, options = {}) {
      const queryTerms = terms(query);
      const maxChunks = options.maxChunks ?? Number.POSITIVE_INFINITY;
      const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
      if (!queryTerms.size || maxChunks <= 0 || maxChars <= 0) return [];
      const ranked = chunks
        .map((chunk) => ({ chunk, score: score(queryTerms, chunk.terms) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.chunk.path.localeCompare(right.chunk.path));
      const selected: FinnyKnowledgeChunk[] = [];
      let used = 0;
      for (const { chunk } of ranked) {
        if (selected.length >= maxChunks || used + chunk.content.length > maxChars) continue;
        selected.push({
          path: chunk.path,
          content: chunk.content,
          sha256: chunk.sha256,
          ...(chunk.heading ? { heading: chunk.heading } : {}),
        });
        used += chunk.content.length;
      }
      return selected;
    },
  };
}
