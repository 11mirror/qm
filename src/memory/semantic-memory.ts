import type { MemoryEmbedder } from "../model/embeddings.ts";
import { reportFailure } from "../util/errors.ts";
import type { MemoryService } from "./memory-service.ts";
import { createPostgresVectorStore, type MemoryVectorStore } from "./postgres-vector-store.ts";
import { createSemanticMemoryService } from "./semantic-recall.ts";
import { createMemoryVectorIndexer } from "./vector-indexer.ts";

export function createSemanticMemory(opts: {
  notebook: MemoryService;
  databaseUrl: string | undefined;
  embeddingModel: () => Promise<string | null | undefined>;
  resolveEmbedder: (id: string) => Promise<MemoryEmbedder>;
}) {
  const { databaseUrl } = opts;
  if (!databaseUrl)
    return {
      memory: opts.notebook,
      async index() {},
      async stop() {},
      async close() {},
    };
  let store: MemoryVectorStore | undefined;
  const resolve = async () => {
    const id = await opts.embeddingModel();
    if (!id) return undefined;
    const embedder = await opts.resolveEmbedder(id);
    store ??= createPostgresVectorStore(databaseUrl);
    return { embedder, store };
  };
  const memory = createSemanticMemoryService(
    opts.notebook,
    async () => (await resolve())?.embedder,
    { search: (input) => store!.search(input) },
    { onError: (error) => reportFailure("memory semantic recall; using recent facts", error) },
  );
  const indexer = createMemoryVectorIndexer({ resolve });
  return {
    memory,
    index: () => indexer.tick(),
    stop: () => indexer.stop(),
    async close() {
      await store?.close();
      store = undefined;
    },
  };
}
