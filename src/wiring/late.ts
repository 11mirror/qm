import type { ProcessRegistry } from "../processes/process-registry.ts";

/** Values buildApp creates after the modules that reach them through closures; assigned as soon as each exists. */
export interface Late {
  processes: ProcessRegistry | undefined;
}
