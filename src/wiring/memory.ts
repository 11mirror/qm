import type { MemoryService } from "../memory/memory-service.ts";
import { createPostgresMemoryService } from "../memory/postgres-memory-service.ts";
import { createSemanticMemory } from "../memory/semantic-memory.ts";
import { withMemoryTidy } from "../memory/tidy.ts";
import type { createSweeper as createUntrackedSweeper } from "../util/sweeper.ts";
import type { Stores } from "./stores.ts";
import type { ModelKeys } from "./model-keys.ts";
import type { Late } from "./late.ts";

export function buildMemory(
  w: Pick<Stores, "configStore" | "leaderLease"> &
    Pick<ModelKeys, "resolveMemoryEmbedder"> & {
      databaseUrl: string;
      createSweeper: typeof createUntrackedSweeper;
      late: Late;
    },
) {
  const { databaseUrl, configStore, resolveMemoryEmbedder, leaderLease, createSweeper, late } = w;

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
  return { baseMemory, semanticMemory };
}
