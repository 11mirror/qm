import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import { createFinnyRunStore, type FinnyRunV2Checkpoint } from "../../src/finny/run-store.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";

export function finnyTestStores() {
  return {
    finnyEvidenceBytes: createMemoryDurableByteStore(),
    finnyRunStore: createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>()),
  };
}
