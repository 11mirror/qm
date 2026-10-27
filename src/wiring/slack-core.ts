import type { Head } from "./late.ts";
import { createStagedEnvelopes } from "../slack/envelope-staging.ts";
import { createSessionStatusStore } from "../slack/session-status.ts";
import { createTaskAckStore } from "../slack/task-ack.ts";
import { createHandledEvents } from "../slack/message-gating.ts";
import { createInboxRealtime } from "../inbox/realtime.ts";
import { createKeychainApprovals } from "../credentials/keychain-approval.ts";
import { createSlackCoreClient } from "../api/slack-core-client.ts";
import { auxiliaryModelForProvider } from "../model/pi-models.ts";
import type { CronsModule } from "./crons.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { ApiAppModule } from "./api-app.ts";
import type { StoresModule } from "./stores.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { OutboundModule } from "./outbound.ts";
import type { TriggersModule } from "./triggers.ts";
import type { MemoryModule } from "./memory.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { RunStreamsModule } from "./run-streams.ts";
import type { HarnessModule } from "./harness.ts";
import type { FilesModule } from "./files.ts";
import type { RunsModule } from "./runs.ts";
import type { AppServicesModule } from "./app-services.ts";

export function buildSlackCore(
  w: Head &
    CronsModule &
    CredentialsModule &
    ApiAppModule &
    StoresModule &
    DeploymentLayerModule &
    OutboundModule &
    TriggersModule &
    MemoryModule &
    OrchestratorModule &
    RunStreamsModule &
    HarnessModule &
    FilesModule &
    RunsModule &
    AppServicesModule,
) {
  const {
    crons,
    inboxItems,
    recordInboxEvent,
    keychain,
    app,
    identity,
    sessions,
    auditLog,
    outbound,
    askResolution,
    memory,
    surfaceCache,
    processes,
    monitors,
    config,
    featureFlags,
    leaderLease,
    configStore,
    fallback,
    blobTransfer,
    slackSurface,
    errors,
    runs,
    turnStream,
    ackEmojiPicks,
    harness,
    databaseUrl,
  } = w;

  const inboxRealtime = createInboxRealtime({
    crons,
    items: inboxItems,
    record: recordInboxEvent,
  });
  const keychainApprovals = createKeychainApprovals({
    keychain,
    app,
    identity,
    sessions,
    audit: auditLog,
    outbound,
    resume: (ask, grant) => askResolution(ask, grant),
  });
  const slackHandledEvents = createHandledEvents(databaseUrl);
  const slackCore = createSlackCoreClient({
    identity,
    memory,
    ...(keychainApprovals ? { keychainApprovals } : {}),
    surfaceCache,
    taskAcknowledgements: createTaskAckStore(databaseUrl),
    sessionStatus: createSessionStatusStore(databaseUrl),
    statusActivity: { processes, monitors, sessions, publicWebUrl: config.publicWebUrl },
    featureFlags,
    inboxEvent: (event) => inboxRealtime.onConversationEvent(event),
    app,
    leaderLease,
    stagedEnvelopes: createStagedEnvelopes(databaseUrl),
    handledEvents: slackHandledEvents,
    config: configStore,
    runtimeFallback: fallback,
    blobTransfer,
    slack: slackSurface.slack,
    errors,
    runs,
    turnStream,
    ackPicks: ackEmojiPicks,
    ackModelId: () => auxiliaryModelForProvider("anthropic"),
    ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
    ...(harness.models.pickAckEmoji ? { pickAckEmoji: (t, c) => harness.models.pickAckEmoji!(t, c) } : {}),
  });
  return { slackCore, slackHandledEvents, keychainApprovals };
}

export type SlackCoreModule = ReturnType<typeof buildSlackCore>;
