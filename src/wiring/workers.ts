import type { Head } from "./late.ts";
import {
  type BackgroundOwnershipControl,
  createBackgroundOwnershipStore,
  type BackgroundOwnership,
} from "../runs/background-ownership.ts";
import { randomUUID } from "node:crypto";
import {
  type InstanceRegistry,
  createPostgresInstanceRegistry,
  createNoopInstanceRegistry,
} from "../runs/instance-registry.ts";
import { type DrainController, createDrainController } from "../runs/drain.ts";
import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { TURN_READY_CHANNEL, TURN_CANCEL_CHANNEL, TURN_YIELD_CHANNEL } from "../turns/turn-ledger.ts";
import { type TurnRunner, createTurnRunner } from "../turns/turn-runner.ts";
import { TURN_QUEUES } from "../turns/absurd-schema.ts";
import { RUN_MAX_CLAIMS, type Worker, createWorker, createRunPreemption } from "../runs/worker.ts";
import { type ProcessReaper, createProcessReaper, createReaperKillHook } from "../processes/process-reaper.ts";
import { supportsProcessSessions } from "../sandbox/sandbox.ts";
import type { ComposioReturn } from "../api/routes/composio.ts";
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
    artifactMap,
    gates,
    pgArtifactMap,
    turnLedger,
    databaseUrl,
    orchestrator,
    errors,
    admittedWork,
    runs,
    leaseTtlMs,
    createSweeper,
    processes,
    sandbox,
    finishCredentials,
  } = w;

  const backgroundOwnership: BackgroundOwnershipControl | undefined = config.backgroundDeploymentId
    ? {
        store: createBackgroundOwnershipStore(artifactMap<BackgroundOwnership>("background_ownership")),
        instanceId: randomUUID(),
        deploymentId: config.backgroundDeploymentId,
        active: () => gates.backgroundActive(),
      }
    : undefined;
  const instanceRegistry: InstanceRegistry =
    !backgroundOwnership && config.buildSha && config.backgroundWorkEnabled
      ? createPostgresInstanceRegistry(pgArtifactMap.pool, {
          instanceId: randomUUID(),
          buildSha: config.buildSha,
          startedAt: Date.now(),
        })
      : createNoopInstanceRegistry();
  const drain: DrainController = createDrainController({ registry: instanceRegistry });
  const canClaimRuns = () => gates.backgroundAdmission() && drain.canClaim();
  const turnReady = turnLedger
    ? createPostgresNotifyBus<string>(databaseUrl, TURN_READY_CHANNEL, "turn readiness")
    : undefined;
  const turnCancels = turnLedger
    ? createPostgresNotifyBus<string>(databaseUrl, TURN_CANCEL_CHANNEL, "turn cancels")
    : undefined;
  const turnYields = turnLedger
    ? createPostgresNotifyBus<string>(databaseUrl, TURN_YIELD_CHANNEL, "turn yields")
    : undefined;
  const turnRunner: TurnRunner | undefined = turnLedger
    ? createTurnRunner({
        ledger: turnLedger,
        orchestrator,
        queues: TURN_QUEUES,
        slots: Math.max(1, config.workers),
        capacity: () => Math.max(1, config.workers) - workers.filter((worker) => worker.held()).length,
        ...(turnReady ? { ready: turnReady } : {}),
        ...(turnCancels ? { cancels: turnCancels } : {}),
        ...(turnYields ? { yields: turnYields } : {}),
        canClaim: canClaimRuns,
        errors,
        maxClaims: RUN_MAX_CLAIMS,
      })
    : undefined;
  const busyRuns = () => workers.filter((worker) => worker.held()).length + (turnRunner?.held().length ?? 0);
  const canClaimRunSlot = () => canClaimRuns() && busyRuns() < Math.max(1, config.workers);
  const workers: Worker[] = Array.from({ length: Math.max(1, config.workers) }, () =>
    createWorker({
      admittedWork,
      runs,
      orchestrator,
      leaseTtlMs,
      errors,
      pollMs: 250,
      canClaim: canClaimRunSlot,
    }),
  );
  const preemption = createRunPreemption({ runs, workers, canClaim: canClaimRuns });
  const preemptionSweeper = createSweeper(() => preemption.sweep(), 1_000, { label: "run-preemption" });
  const processReaper: ProcessReaper | null = processes
    ? createProcessReaper(processes, {
        ...(supportsProcessSessions(sandbox)
          ? { kill: createReaperKillHook(sandbox, { onExit: finishCredentials }) }
          : {}),
      })
    : null;
  const composioReturns = artifactMap<ComposioReturn>("composio_returns");
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
    workers,
    preemptionSweeper,
    turnRunner,
    turnReady,
    turnCancels,
    turnYields,
    backgroundOwnership,
  };
}

export type WorkersModule = ReturnType<typeof buildWorkers>;
