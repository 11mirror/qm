import type { Head } from "./late.ts";
import { type SandboxHandle, supportsProcessSessions } from "../sandbox/sandbox.ts";
import { finishProcessCredentials } from "../credentials/execute-files.ts";
import { type MonitorPoller, createMonitorPoller } from "../monitors/monitor-poller.ts";
import { createJobExitSweep, mailJobExit, type JobEnding } from "../processes/job-exit-mail.ts";
import type { ProcessRecord } from "../processes/process-registry.ts";
import type { RunsModule } from "./runs.ts";
import type { SessionSyscallsModule } from "./session-syscalls.ts";
import { createWebhookReceiver } from "../webhooks/webhook-receiver.ts";
import type { SandboxModule } from "./sandbox.ts";
import type { RunStreamsModule } from "./run-streams.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { CronsModule } from "./crons.ts";
import type { TriggersModule } from "./triggers.ts";
import type { StoresModule } from "./stores.ts";
import type { AppServicesModule } from "./app-services.ts";
import type { ApiAppModule } from "./api-app.ts";
import type { SchedulerModule } from "./scheduler.ts";

export function buildReceivers(
  w: Head &
    SandboxModule &
    RunStreamsModule &
    CredentialsModule &
    CronsModule &
    TriggersModule &
    StoresModule &
    AppServicesModule &
    ApiAppModule &
    SchedulerModule &
    RunsModule &
    SessionSyscallsModule,
) {
  const { sandbox, processes, keychain, admittedWork, monitors, triggerDeps, webhooks, jobs } = w;
  const { sessions, runs, sessionMailbox } = w;

  const finishCredentials = (handle: SandboxHandle, processId: string) =>
    finishProcessCredentials({ sandbox, processes: processes!, keychain }, handle, processId);
  const monitorPoller: MonitorPoller | null =
    processes && supportsProcessSessions(sandbox)
      ? createMonitorPoller({
          admittedWork,
          monitors,
          processes,
          sandbox,
          ...triggerDeps,
          onProcessExit: finishCredentials,
        })
      : null;
  const webhookReceiver = createWebhookReceiver({
    webhooks,
    ...triggerDeps,
    jobs,
  });
  const notifyJobExit = (rec: ProcessRecord, ending: JobEnding) =>
    mailJobExit({ sessions, runs, mailbox: sessionMailbox }, rec, ending);
  const jobExitSweep =
    processes && supportsProcessSessions(sandbox)
      ? createJobExitSweep({ processes, monitors, sandbox, notify: notifyJobExit, onExit: finishCredentials })
      : null;
  return { finishCredentials, monitorPoller, webhookReceiver, jobExitSweep, notifyJobExit };
}

export type ReceiversModule = ReturnType<typeof buildReceivers>;
