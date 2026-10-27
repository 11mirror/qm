import type { Head } from "./late.ts";
import { MONITOR_POLL_MS } from "../monitors/monitor-poller.ts";
import { PROCESS_REAPER_INTERVAL_MS } from "../processes/process-reaper.ts";
import { JOB_EXIT_POLL_MS } from "../processes/job-exit-mail.ts";
import { LLM_CAPTURE_RETENTION_MS } from "../sessions/session-store.ts";
import { isTerminal } from "../runs/run-store.ts";
import { swallowAs } from "../util/errors.ts";
import { sweepTurns } from "../turns/turn-engine.ts";
import type { SchedulerModule } from "./scheduler.ts";
import type { TriggersModule } from "./triggers.ts";
import type { CronsModule } from "./crons.ts";
import type { ReceiversModule } from "./receivers.ts";
import type { WorkersModule } from "./workers.ts";
import type { FilesModule } from "./files.ts";
import type { MemoryModule } from "./memory.ts";
import type { SlackCoreModule } from "./slack-core.ts";
import type { StoresModule } from "./stores.ts";
import type { ApiAppModule } from "./api-app.ts";
import type { HarnessModule } from "./harness.ts";
import type { RunsModule } from "./runs.ts";
import type { SessionReturnsModule } from "./session-returns.ts";
import type { AppServicesModule } from "./app-services.ts";
import type { OutboundModule } from "./outbound.ts";

export function registerEveryJobs(
  w: Head &
    SchedulerModule &
    TriggersModule &
    CronsModule &
    ReceiversModule &
    WorkersModule &
    FilesModule &
    MemoryModule &
    SlackCoreModule &
    StoresModule &
    ApiAppModule &
    HarnessModule &
    RunsModule &
    SessionReturnsModule &
    AppServicesModule &
    OutboundModule,
) {
  const {
    jobs,
    admittedWork,
    scheduler,
    sweepAsks,
    crons,
    monitorPoller,
    jobExitSweep,
    processReaper,
    fileUploads,
    semanticMemory,
    slackCore,
    slackHandledEvents,
    monitors,
    memoryStrategy,
    sessions,
    blobTransfer,
    composioReturns,
    app,
    reapDeepIdle,
    deepIdleMachineMs,
    devIdleMachineMs,
    config,
    runSignals,
    runs,
    sweepSessionReturns,
    sweepMailWakes,
    runResultRecovery,
    outbound,
    approvals,
    turnLedger,
    errors,
  } = w;

  const every = (name: string, everyMs: number, fn: () => unknown, opts?: { immediate?: boolean }) =>
    jobs.every(name, everyMs, () => admittedWork.run(fn), opts);
  every("cron:repair", 60_000, () => scheduler.repair(), { immediate: true });
  every("cron:asks", 5_000, () => sweepAsks(Date.now()));
  every("cron:stranded-fires", 10 * 60_000, async () => {
    const swept = await crons.sweepStrandedFires(Date.now());
    if (swept > 0) console.warn(`[scheduler] closed ${swept} stranded running fire(s) as failed`);
  });
  every("cron:fire-gc", 6 * 60 * 60_000, async () => {
    const pruned = await crons.pruneFires(Date.now());
    if (pruned > 0) console.log(`[scheduler] pruned ${pruned} old cron fire row(s)`);
  });
  if (monitorPoller) every("monitor:poll", MONITOR_POLL_MS, () => monitorPoller.tick());
  if (jobExitSweep) every("processes:exit-mail", JOB_EXIT_POLL_MS, () => jobExitSweep.tick());
  if (processReaper) every("processes:reaper", PROCESS_REAPER_INTERVAL_MS, () => processReaper.sweep());
  if (fileUploads) every("file-uploads", 60_000, () => fileUploads.sweep(), { immediate: true });
  every("memory-vector-index", 30_000, () => semanticMemory.index(), { immediate: true });
  every("slack:envelope-replay", 60_000, () => slackCore.upkeep.run("replayEnvelopes"));
  every("slack:session-status", 60_000, () => slackCore.upkeep.run("reconcileStatus"));
  every("slack:task-acks", 60_000, () => slackCore.upkeep.run("reconcileTaskAcks"));
  every("slack:emoji-catalog", 6 * 60 * 60_000, () => slackCore.upkeep.run("publishEmojiCatalog"));
  const handledEventCutoff = () => Date.now() - 24 * 60 * 60_000;
  every("slack:handled-events", 60 * 60_000, () => slackHandledEvents.deleteBefore(handledEventCutoff()));
  every("monitor:retention:sweep", 24 * 60 * 60_000, () => monitors.deleteDefunct(Date.now()), { immediate: true });
  every("memory:capture-sweep", 60_000, () => memoryStrategy.sweep());
  every("spend:refresh", 60_000, () => sessions.refreshSpendRollup(), { immediate: true });
  every("llm-capture:retention", 5 * 60_000, async () => {
    const purged = await sessions.purgeLlmCaptures(Date.now() - LLM_CAPTURE_RETENTION_MS, {
      deadline: Date.now() + 30_000,
    });
    if (purged) console.log(`[llm-capture] purged ${purged} prompt envelope(s) past retention`);
  });
  every("blob-transfer", 30 * 60_000, () => blobTransfer.sweep(6 * 60 * 60_000));
  every("Composio consent returns", 30 * 60_000, () => composioReturns.deleteExpired(Date.now()), {
    immediate: true,
  });
  every("deploy-maintenance", 5 * 60_000, () => app.maintainDeployments());
  if (reapDeepIdle)
    every("sandbox:deep-idle-reaper", 5 * 60_000, () => reapDeepIdle(deepIdleMachineMs, devIdleMachineMs), {
      immediate: true,
    });
  every("orphaned-signals", config.reaperIntervalMs, async () => {
    for (const runId of await runSignals.pendingRunIds()) {
      const run = await runs.get(runId);
      if (!run || isTerminal(run.status))
        await app.replayOrphanedRunSignals(runId).catch(swallowAs("sessions: recover signal", undefined));
    }
  });
  every("run-signals:prune", 60 * 60_000, () => runSignals.prune(7 * 24 * 60 * 60_000));
  every("session-return-sweep", 1_000, sweepSessionReturns);
  every("session-mail-wake-sweep", 10_000, sweepMailWakes);
  every("run-result-sweep", 60_000, () => runResultRecovery.sweep());
  every("queued-post-retry", 30_000, () => outbound.retryQueued());
  every("approval-deliveries", 30_000, () => approvals.deliverPending(), { immediate: true });
  every("turns:pointer-repair", 60_000, () => sweepTurns({ ledger: turnLedger, sessions, errors }), {
    immediate: true,
  });
  every("turns:cleanup", 60 * 60_000, () => turnLedger.cleanup());
}
