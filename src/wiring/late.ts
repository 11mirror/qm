import type { Config } from "../config.ts";
import type { AppOverrides } from "../wiring.ts";
import type { AdmittedWork } from "../util/admitted-work.ts";
import type { Scheduler } from "../cron/scheduler.ts";
import type { App } from "../api/app.ts";
import type { createApprovalStore } from "../core/approval-store.ts";
import type { createMemoryTidyService } from "../memory/tidy.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import type { TurnRunner } from "../turns/turn-runner.ts";

export interface Late {
  scheduler: Scheduler;
  app: App;
  approvals: ReturnType<typeof createApprovalStore>;
  memoryTidy: ReturnType<typeof createMemoryTidyService>;
  processes: ProcessRegistry | undefined;
  turnRunner: TurnRunner;
}

export interface Gates {
  backgroundAdmission: () => boolean;
  backgroundActive: () => boolean;
  inlineShutdown: AbortController;
}

export interface Head {
  config: Config;
  overrides: AppOverrides;
  gates: Gates;
  admittedWork: AdmittedWork;
  late: Late;
  databaseUrl: string;
  connectorSecretKey: string;
}
