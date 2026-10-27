import type { Head } from "./late.ts";
import type { MemoryService } from "../memory/memory-service.ts";
import { createPostgresMemoryService } from "../memory/postgres-memory-service.ts";
import { createSemanticMemory } from "../memory/semantic-memory.ts";
import { withMemoryTidy } from "../memory/tidy.ts";
import { classifiedMemory } from "../memory/classification.ts";
import { createPerTurnStrategy } from "../memory/strategies/per-turn.ts";
import { errMessage } from "../util/errors.ts";
import type { StoresModule } from "./stores.ts";
import type { ModelKeysModule } from "./model-keys.ts";
import type { HarnessModule } from "./harness.ts";
import type { FilesModule } from "./files.ts";

export function buildMemory(w: Head & StoresModule & ModelKeysModule & HarnessModule & FilesModule) {
  const { databaseUrl, configStore, resolveMemoryEmbedder, late, harness, config, errors } = w;

  const notebookMemory: MemoryService = createPostgresMemoryService(databaseUrl);
  const semanticMemory = createSemanticMemory({
    notebook: notebookMemory,
    databaseUrl,
    embeddingModel: () => configStore.getEmbeddingModelDurable(),
    resolveEmbedder: (id) => resolveMemoryEmbedder(id),
  });
  const baseMemory: MemoryService = withMemoryTidy(semanticMemory.memory, (scope) => late.memoryTidy.ensure(scope));
  const memory = classifiedMemory(baseMemory, harness.models);
  const memoryStrategy = createPerTurnStrategy({
    harness: harness.models,
    memory,
    captureQuietMs: config.memoryCaptureQuietMs,
    databaseUrl,
    onCaptureError: (e, scope) =>
      errors.record({ category: "memory", code: "capture_failed", message: errMessage(e), scopeLabel: scope }, e),
  });
  return { memory, memoryStrategy, baseMemory, semanticMemory };
}

export type MemoryModule = ReturnType<typeof buildMemory>;
