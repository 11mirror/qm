import { createInboxRealtime } from "../inbox/realtime.ts";
import { createKeychainApprovals } from "../credentials/keychain-approval.ts";
import type { HandledEvent } from "../slack/message-gating.ts";
import { createSlackCoreClient } from "../api/slack-core-client.ts";
import type { TaskAckState } from "../slack/task-ack.ts";
import type { SlackSessionStatusState } from "../slack/session-status.ts";
import type { StagedEnvelope } from "../slack/envelope-staging.ts";
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
import type { Config } from "../config.ts";
import type { HarnessModule } from "./harness.ts";
import type { FilesModule } from "./files.ts";
import type { RunsModule } from "./runs.ts";
import type { AppServicesModule } from "./app-services.ts";

export function buildSlackCore(
  w: Pick<CronsModule, "crons" | "inboxItems" | "recordInboxEvent" | "monitors"> &
    Pick<CredentialsModule, "keychain"> &
    Pick<ApiAppModule, "app"> &
    Pick<StoresModule, "identity" | "sessions" | "artifactMap" | "featureFlags" | "leaderLease" | "configStore"> &
    Pick<DeploymentLayerModule, "auditLog"> &
    Pick<OutboundModule, "outbound" | "slackSurface"> &
    Pick<TriggersModule, "askResolution"> &
    Pick<MemoryModule, "memory"> &
    Pick<OrchestratorModule, "surfaceCache"> &
    Pick<RunStreamsModule, "processes" | "turnStream"> &
    Pick<HarnessModule, "fallback" | "harness"> &
    Pick<FilesModule, "blobTransfer" | "errors"> &
    Pick<RunsModule, "runs"> &
    Pick<AppServicesModule, "ackEmojiPicks"> & { config: Config },
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
    artifactMap,
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
  const slackHandledEvents = artifactMap<HandledEvent>("slack_handled_events");
  const slackCore = createSlackCoreClient({
    identity,
    memory,
    ...(keychainApprovals ? { keychainApprovals } : {}),
    surfaceCache,
    taskAcknowledgements: artifactMap<TaskAckState>("slack_task_acknowledgements"),
    sessionStatus: artifactMap<SlackSessionStatusState>("slack_session_status"),
    statusActivity: { processes, monitors, sessions, publicWebUrl: config.publicWebUrl },
    featureFlags,
    inboxEvent: (event) => inboxRealtime.onConversationEvent(event),
    app,
    leaderLease,
    stagedEnvelopes: artifactMap<StagedEnvelope>("slack_staged_envelopes"),
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
