import { LRUCache } from "lru-cache";
import type { FileArtifact, FileArtifactStore } from "../files/file-artifact-store.ts";
import { isVisionAttachment, MAX_VISION_IMAGE_BYTES } from "../core/attachments.ts";
import { MAX_LLM_REQUEST_BYTES } from "../core/document-kinds.ts";
import { downscaleVisionImage } from "../core/image-downscale.ts";
import { collectBytes } from "../util/bytes.ts";
import { swallow } from "../util/errors.ts";
import { OMITTED_IMAGE_TEXT, type PiReplayMessage, type ReplayImageRef } from "./replay.ts";

const UNAVAILABLE_IMAGE_TEXT = "[image could not be loaded for replay]";

export const ELIDED_IMAGE_TEXT =
  "[image removed: this conversation's images no longer fit the model's request-size limit; ask for it to be re-shared if needed]";

type LoadedImage = { data: string; mimeType: string };
export type ReplayImageLoader = (ref: Required<ReplayImageRef>) => Promise<LoadedImage | "over-budget" | null>;

const visionBytes = new LRUCache<string, LoadedImage>({
  maxSize: 64_000_000,
  sizeCalculation: (image) => image.data.length,
});

export function artifactImageLoader(
  files: FileArtifactStore,
  authorize: (artifact: FileArtifact) => boolean | Promise<boolean>,
): ReplayImageLoader {
  return async (ref) => {
    const artifact = await files.get(ref.artifactId);
    if (
      !artifact ||
      !(await authorize(artifact)) ||
      !isVisionAttachment(artifact) ||
      artifact.sizeBytes <= 0 ||
      !artifact.sha256
    )
      return null;
    const key = `${artifact.id}:${artifact.sha256}`;
    const cached = visionBytes.get(key);
    if (cached !== undefined) return cached;
    const opened = await files.open(ref.artifactId);
    if (!opened) return null;
    if (opened.sizeBytes !== artifact.sizeBytes || opened.artifact.sha256 !== artifact.sha256) {
      opened.stream.destroy();
      return null;
    }
    const bytes = await collectBytes(opened.stream, { maxBytes: artifact.sizeBytes });
    if (bytes.sha256 !== artifact.sha256) return null;
    const scaled = await downscaleVisionImage(bytes.data, artifact.mimetype);
    if (scaled.bytes.length > MAX_VISION_IMAGE_BYTES) return "over-budget";
    const image = { data: Buffer.from(scaled.bytes).toString("base64"), mimeType: scaled.mimeType };
    visionBytes.set(key, image);
    return image;
  };
}

type ImageBlock = { type: "image"; data: string; mimeType: string };
type TextBlock = { type: "text"; text: string };

export async function restoreReplayImages(
  messages: PiReplayMessage[],
  load: ReplayImageLoader | undefined,
  requestByteBudget = MAX_LLM_REQUEST_BYTES,
): Promise<PiReplayMessage[]> {
  const restored = new Map<object, ImageBlock | TextBlock>();
  const cached = new Map<string, LoadedImage | "over-budget" | null>();
  let remainingBytes = requestByteBudget;
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    for (const block of [...message.content].reverse()) {
      if (block.type !== "image" || !("ref" in block)) continue;
      const { artifactId, mimeType } = block.ref;
      if (!artifactId || !load) {
        restored.set(block, { type: "text", text: OMITTED_IMAGE_TEXT });
        continue;
      }
      if (!cached.has(artifactId))
        cached.set(
          artifactId,
          remainingBytes > 0
            ? await load({ artifactId, mimeType }).catch((e: unknown) => {
                swallow("pi: replay image load", e);
                return null;
              })
            : "over-budget",
        );
      const loaded = cached.get(artifactId)!;
      if (loaded === "over-budget" || (loaded && loaded.data.length > remainingBytes))
        restored.set(block, { type: "text", text: ELIDED_IMAGE_TEXT });
      else if (!loaded) restored.set(block, { type: "text", text: UNAVAILABLE_IMAGE_TEXT });
      else {
        remainingBytes -= loaded.data.length;
        restored.set(block, { type: "image", data: loaded.data, mimeType: loaded.mimeType });
      }
    }
  }
  if (!restored.size) return messages;
  return messages.map((message) =>
    message.role === "user" && message.content.some((block) => restored.has(block))
      ? { ...message, content: message.content.map((block) => restored.get(block) ?? block) }
      : message,
  ) as PiReplayMessage[];
}
