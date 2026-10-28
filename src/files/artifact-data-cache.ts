import { LRUCache } from "lru-cache";
import type { FileArtifact } from "./file-artifact-store.ts";
import { tenant } from "../tenant.ts";

type VerifiedData = string | { data: string; mimeType: string };
const verifiedData = new LRUCache<string, VerifiedData>({
  maxSize: 64_000_000,
  sizeCalculation: (data) => (typeof data === "string" ? data.length : data.data.length) || 1,
});

export async function cachedArtifactData<T extends VerifiedData>(
  use: "document" | "vision",
  artifact: Pick<FileArtifact, "id" | "sha256" | "ownerScopeId" | "sizeBytes" | "mimetype">,
  load: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const current = tenant();
  const key = JSON.stringify([
    current.id ?? current.orgId,
    use,
    artifact.id,
    artifact.sha256,
    artifact.ownerScopeId,
    artifact.sizeBytes,
    artifact.mimetype,
  ]);
  const cached = verifiedData.get(key);
  if (cached !== undefined) return cached as T;
  const data = await load();
  if (data !== undefined) verifiedData.set(key, data);
  return data;
}
