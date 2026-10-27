import type { Head } from "./late.ts";
import { supportsProcessSessions } from "../sandbox/sandbox.ts";
import { createPostgresProcessRegistry } from "../processes/process-registry.ts";
import { createPostgresAppPageViewLog } from "../deploy/page-views.ts";
import { createPostgresBrokerSessions } from "../auth/broker-sessions.ts";
import { createPostgresReplayDedupe } from "../auth/replay-dedupe.ts";
import { createPostgresCredentialUsageSink } from "../admin/postgres-credential-usage-sink.ts";
import { createPostgresEgressAuditSink } from "../admin/postgres-egress-audit-sink.ts";
import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { type RunStreamEvent, emitRunText, emitRunReasoning, reasoningKey } from "../runs/run-stream-events.ts";
import type { ContextRequestEvent } from "../api/app-types.ts";
import { createTurnStream } from "../runs/turn-stream.ts";
import { type RunActivityStore, createMemoryRunActivityStore } from "../runs/run-activity-store.ts";
import { createPostgresRunActivityStore } from "../runs/postgres-run-activity-store.ts";
import type { SandboxModule } from "./sandbox.ts";
import type { RunsModule } from "./runs.ts";
import type { HarnessModule } from "./harness.ts";

export function buildRunStreams(w: Head & SandboxModule & RunsModule & HarnessModule) {
  const { sandbox, databaseUrl, late, config, runs, runStoreKind } = w;

  const processes = supportsProcessSessions(sandbox) ? createPostgresProcessRegistry(databaseUrl) : undefined;
  late.processes = processes;
  const appPageViews = config.awsDeploy.appsDomain ? createPostgresAppPageViewLog(databaseUrl) : undefined;
  const brokerSessions = createPostgresBrokerSessions(databaseUrl);
  const replayDedupe = createPostgresReplayDedupe(databaseUrl);
  const credentialUsage = createPostgresCredentialUsageSink(databaseUrl);
  const egressAudit = createPostgresEgressAuditSink(databaseUrl);
  const runStreamEvents = createPostgresNotifyBus<RunStreamEvent>(databaseUrl, "run_stream", "run-stream");
  const contextRequestEvents = createPostgresNotifyBus<ContextRequestEvent>(
    databaseUrl,
    "context_request_events",
    "context requests",
  );
  const refreshRunStream = (runId: string): void => runStreamEvents.emit({ runId, kind: "refresh" });
  const turnStream = createTurnStream({
    onDelta: (runId, text, offset, startOffset) => emitRunText(runStreamEvents, runId, text, offset, startOffset),
    onReasoning: (runId, block, text, offset) => emitRunReasoning(runStreamEvents, runId, block, text, offset),
    onChange: refreshRunStream,
  });
  const stopStreamSync = runStreamEvents.subscribe((event) => {
    if (event.kind !== "sync") return;
    const text = turnStream.snapshot(event.runId);
    const startOffset = turnStream.startOffset(event.runId);
    const offset = Math.max(event.offset, startOffset);
    if (text) emitRunText(runStreamEvents, event.runId, text.slice(offset - startOffset), offset, startOffset);
    for (const block of turnStream.reasoning(event.runId)) {
      const sent = event.reasoning?.[reasoningKey(block)] ?? 0;
      if (block.text.length > sent) emitRunReasoning(runStreamEvents, event.runId, block, block.text.slice(sent), sent);
    }
  });
  runs.onTerminal((run) => refreshRunStream(run.id));
  const activityStore: RunActivityStore =
    runStoreKind === "postgres" ? createPostgresRunActivityStore(databaseUrl) : createMemoryRunActivityStore();
  const runActivity: RunActivityStore = {
    ...activityStore,
    async append(runId, entry) {
      await activityStore.append(runId, entry);
      refreshRunStream(runId);
    },
  };
  return {
    turnStream,
    runActivity,
    credentialUsage,
    processes,
    runStreamEvents,
    contextRequestEvents,
    stopStreamSync,
    egressAudit,
    replayDedupe,
    brokerSessions,
    appPageViews,
  };
}

export type RunStreamsModule = ReturnType<typeof buildRunStreams>;
