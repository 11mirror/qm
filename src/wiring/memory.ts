import type { MemoryService } from "../memory/memory-service.ts";
import { createPostgresMemoryService } from "../memory/postgres-memory-service.ts";
import { createSemanticMemory } from "../memory/semantic-memory.ts";
import { withMemoryTidy } from "../memory/tidy.ts";
import { classifiedMemory } from "../memory/classification.ts";
import { createPerTurnStrategy, type PendingCapture } from "../memory/strategies/per-turn.ts";
import { errMessage } from "../util/errors.ts";
import type { Config } from "../config.ts";
import type { createSweeper as createUntrackedSweeper } from "../util/sweeper.ts";
import type { Stores } from "./stores.ts";
import type { Files } from "./files.ts";
import type { ModelKeys } from "./model-keys.ts";
import type { HarnessModule } from "./harness.ts";
import type { Late } from "./late.ts";

export function buildMemory(
  w: Pick<Stores, "configStore" | "leaderLease" | "artifactMap"> &
    Pick<Files, "errors"> &
    Pick<ModelKeys, "resolveMemoryEmbedder"> &
    Pick<HarnessModule, "harness"> & {
      config: Config;
      databaseUrl: string;
      createSweeper: typeof createUntrackedSweeper;
      late: Late;
    },
) {
  const {
    databaseUrl,
    configStore,
    resolveMemoryEmbedder,
    leaderLease,
    createSweeper,
    late,
    harness,
    config,
    artifactMap,
    errors,
  } = w;

  const notebookMemory: MemoryService = createPostgresMemoryService(databaseUrl);
  const semanticMemory = createSemanticMemory({
    notebook: notebookMemory,
    databaseUrl,
    embeddingModel: () => configStore.getEmbeddingModelDurable(),
    resolveEmbedder: (id) => resolveMemoryEmbedder(id),
    leaderLease,
    createSweeper,
  });
  const baseMemory: MemoryService = withMemoryTidy(semanticMemory.memory, (scope) => late.memoryTidy.ensure(scope));
  const memory = classifiedMemory(baseMemory, harness.models);
  const memoryStrategy = createPerTurnStrategy({
    harness: harness.models,
    memory,
    captureQuietMs: config.memoryCaptureQuietMs,
    pending: artifactMap<PendingCapture>("memory_capture_pending"),
    onCaptureError: (e, scope) =>
      errors.record({ category: "memory", code: "capture_failed", message: errMessage(e), scopeLabel: scope }, e),
  });
  return { memory, memoryStrategy, baseMemory, semanticMemory };
}

export type MemoryModule = ReturnType<typeof buildMemory>;
