import type { Head } from "./late.ts";
import { type AwsRoleBroker, createAwsRoleBroker } from "../auth/aws-role-broker.ts";
import type { BrokeredLayerTool } from "../deployment/load-layer.ts";
import type { RunStore } from "../runs/run-store.ts";
import { rosterAdmits } from "../resolution/scope-membership.ts";
import { createSessionMailbox } from "../sessions/session-mailbox.ts";
import { createSessionSyscalls } from "../subagents/session-tools.ts";
import { createMailWaker } from "../subagents/mail-wake.ts";
import { createPostgresSwarmBoard } from "../swarms/swarm-board.ts";
import { scopeId } from "../types.ts";
import { startSession } from "../api/start-session.ts";
import { resolveRuntimeChoiceDurable } from "../harness/runtime-choice.ts";
import { createUiStateStore } from "../surfaces/ui-state.ts";
import type { FilesModule } from "./files.ts";
import type { StoresModule } from "./stores.ts";
import type { RunsModule } from "./runs.ts";
import type { HarnessModule } from "./harness.ts";

export function buildSessionSyscalls(w: Head & FilesModule & StoresModule & RunsModule & HarnessModule) {
  const {
    config,
    overrides,
    resolution,
    canWriteScope,
    projects,
    currentScopeMembers,
    databaseUrl,
    featureFlags,
    sessions,
    runs,
    runSignals,
    maxAttempts,
    advisoryLock,
    late,
    configStore,
    runtimeOrgScope,
    fallback,
    hydrateModelCatalog,
  } = w;

  const layerEnv = config.layerEnv ?? {};
  const layerBrokerCache = new Map<string, AwsRoleBroker>();
  const layerBrokerFor = (tool: BrokeredLayerTool): AwsRoleBroker | undefined => {
    const override = overrides.credentialBrokers?.[tool.service];
    if (override) return override;
    const roleArn = layerEnv[tool.broker.roleArnEnv];
    if (!roleArn) return undefined;
    const region = (tool.broker.regionEnv ? layerEnv[tool.broker.regionEnv] : undefined) ?? tool.broker.region;
    if (!region) return undefined;
    const key = JSON.stringify([roleArn, region, tool.broker.sessionActions]);
    let broker = layerBrokerCache.get(key);
    if (!broker) {
      broker = createAwsRoleBroker({ roleArn, region, sessionActions: tool.broker.sessionActions });
      layerBrokerCache.set(key, broker);
    }
    return broker;
  };
  const prepareSessionRequest = async (request: Parameters<RunStore["enqueue"]>[0]["request"]) => {
    const scope = resolution.scopeFor(request.conversation, request.actor);
    if (!(await canWriteScope(request.actor.id, scope))) throw new Error("session actor no longer has scope access");
    const ref = request.conversation.channelRef;
    if (request.conversation.kind !== "group" || !ref || !projects.recognizes(ref)) return request;
    const version = await projects.version(ref);
    const audience = await currentScopeMembers(scope);
    if (
      !version ||
      !audience ||
      !rosterAdmits(
        audience.map((p) => p.id),
        request.actor.id,
        scope,
      )
    )
      throw new Error("session owner is no longer a member of this project");
    return {
      ...request,
      scopeVersion: version,
      sessionParticipantIds: audience.map((p) => p.id),
      conversation: { ...request.conversation, audience, publishMembers: audience },
    };
  };
  const sessionMailbox = createSessionMailbox(databaseUrl);
  const mailWaker = createMailWaker({
    mailbox: sessionMailbox,
    sessions,
    runs,
    lock: advisoryLock,
    maxAttempts,
    prepareRequest: prepareSessionRequest,
    delegationEnabled: (actorId) => featureFlags.enabled("responsive_spine", scopeId("personal", actorId)),
    authorize: (session, actorId) => canWriteScope(actorId, session.scopeId),
  });
  sessionMailbox.onDelivered(mailWaker.wake);
  const sessionSyscalls = createSessionSyscalls({
    mailbox: sessionMailbox,
    board: createPostgresSwarmBoard(databaseUrl),
    enabled: async (actorId) =>
      (await featureFlags.enabled("persistent_subagents", scopeId("personal", actorId))) ||
      (await featureFlags.enabled("responsive_spine", scopeId("personal", actorId))),
    sessions,
    runs,
    signals: runSignals,
    maxAttempts,
    advisoryLock,
    prepareRequest: prepareSessionRequest,
    authorize: (session, actorId) => canWriteScope(actorId, session.scopeId),
    conversations: {
      search: ({ query, principals, limit }) => late.app.searchConversations(query, principals, limit),
      list: (actorId) => late.app.listSessions(actorId),
      start: (actorId, input) => startSession(late.app, sessions, actorId, input),
    },
    async validateRuntime(input, scope) {
      await resolveRuntimeChoiceDurable(
        configStore,
        runtimeOrgScope,
        scope,
        fallback,
        {
          ...(input.model ? { modelId: input.model } : {}),
          ...(input.thinkingLevel ? { effortLevel: input.thinkingLevel } : {}),
          ...(typeof input.fastMode === "boolean" ? { fastMode: input.fastMode } : {}),
        },
        hydrateModelCatalog,
        "subagent",
      );
    },
  });
  const uiState = createUiStateStore(databaseUrl);
  return { uiState, sessionSyscalls, layerBrokerFor, sessionMailbox, mailWaker, prepareSessionRequest };
}

export type SessionSyscallsModule = ReturnType<typeof buildSessionSyscalls>;
