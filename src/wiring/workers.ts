import type { Head } from "./late.ts";
import { type BackgroundOwnershipControl, createBackgroundOwnershipStore } from "../runs/background-ownership.ts";
import { randomUUID } from "node:crypto";
import {
  type InstanceRegistry,
  createPostgresInstanceRegistry,
  createNoopInstanceRegistry,
} from "../runs/instance-registry.ts";
import { type DrainController, createDrainController } from "../runs/drain.ts";
import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { TURN_READY_CHANNEL, TURN_CANCEL_CHANNEL, TURN_YIELD_CHANNEL } from "../turns/turn-ledger.ts";
import { createTurnRunner, RUN_MAX_CLAIMS } from "../turns/turn-runner.ts";
import { TURN_QUEUES } from "../turns/absurd-schema.ts";
import { type ProcessReaper, createProcessReaper, createReaperKillHook } from "../processes/process-reaper.ts";
import { supportsProcessSessions } from "../sandbox/sandbox.ts";
import { createJobComputerSweep } from "../processes/job-computers.ts";
import { errMessage } from "../util/errors.ts";
import { createComposioReturns } from "../connectors/composio-links.ts";
import type { StoresModule } from "./stores.ts";
import type { RunsModule } from "./runs.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { FilesModule } from "./files.ts";
import type { RunStreamsModule } from "./run-streams.ts";
import type { SandboxModule } from "./sandbox.ts";
import type { ReceiversModule } from "./receivers.ts";

export function buildWorkers(
  w: Head &
    StoresModule &
    RunsModule &
    OrchestratorModule &
    FilesModule &
    RunStreamsModule &
    SandboxModule &
    ReceiversModule,
) {
  const {
    config,
    gates,
    pgPool,
    turnLedger,
    late,
    databaseUrl,
    orchestrator,
    errors,
    processes,
    sandbox,
    sandboxResources,
    finishCredentials,
    notifyJobExit,
  } = w;

  const backgroundOwnership: BackgroundOwnershipControl | undefined = config.backgroundDeploymentId
    ? {
        store: createBackgroundOwnershipStore(databaseUrl),
        instanceId: randomUUID(),
        deploymentId: config.backgroundDeploymentId,
        active: () => gates.backgroundActive(),
      }
    : undefined;
  const instanceRegistry: InstanceRegistry =
    !backgroundOwnership && config.buildSha && config.backgroundWorkEnabled
      ? createPostgresInstanceRegistry(pgPool, {
          instanceId: randomUUID(),
          buildSha: config.buildSha,
          startedAt: Date.now(),
        })
      : createNoopInstanceRegistry();
  const drain: DrainController = createDrainController({ registry: instanceRegistry });
  const canClaimRuns = () => gates.backgroundAdmission() && drain.canClaim();
  const turnReady = createPostgresNotifyBus<string>(databaseUrl, TURN_READY_CHANNEL, "turn readiness");
  const turnCancels = createPostgresNotifyBus<string>(databaseUrl, TURN_CANCEL_CHANNEL, "turn cancels");
  const turnYields = createPostgresNotifyBus<string>(databaseUrl, TURN_YIELD_CHANNEL, "turn yields");
  const turnRunner = createTurnRunner({
    ledger: turnLedger,
    orchestrator,
    queues: TURN_QUEUES,
    slots: Math.max(1, config.workers),
    ready: turnReady,
    cancels: turnCancels,
    yields: turnYields,
    canClaim: canClaimRuns,
    errors,
    maxClaims: RUN_MAX_CLAIMS,
  });
  late.turnRunner = turnRunner;
  const processReaper: ProcessReaper | null = processes
    ? createProcessReaper(processes, {
        onReaped: (rec) => notifyJobExit(rec, { kind: "expired" }),
        ...(supportsProcessSessions(sandbox)
          ? {
              kill: createReaperKillHook(sandbox, { onExit: finishCredentials }),
              afterSweep: createJobComputerSweep({
                resources: sandboxResources,
                sandbox,
                processes,
                finish: finishCredentials,
                onError: (error, scopeId) =>
                  errors.record(
                    {
                      category: "process_session",
                      code: "job_computer_retire_failed",
                      message: errMessage(error),
                      scopeLabel: scopeId,
                    },
                    error,
                  ),
              }),
            }
          : {}),
      })
    : null;
  const composioReturns = createComposioReturns(databaseUrl);
  const deepIdleMachineMs = 3 * 24 * 60 * 60_000;
  const devIdleMachineMs = 2 * 60 * 60_000;
  const reapDeepIdle = deepIdleMachineMs > 0 || devIdleMachineMs > 0 ? sandbox.reapDeepIdle : undefined;
  return {
    processReaper,
    composioReturns,
    reapDeepIdle,
    deepIdleMachineMs,
    devIdleMachineMs,
    drain,
    turnRunner,
    turnReady,
    turnCancels,
    turnYields,
    backgroundOwnership,
  };
}

export type WorkersModule = ReturnType<typeof buildWorkers>;
