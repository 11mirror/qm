import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import type { LeaderLease } from "../../src/persistence/leader-lease.ts";
import {
  BlobHashMismatchError,
  BlobTooLargeError,
  type BlobTransferStore,
} from "../../src/persistence/blob-transfer.ts";
import { collectBytes } from "../../src/util/bytes.ts";

export function createNoopAdvisoryLock(): AdvisoryLock {
  return {
    withLock: (_key, fn) => fn(),
    withSharedLock: (_key, fn) => fn(),
    tryWithLock: (_key, fn) => fn(),
  };
}

export function createNoopLeaderLease(): LeaderLease {
  return { hold: (_key, fn) => fn(new Promise<void>(() => {})) };
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
      const blobId = randomBytes(16).toString("hex");
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
