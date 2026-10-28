import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { swallow, swallowAs } from "../util/errors.ts";
import { asChunks, collectBytes, type ByteSource } from "../util/bytes.ts";
import {
  bodyToReadable,
  isNoSuchKey,
  isNoSuchLifecycleConfiguration,
  s3Client,
  s3MultipartUpload,
  type S3Send,
} from "./s3.ts";

export const MAX_BLOB_BYTES = 1_000_000_000;
export const MAX_STAGE_BLOB_BYTES = 12_000_000_000;

export const S3_PART_BYTES = 16 * 1024 * 1024;

interface BlobInfo {
  blobId: string;
  sizeBytes: number;
  sha256: string;
}

interface OpenBlob {
  sizeBytes: number;
  stream: Readable;
}

interface PutOptions {
  maxBytes?: number;
  expectedSha256?: string;
}

type BlobSource = ByteSource;

export interface BlobTransferStore {
  put(source: BlobSource, opts?: PutOptions): Promise<BlobInfo>;
  open(blobId: string): Promise<OpenBlob | null>;
  delete(blobId: string): Promise<void>;
  sweep(maxAgeMs: number): Promise<number>;
  ensureExpiry?(maxAgeDays: number): Promise<boolean>;
  s3Ref?(blobId: string): { bucket: string; key: string } | null;
}

export class BlobTooLargeError extends Error {
  constructor() {
    super("blob exceeds the size limit");
    this.name = "BlobTooLargeError";
  }
}

export class BlobHashMismatchError extends Error {
  constructor() {
    super("blob content hash mismatch");
    this.name = "BlobHashMismatchError";
  }
}

export function isBlobId(value: string): boolean {
  return value.length === 32 && Buffer.from(value, "hex").toString("hex") === value;
}

function isMissingPath(err: unknown): boolean {
  return err != null && typeof err === "object" && (err as { code?: string }).code === "ENOENT";
}

function newBlobId(): string {
  return randomBytes(16).toString("hex");
}

function meteredChunks(
  source: BlobSource,
  maxBytes: number | undefined,
): { chunks: AsyncIterable<Buffer>; sizeBytes: () => number; sha256: () => string } {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const chunks = (async function* (): AsyncIterable<Buffer> {
    for await (const chunk of asChunks(source)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buf.length;
      if (maxBytes != null && sizeBytes > maxBytes) throw new BlobTooLargeError();
      hash.update(buf);
      yield buf;
    }
  })();
  return { chunks, sizeBytes: () => sizeBytes, sha256: () => hash.digest("hex") };
}

export async function collectBlob(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function createLocalBlobTransferStore(dir: string): BlobTransferStore {
  let ensured: Promise<unknown> | null = null;
  const ensureDir = (): Promise<unknown> => (ensured ??= mkdir(dir, { recursive: true }));

  return {
    async put(source, opts) {
      await ensureDir();
      const blobId = newBlobId();
      const partPath = join(dir, `${blobId}.part`);
      const finalPath = join(dir, blobId);
      const metered = meteredChunks(source, opts?.maxBytes);
      try {
        await pipeline(metered.chunks, createWriteStream(partPath));
      } catch (err) {
        await rm(partPath, { force: true }).catch(swallowAs("blob-transfer: partial-file cleanup", undefined));
        throw err;
      }
      const sha256 = metered.sha256();
      if (opts?.expectedSha256 && opts.expectedSha256 !== sha256) {
        await rm(partPath, { force: true }).catch(swallowAs("blob-transfer: partial-file cleanup", undefined));
        throw new BlobHashMismatchError();
      }
      await rename(partPath, finalPath);
      return { blobId, sizeBytes: metered.sizeBytes(), sha256 };
    },

    async open(blobId) {
      if (!isBlobId(blobId)) return null;
      const path = join(dir, blobId);
      let st;
      try {
        st = await stat(path);
      } catch (err) {
        if (isMissingPath(err)) return null;
        throw err;
      }
      if (!st.isFile()) return null;
      return { sizeBytes: st.size, stream: createReadStream(path) };
    },

    async delete(blobId) {
      if (!isBlobId(blobId)) return;
      await rm(join(dir, blobId), { force: true }).catch(swallowAs("blob-transfer: delete", undefined));
    },

    async sweep(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        if (isMissingPath(err)) return 0;
        throw err;
      }
      for (const name of names) {
        const path = join(dir, name);
        try {
          const st = await stat(path);
          if (st.mtimeMs <= cutoff) {
            await rm(path, { force: true });
            removed++;
          }
        } catch (err) {
          swallow("blob-transfer: sweep entry", err);
        }
      }
      return removed;
    },
  };
}

export interface S3BlobTransferOptions {
  bucket: string;
  region?: string;
  prefix?: string;
  _client?: S3Send;
}

async function* exactParts(
  chunks: AsyncIterable<Buffer>,
  size: number,
): AsyncGenerator<{ body: Buffer; last: boolean }> {
  let pending: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of chunks) {
    pending.push(chunk);
    bytes += chunk.length;
    while (bytes > size) {
      const all = Buffer.concat(pending, bytes);
      yield { body: all.subarray(0, size), last: false };
      pending = [all.subarray(size)];
      bytes -= size;
    }
  }
  if (bytes > 0) yield { body: Buffer.concat(pending, bytes), last: true };
}

export function createS3BlobTransferStore(options: S3BlobTransferOptions): BlobTransferStore {
  const bucket = options.bucket;
  const prefix = (options.prefix ?? "") + "transfer/";
  const keyFor = (blobId: string): string => prefix + blobId;
  const client = options._client ?? s3Client(options.region);

  return {
    s3Ref: (blobId) => (isBlobId(blobId) ? { bucket, key: keyFor(blobId) } : null),
    async put(source, opts) {
      const blobId = newBlobId();
      const Key = keyFor(blobId);
      const metered = meteredChunks(source, opts?.maxBytes);
      const parts = exactParts(metered.chunks, S3_PART_BYTES);
      const first = await parts.next();
      if (first.done || first.value.last) {
        const Body = first.done ? Buffer.alloc(0) : first.value.body;
        await client.send(new PutObjectCommand({ Bucket: bucket, Key, Body }));
      } else {
        const head = first.value;
        await s3MultipartUpload(
          client,
          bucket,
          Key,
          (async function* () {
            yield head;
            yield* parts;
          })(),
        );
      }

      const sha256 = metered.sha256();
      if (opts?.expectedSha256 && opts.expectedSha256 !== sha256) {
        await client
          .send(new DeleteObjectCommand({ Bucket: bucket, Key }))
          .catch(swallowAs("blob-transfer: hash-mismatch cleanup", undefined));
        throw new BlobHashMismatchError();
      }
      return { blobId, sizeBytes: metered.sizeBytes(), sha256 };
    },

    async open(blobId) {
      if (!isBlobId(blobId)) return null;
      let r: { Body?: unknown; ContentLength?: number };
      try {
        r = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(blobId) }))) as {
          Body?: unknown;
          ContentLength?: number;
        };
      } catch (err) {
        if (isNoSuchKey(err)) return null;
        throw err;
      }
      if (r.Body == null) return null;
      return { sizeBytes: r.ContentLength ?? 0, stream: bodyToReadable(r.Body) };
    },

    async delete(blobId) {
      if (!isBlobId(blobId)) return;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(blobId) }));
    },

    async sweep(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      let token: string | undefined;
      do {
        const page = (await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }),
        )) as {
          Contents?: Array<{ Key?: string; LastModified?: Date }>;
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        for (const obj of page.Contents ?? []) {
          if (!obj.Key) continue;
          if ((obj.LastModified?.getTime() ?? Infinity) <= cutoff) {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
            removed++;
          }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return removed;
    },

    async ensureExpiry(maxAgeDays) {
      const RULE_ID = "qm-transfer-expiry";
      let rules: LifecycleRule[] = [];
      try {
        const cfg = (await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))) as {
          Rules?: LifecycleRule[];
        };
        rules = cfg.Rules ?? [];
      } catch (err) {
        if (!isNoSuchLifecycleConfiguration(err)) throw err;
      }
      const others = rules.filter((r) => r.ID !== RULE_ID);
      const days = Math.max(1, Math.ceil(maxAgeDays));
      const ours: LifecycleRule = {
        ID: RULE_ID,
        Status: "Enabled",
        Filter: { Prefix: prefix },
        Expiration: { Days: days },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: days },
      };
      await client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: { Rules: [...others, ours] },
        }),
      );
      return true;
    },
  };
}

export function createMemoryBlobTransferStore(): BlobTransferStore {
  const blobs = new Map<string, { data: Buffer; at: number }>();
  return {
    async put(source, opts) {
      const { data, sizeBytes, sha256 } = await collectBytes(source, {
        ...(opts?.maxBytes != null ? { maxBytes: opts.maxBytes } : {}),
        tooLarge: () => new BlobTooLargeError(),
      });
      if (opts?.expectedSha256 && opts.expectedSha256 !== sha256) throw new BlobHashMismatchError();
      const blobId = newBlobId();
      blobs.set(blobId, { data, at: Date.now() });
      return { blobId, sizeBytes, sha256 };
    },
    async open(blobId) {
      const hit = blobs.get(blobId);
      if (!hit) return null;
      return { sizeBytes: hit.data.length, stream: Readable.from(hit.data) };
    },
    async delete(blobId) {
      blobs.delete(blobId);
    },
    async sweep(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      for (const [id, v] of blobs) {
        if (v.at <= cutoff) {
          blobs.delete(id);
          removed++;
        }
      }
      return removed;
    },
  };
}
