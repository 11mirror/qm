import type { App } from "../api/app.ts";
import type { createApprovalStore } from "../core/approval-store.ts";
import type { createMemoryTidyService } from "../memory/tidy.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";

/** Values buildApp creates after the modules that reach them through closures; assigned as soon as each exists. */
export interface Late {
  app: App;
  approvals: ReturnType<typeof createApprovalStore>;
  memoryTidy: ReturnType<typeof createMemoryTidyService>;
  processes: ProcessRegistry | undefined;
}
