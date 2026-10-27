import { surfaceHas } from "../surfaces/surface.ts";
import { UNTRACKED_PROVENANCE } from "../memory/facts.ts";
import { type ScopeId, type TurnResult } from "../types.ts";
import type { DirectoryStore, DirectoryChannel, DirectoryMember } from "../directory/directory-store.ts";
import type { GapPhase } from "../sessions/session-store.ts";
import { isOverheard, isUserMessage, type Item } from "../sessions/items.ts";
import type { GapWork } from "../harness/harness.ts";
import { securityScreenPayload } from "../security/security-screen.ts";
import { createPerTurnStrategy } from "../memory/strategies/per-turn.ts";
import { DEFAULT_MEMORY_POLICY } from "../memory/policy.ts";
import { createTranscriptSource } from "../sessions/transcript-source.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import { personKey } from "../directory/person.ts";
import { LRUCache } from "lru-cache";
import type { Orchestrator, OrchestratorDeps, OrchestratorInput } from "./orchestrator/types.ts";
import { admitTurn } from "./orchestrator/admit.ts";
import { holdTurnLease } from "./orchestrator/turn-lease.ts";
import { openTurnSession, resolveTurnScope, resolveTurnWorkspace } from "./orchestrator/turn-context.ts";
import { observeInboundTurn } from "./orchestrator/inbound-screen.ts";
import { buildCredentialCatalog } from "./orchestrator/credential-catalog.ts";
import { frameTurnPrompt } from "./orchestrator/turn-prompt.ts";
import { concludeTurn, mapTurnFailure, settleTurnResult } from "./orchestrator/settle.ts";
import { detectAmbientDecline, findRecordedTurn, replayRecordedAnswer } from "./orchestrator/turn-replay.ts";
import { openTurnSandboxes } from "./orchestrator/turn-sandboxes.ts";
import { finishSystemPrompt } from "./orchestrator/turn-prompt.ts";
import { buildTurnTools, firstAckPublisher } from "./orchestrator/turn-tools.ts";
import { prepareTurnInput, turnFailureUserItem } from "./orchestrator/turn-input.ts";
import { selectTurnRuntime } from "./orchestrator/turn-runtime.ts";
import { createHarnessSegment, runSegments, type TurnRunState } from "./orchestrator/turn-segment.ts";
import { consumeApprovalDecision, loadApprovalLedger } from "./orchestrator/approvals.ts";
import { createSessionTitles } from "./session-title.ts";
import { renderTitleTranscript, visibleTitleItemText } from "./orchestrator/turn-helpers.ts";
import { createCompaction } from "./orchestrator/compaction.ts";
import { createSecurityObserver } from "./orchestrator/security-screen.ts";

export { egressClaimAllowingControlPlane, filterConnectorSkills } from "./orchestrator/turn-helpers.ts";
export type { Orchestrator, OrchestratorDeps, OrchestratorInput, SurfaceContextPuller } from "./orchestrator/types.ts";

const MIN_SESSION_LEASE_TTL_MS = 15_000;

const INSTANCE_CACHE_MAX_ENTRIES = 5_000;
const DIRECTORY_INDEX_CACHE_MAX_ENTRIES = 100;

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  if (deps.sessions.leaseTtlMs < MIN_SESSION_LEASE_TTL_MS) {
    throw new Error(
      `session lease TTL ${deps.sessions.leaseTtlMs}ms is below the ${MIN_SESSION_LEASE_TTL_MS}ms floor the turn keepalive needs`,
    );
  }
  const transcripts = createTranscriptSource(deps.sessions);
  const memoryPolicy = deps.memoryPolicy ?? DEFAULT_MEMORY_POLICY;
  const memoryStrategy =
    deps.memoryStrategy ?? createPerTurnStrategy({ harness: deps.harness.models, memory: deps.memory });
  const blobTransfer = deps.blobTransfer;

  const pendingCaptures = new Map<ScopeId, Promise<void>>();

  const REACH_ROSTER_TTL_MS = 5 * 60_000;
  const reachRosterCache = new LRUCache<string, DirectoryChannel[]>({
    max: INSTANCE_CACHE_MAX_ENTRIES,
    ttl: REACH_ROSTER_TTL_MS,
  });
  async function reachableChannelsFor(directory: DirectoryStore, principalId: string): Promise<DirectoryChannel[]> {
    const cached = reachRosterCache.get(principalId);
    if (cached) return cached;
    const channels = await directory.listChannelsFor(principalId);
    reachRosterCache.set(principalId, channels);
    return channels;
  }

  const DIRECTORY_INDEX_TTL_MS = REACH_ROSTER_TTL_MS;
  const directoryIndexCache = new LRUCache<string, Map<string, DirectoryMember>>({
    max: DIRECTORY_INDEX_CACHE_MAX_ENTRIES,
    ttl: DIRECTORY_INDEX_TTL_MS,
  });
  async function directoryIndexFor(directory: DirectoryStore): Promise<Map<string, DirectoryMember>> {
    const cached = directoryIndexCache.get("org");
    if (cached) return cached;
    const byId = new Map<string, DirectoryMember>();
    for (const m of await directory.list()) byId.set(personKey(m.principalId), m);
    directoryIndexCache.set("org", byId);
    return byId;
  }

  const { compactContextIfNeeded, compactRecent, scheduleBackgroundCompaction, documentTokenBudget } =
    createCompaction(deps);

  const observeSecurityData = createSecurityObserver(deps);

  const titles = createSessionTitles({
    sessions: deps.sessions,
    harness: deps.harness,
    ...(deps.sessionStateBus ? { sessionStateBus: deps.sessionStateBus } : {}),
    ...(deps.errors ? { errors: deps.errors } : {}),
  });

  const orchestrator: Orchestrator = {
    observeSecuritySteer({ payload, actor, conversation, sessionId }) {
      const bounded = securityScreenPayload({
        surface: "external",
        text: "",
        origin: { kind: "automation", screenData: payload },
      });
      if (!bounded || bounded.truncated) return;
      void observeSecurityData(bounded.content, actor.id, deps.resolution.scopeFor(conversation, actor), {
        hook: "user_input",
        surface: "steer",
        origin: "ambient",
        thread: conversation.threadRef,
        ...(sessionId ? { sessionId } : {}),
      });
    },

    async regenerateTitle(sessionId, principalId, participantIds) {
      const session = await deps.sessions.get(sessionId);
      if (!session) return null;
      let entries = (await transcripts.forViewer(sessionId, principalId)).items;
      if (participantIds?.length) {
        const views = await Promise.all(
          participantIds.map(async (memberId) => (await transcripts.forViewer(sessionId, memberId)).items),
        );
        const common = new Set(views[0]!.map((entry) => entry.seq));
        for (const view of views.slice(1)) {
          const visible = new Set(view.map((entry) => entry.seq));
          for (const seq of common) if (!visible.has(seq)) common.delete(seq);
        }
        entries = entries.filter((entry) => common.has(entry.seq));
      }
      if (entries.length === 0) return null;
      const transcript = renderTitleTranscript(entries);
      const fallbackEntry = entries.find((entry) => isUserMessage(entry) && !isOverheard(entry));
      const title = await titles.generateAndStore(
        session.id,
        session.scopeId,
        transcript,
        participantIds?.length ? principalId : undefined,
        fallbackEntry ? visibleTitleItemText(fallbackEntry) : undefined,
      );
      return { title: title ?? (participantIds ? null : (session.title ?? null)) };
    },

    async handleTurn(requested: OrchestratorInput): Promise<TurnResult> {
      const admission = await admitTurn(deps, requested);
      if ("refused" in admission) return admission.refused;
      const {
        input,
        actor,
        conversation,
        external,
        automatedTurn,
        ambientTurn,
        sessionTurn,
        delegatedSession,
        withManagedRosterVersion,
        mirrorRunActivity,
      } = admission.admitted;
      const ctx = await resolveTurnScope(deps, admission.admitted);
      const { resolution, actorGrants, scopeId, reconcileSessionParticipants } = ctx;
      const screenTrace = observeInboundTurn(ctx, { observeSecurityData, blobTransfer });
      const childFloor = delegatedSession?.spawnMeta?.readOnly === true;
      const strictReadOnly = input.readOnly === true || input.privateSessionMessage === true || childFloor;
      const mcpToolsReady = !external && deps.mcp ? deps.mcp.toolDefsFor(actor.id) : undefined;
      const useMemory = !external && input.skipMemory !== true;
      const context = await resolveTurnWorkspace(ctx, { useMemory, memoryPolicy });
      const { sharingSources, memoryScopeId } = context;
      resolution.grantedHandles = context.listFiles();
      let memoryView = await context.memorySnapshot(false);
      const framed = await frameTurnPrompt(ctx, {
        screenTrace,
        useMemory,
        context,
        memoryScopeId,
        memoryStrategy,
        observeSecurityData,
      });
      let systemPrompt = framed.systemPrompt;
      const { turnContextBlocks, delivery, defaultDestination, configuredProviders, timeBlock, onboardingBlock } =
        framed;

      const session = await openTurnSession(ctx);

      const delegatedTask = !!input.sessionSenderId && session.parentSessionId === input.sessionSenderId;
      const syntheticInput =
        (input.proactiveOpener && !input.text.trim()) ||
        ((automatedTurn || (sessionTurn && input.envelopeWrapped)) && !delegatedTask);
      const titleText = input.displayText?.trim() || input.text;
      let fallbackTitleWrite: Promise<void> | undefined;
      const assignSessionTitle = () => {
        if (!session.title && !syntheticInput && !input.approval)
          fallbackTitleWrite = titles.titleFromFirstMessage(session, scopeId, titleText);
      };

      const isRetry = (input.attempt ?? 1) > 1;
      const recordedTurn = isRetry ? await findRecordedTurn(ctx, session) : null;
      const recordedReplay = recordedTurn ? replayRecordedAnswer(ctx, session, recordedTurn) : undefined;
      if (recordedReplay) return recordedReplay;

      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: "turn",
        resource: conversation.threadRef,
        scopeLabel: scopeId,
      });

      let approvalNote = "";
      const approvalLedger = loadApprovalLedger(await actorGrants(), session.id, resolution.approvalGrantModes);
      const catalog = await buildCredentialCatalog(ctx, {
        strictReadOnly,
        sharingSources,
        delivery,
        defaultDestination,
        session,
      });
      const {
        openSpeakerKeychain,
        credentialDescriptions,
        serviceCredRecords,
        grantedCredSlugs,
        actorIsOrgAdmin,
        controlClaims,
        scopeAttestation,
      } = catalog;
      if (catalog.sandboxModelGateway)
        turnContextBlocks["Model access"] =
          "## Model access\nAn OpenAI-compatible model gateway is at `$MODEL_GATEWAY_URL` in the sandbox; authenticate with `Authorization: Bearer $MODEL_GATEWAY_TOKEN`. `GET $MODEL_GATEWAY_URL/v1/models` lists the usable models. The token is bound to this turn and expires with it; never send it anywhere but the gateway.";
      const run: TurnRunState = {
        toolCalls: 0,
        turnProgress: 0,
        firstTokenMarked: false,
        runtimeHandoffs: 0,
        contextRecovered: false,
        remainingDocumentBytes: 0,
        remainingDocumentCount: 0,
        remainingDocumentTokens: 0,
      };
      const gapWork: { listener?: (work: GapWork) => void } = {};
      const emitGapWork = (phase: GapPhase, start: number, end: number): void => {
        try {
          gapWork.listener?.({ phase, start, end });
        } catch (e) {
          swallow("gap-work emit", e);
        }
      };
      const commandPolicy = resolution.commandPolicy;
      const layerCommandRules = [...(deps.deploymentLayer?.commandRules ?? [])];
      const reachAvailable = !!deps.reachExec && !!deps.directory && conversation.kind === "dm";
      const { turnSandboxResources, sandboxes } = openTurnSandboxes(ctx, {
        context,
        framed,
        catalog,
        session,
        emitGapWork,
      });
      const { provision, reclaimBox } = sandboxes;
      const held = await holdTurnLease(ctx, { session, run });
      if ("refused" in held) return held.refused;
      const { lease, turnAbort, catchUpMessageRevisions, stopLeaseKeepalive, leaseState } = held;
      let tailOwnsCleanup = false;
      if (!ambientTurn) assignSessionTitle();
      try {
        await withManagedRosterVersion(async () => {
          await reconcileSessionParticipants(session.id);
          return true;
        });
        const memoryWindow = await deps.sessions.getContextWindow(session.id);

        memoryView = await context.memorySnapshot();
        const captureDependencies = () => [
          ...memoryView.facts,
          ...(!memoryView.complete ||
          memoryWindow.items.length > 0 ||
          run.toolCalls > 0 ||
          input.priorTurns?.length ||
          input.overheard?.length ||
          input.attachments?.length ||
          input.inboundNotes
            ? [UNTRACKED_PROVENANCE]
            : []),
        ];
        const historyWindow = () => deps.sessions.getContextWindow(session.id);
        if (input.approval) {
          const decided = await consumeApprovalDecision({
            deps,
            decision: input.approval,
            sessionId: session.id,
            lease,
            actorId: actor.id,
            scopeId,
            resolution,
            ledger: approvalLedger,
            withRosterVersion: withManagedRosterVersion,
            mirror: mirrorRunActivity,
          });
          if (decided.kind === "settled") return decided.result;
          approvalNote = decided.approvalNote;
        }

        const finished = await finishSystemPrompt(ctx, {
          systemPrompt,
          strictReadOnly,
          turnContextBlocks,
          configuredProviders,
          timeBlock,
          onboardingBlock,
          openSpeakerKeychain,
          credentialDescriptions,
          serviceCredRecords,
          grantedCredSlugs,
          actorIsOrgAdmin,
          reachAvailable,
          reachableChannelsFor,
          directoryIndexFor,
        });
        systemPrompt = finished.systemPrompt;
        const volatileContext = [finished.volatileContext, approvalNote].filter(Boolean).join("\n\n");

        const declined = await detectAmbientDecline(ctx, {
          session,
          isRetry,
          recordedTurn,
          historyWindow,
          transcripts,
        });
        if (declined) return declined;
        if (ambientTurn) assignSessionTitle();

        if (input.runId) {
          if ((surfaceHas(input.surface, "earlyAck") || input.surface === "monitor") && input.runLeaseToken) {
            await deps.runs
              ?.setDeliveryState(input.runId, input.runLeaseToken, { replying: true })
              .catch(swallowAs("orchestrator: persist reply engagement", false));
          }
          deps.turnStream?.begin(input.runId);
        }

        const turnTools = await buildTurnTools(ctx, {
          session,
          strictReadOnly,
          context,
          framed,
          catalog,
          sandboxes,
          approvalLedger,
          commandPolicy,
          layerCommandRules,
          reachAvailable,
          turnSandboxResources,
          gapWork,
          turnAbort,
          captureDependencies,
          blobTransfer,
        });
        const { spine, surfaceToolDeps, attachStaging } = turnTools;
        const prepared = await prepareTurnInput(ctx, {
          screenTrace,
          strictReadOnly,
          context,
          framed,
          session,
          isRetry,
          recordedTurn,
          provision,
          lease,
          turnAbort,
          historyWindow,
          volatileContext,
          turnTools,
          transcripts,
          blobTransfer,
          documentTokenBudget,
          compactContextIfNeeded,
          observeSecurityData,
        });
        run.contextRecovered = prepared.contextRecovered;
        run.remainingDocumentBytes = prepared.remainingDocumentBytes;
        run.remainingDocumentCount = prepared.remainingDocumentCount;
        run.remainingDocumentTokens = prepared.remainingDocumentTokens;
        const { inboundIssues, partial, approvalReplay, resume, turnInput, isPollFire } = prepared;
        const publishFirstAck = firstAckPublisher(ctx, {
          turnTools,
          defaultDestination,
          isPollFire,
          resume,
          approvalReplay,
        });
        const turnStart = Date.now();
        const emittedEntries: Item[] = [];
        const syntheticPrompt = syntheticInput || partial || approvalReplay;
        run.failureUserItem = syntheticPrompt ? undefined : turnFailureUserItem(ctx, inboundIssues);
        const selected = await selectTurnRuntime(ctx, { session, isRetry, controlClaims, scopeAttestation });
        const { restoredRuntime } = selected;
        const runHarnessSegment = createHarnessSegment(ctx, {
          screenTrace,
          framed,
          approvalLedger,
          provision,
          turnTools,
          prepared,
          selected,
          strictReadOnly,
          mcpToolsReady,
          context,
          memoryView,
          systemPrompt,
          session,
          gapWork,
          emitGapWork,
          lease,
          turnAbort,
          run,
          publishFirstAck,
          turnStart,
          emittedEntries,
          syntheticPrompt: Boolean(syntheticPrompt),
          blobTransfer,
          observeSecurityData,
        });
        run.runtimeHandoffs = restoredRuntime ? 1 : 0;
        const result = await runSegments(ctx, {
          framed,
          turnTools,
          prepared,
          selected,
          strictReadOnly,
          session,
          run,
          lease,
          turnAbort,
          historyWindow,
          turnStart,
          runHarnessSegment,
          compactRecent,
        });

        const { stagedAttachments, reply, cancelStopped, outcome, turnCompleted, pausing, turnUserSeq } =
          await concludeTurn(ctx, {
            session,
            result,
            attachStaging,
            spine,
            partial,
            turnInput,
            emittedEntries,
            useMemory,
            memoryScopeId,
            captureDependencies,
            memoryStrategy,
            memoryPolicy,
            pendingCaptures,
          });

        const tail = async (): Promise<void> => {
          try {
            if (!pausing && turnCompleted && !session.title && !fallbackTitleWrite) {
              await titles.generateAndStore(session.id, scopeId, `User:\n${titleText}\n\nAssistant:\n${result.reply}`);
            }
          } finally {
            await reclaimBox();
          }
        };

        let finalResult = await settleTurnResult(ctx, {
          session,
          strictReadOnly,
          hasSurfaceToolDeps: Boolean(surfaceToolDeps),
          isPollFire,
          emittedEntries,
          result,
          stagedAttachments,
          reply,
          cancelStopped,
          outcome,
          turnCompleted,
          turnUserSeq,
        });
        if (run.turnRuntime) finalResult = { ...finalResult, runtime: run.turnRuntime };
        await fallbackTitleWrite;

        if (input.background) {
          tailOwnsCleanup = true;
          await catchUpMessageRevisions();
          await deps.sessions.releaseLease(lease);
          leaseState.released = true;
          void tail().catch(swallowAs("orchestrator: background tail", undefined));
        } else {
          await tail();
          tailOwnsCleanup = true;
        }
        await deps.errors?.flush();
        return finalResult;
      } catch (err) {
        return await mapTurnFailure(ctx, { session, lease, failureUserItem: run.failureUserItem }, err);
      } finally {
        if (input.runId) deps.turnStream?.end(input.runId);
        stopLeaseKeepalive();
        if (!tailOwnsCleanup) await reclaimBox();
        if (!leaseState.released) {
          await catchUpMessageRevisions();
          await deps.sessions.releaseLease(lease);
        }
        if (!run.contextRecovered && !turnAbort.signal.aborted)
          scheduleBackgroundCompaction({
            sessionId: session.id,
            scopeId,
            orgScopeId: resolution.orgScopeId,
            actorId: actor.id,
            ...(input.model ? { model: input.model } : {}),
          });
      }
    },
  };
  return orchestrator;
}
