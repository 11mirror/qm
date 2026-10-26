import { currentExternalSlackRun } from "../resolution/external-slack.ts";
import { UNTRACKED_PROVENANCE } from "../memory/facts.ts";
import { type ScopeId, type TurnResult, type PendingApprovalRecord } from "../types.ts";
import { resolveTurnContext } from "../resolution/turn-context.ts";
import { reachPost } from "../reach/reach.ts";
import type { DirectoryStore, DirectoryChannel, DirectoryMember } from "../directory/directory-store.ts";
import { resolveEnvironmentId } from "../environments/environment-store.ts";
import type { GapPhase } from "../sessions/session-store.ts";
import { isOverheard, isUserMessage, type Item } from "../sessions/items.ts";
import { renderComputerBlock, renderSandboxProfiles } from "./environment-facts.ts";
import type { GapWork } from "../harness/harness.ts";
import { securityScreenPayload, UNSCREENED_REASON } from "../security/security-posture.ts";
import { createPerTurnStrategy } from "../memory/strategies/per-turn.ts";
import { DEFAULT_MEMORY_POLICY } from "../memory/policy.ts";
import { createTranscriptSource } from "../sessions/transcript-source.ts";
import { environmentNote, inboundIssuesNote } from "./attachments.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import { personKey } from "../directory/person.ts";
import { LRUCache } from "lru-cache";
import type { Orchestrator, OrchestratorDeps, OrchestratorInput } from "./orchestrator/types.ts";
import { admitTurn } from "./orchestrator/admit.ts";
import { acquireTurnLeaseOrRefuse } from "./orchestrator/turn-lease.ts";
import { openTurnSession, resolveTurnScope } from "./orchestrator/turn-context.ts";
import { screenInboundTurn } from "./orchestrator/inbound-screen.ts";
import { buildCredentialCatalog } from "./orchestrator/credential-catalog.ts";
import { frameTurnPrompt } from "./orchestrator/turn-prompt.ts";
import { concludeTurn, mapTurnFailure, settleTurnResult } from "./orchestrator/settle.ts";
import { detectAmbientDecline, findRecordedTurn, replayRecordedAnswer } from "./orchestrator/turn-replay.ts";
import { finishSystemPrompt } from "./orchestrator/turn-prompt.ts";
import { buildTurnTools } from "./orchestrator/turn-tools.ts";
import { prepareTurnInput } from "./orchestrator/turn-input.ts";
import { selectTurnRuntime } from "./orchestrator/turn-runtime.ts";
import { createHarnessSegment, runSegments, type TurnRunState } from "./orchestrator/turn-segment.ts";
import {
  consumeApprovalDecision,
  loadApprovalLedger,
  type QuarantineReleaseApproval,
} from "./orchestrator/approvals.ts";
import { createSessionTitles } from "./session-title.ts";
import { renderTitleTranscript, visibleTitleItemText } from "./orchestrator/turn-helpers.ts";
import { createCompaction } from "./orchestrator/compaction.ts";
import { startLeaseKeepalive } from "./orchestrator/lease-keepalive.ts";
import { createSecurityClassifier } from "./orchestrator/security-screen.ts";
import { createTurnSandboxes } from "./orchestrator/sandboxes.ts";
import { reconcileMessageRevisions, revisionAnchorAt } from "./message-revisions.ts";

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
  const leaseKeepaliveMs = Math.floor(deps.sessions.leaseTtlMs / 3);
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

  const securitySteersInFlight = new Set<string>();
  const { compactContextIfNeeded, compactRecent, scheduleBackgroundCompaction, documentTokenBudget } =
    createCompaction(deps);

  const classifySecurityData = createSecurityClassifier(deps);

  const titles = createSessionTitles({
    sessions: deps.sessions,
    harness: deps.harness,
    ...(deps.sessionStateBus ? { sessionStateBus: deps.sessionStateBus } : {}),
    ...(deps.errors ? { errors: deps.errors } : {}),
  });

  const orchestrator: Orchestrator = {
    async screenSecuritySteer({ payload, actor, conversation, sessionId }) {
      const resolution = await deps.resolution.resolve(conversation, actor);
      const { screening } = resolution.securityPolicy;
      if (screening === "off") return "allow";
      const scopeLabel = deps.resolution.scopeFor(conversation, actor);
      const bounded = securityScreenPayload({
        surface: "external",
        text: "",
        triggered: true,
        securityScreenData: payload,
      });
      const steerContext = {
        hook: "user_input",
        surface: "steer",
        origin: "ambient",
        thread: conversation.threadRef,
        ...(sessionId ? { sessionId } : {}),
      } as const;
      if (screening === "observe") {
        if (bounded && !bounded.truncated)
          await classifySecurityData(bounded.content, actor.id, scopeLabel, undefined, {
            ...steerContext,
            mode: "observe",
          });
        return "allow";
      }
      const block = (cause: string, reason?: string): "block" => {
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.id,
          action: "security_posture.steer_block",
          resource: conversation.threadRef,
          scopeLabel,
          status: "strict",
          detail: JSON.stringify({ cause, ...(reason ? { reason } : {}) }),
        });
        return "block";
      };
      if (!deps.securityScreener && !deps.harness.models.screenSecurity) return block("no-screener");
      if (!(await deps.rateLimiter.check(actor.id)).allowed) return block("rate-limited");
      if (deps.budget && !(await deps.budget.check(actor.id)).allowed) return block("over-budget");
      if (securitySteersInFlight.has(conversation.threadRef)) return block("steer-in-flight");
      if (!bounded || bounded.truncated) return block("oversize-input");
      securitySteersInFlight.add(conversation.threadRef);
      const verdict = await classifySecurityData(
        bounded.content,
        actor.id,
        scopeLabel,
        sessionId
          ? async (rec, signal) => {
              await deps.sessions.recordLlmRequest(sessionId, { ...rec, scopeLabel }, signal);
            }
          : undefined,
        { ...steerContext, mode: "enforce" },
      ).finally(() => securitySteersInFlight.delete(conversation.threadRef));
      if (verdict?.decision === "auto") {
        if (!verdict.unscreened) return "allow";
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.id,
          action: "security_posture.steer_failed_open",
          resource: conversation.threadRef,
          scopeLabel,
          status: "allowed",
          detail: JSON.stringify({ cause: UNSCREENED_REASON }),
        });
        return "unscreened";
      }
      return block("strict-verdict", verdict?.reason);
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
        humanInput,
        authorizationOrigin,
        liveAuthorTurn,
        messageTs,
        entryTs,
        delegatedSession,
        withManagedRosterVersion,
        mirrorRunActivity,
      } = admission.admitted;
      const ctx = await resolveTurnScope(deps, admission.admitted);
      const { resolution, actorGrants, scopeId, isCurrentSharedScopeMember, reconcileSessionParticipants } = ctx;
      const screened = await screenInboundTurn(ctx, { classifySecurityData, blobTransfer });
      if ("result" in screened) return screened.result;
      const { securityPolicy, enforceScreen, screenTrace, pendingScreenRequests, recordScreenRequest } =
        screened.screen;
      const childFloor = delegatedSession?.spawnMeta?.readOnly === true;
      const strictReadOnly = input.readOnly === true || input.privateSessionMessage === true || childFloor;
      const mcpToolsReady = !external && deps.mcp ? deps.mcp.toolDefsFor(actor.id) : undefined;
      const useMemory = !external && input.skipMemory !== true;
      const environmentId = external ? scopeId : await resolveEnvironmentId(deps.environments, scopeId);
      const rwLayer = resolution.layers.find((l) => l.mode === "rw");
      if (rwLayer && environmentId !== rwLayer.scopeId) rwLayer.scopeId = environmentId;
      for (const layer of resolution.layers) await deps.workspace.ensureScope(layer.scopeId);

      const context = await resolveTurnContext({
        external,
        actor,
        audience: conversation.audience,
        acl: deps.acl,
        origin: authorizationOrigin,
        trustedLiveHuman: liveAuthorTurn,
        targetScope: scopeId,
        config: deps.config,
        sessions: deps.sessions,
        isCurrentSharedScopeMember,
        currentScopeMembers: deps.currentScopeMembers,
        resolution,
        memoryPolicy,
        useMemory,
        memory: deps.memory,
        files: deps.files,
        skills: deps.skills,
        auditLog: deps.auditLog,
        directory: deps.directory,
        projects: deps.projects,
      });
      const { sharingSources, memoryScopeId } = context;
      resolution.grantedHandles = context.listFiles();
      let memoryView = await context.memorySnapshot(false);
      const framed = await frameTurnPrompt(ctx, {
        securityPolicy,
        enforceScreen,
        screenTrace,
        recordScreenRequest,
        useMemory,
        context,
        memoryScopeId,
        memoryStrategy,
        classifySecurityData,
      });
      let systemPrompt = framed.systemPrompt;
      const {
        turnContextBlocks,
        scopeProfile,
        delivery,
        defaultDestination,
        configuredProviders,
        visibleSkillsForTurn,
        transferId,
        turnSessionDir,
        turnFilesDir,
        timeBlock,
        onboardingBlock,
      } = framed;

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

      let releasedToolOutput: PendingApprovalRecord["screenedOutput"];
      const approvalLedger = loadApprovalLedger(await actorGrants(), session.id, resolution.approvalGrantModes);
      const quarantineReleaseApprovals: QuarantineReleaseApproval[] = [];
      const catalog = await buildCredentialCatalog(ctx, {
        securityPolicy,
        strictReadOnly,
        sharingSources,
        delivery,
        defaultDestination,
        session,
      });
      const {
        openSpeakerKeychain,
        ownerAuthAvailable,
        connectorEnv,
        credentialDescriptions,
        serviceCredRecords,
        grantedCredSlugs,
        actorIsOrgAdmin,
        controlClaims,
        scopeAttestation,
        egressTokenForPolicy,
        egressTokenForTurn,
        openAutomationKeychain,
      } = catalog;
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
      const turnSandboxResources = external
        ? deps.sandboxResources?.forTurn({
            actorId: actor.id,
            scopeId,
            isCurrent: async () =>
              !!(await currentExternalSlackRun(
                {
                  actorId: actor.id,
                  scopeId,
                  runId: input.runId,
                  runLeaseToken: input.runLeaseToken,
                  runAttempt: input.attempt,
                  threadRef: conversation.threadRef,
                },
                deps,
              )),
          })
        : deps.sandboxResources;
      const workspaceLayout = {
        hasGlobal: resolution.layers.some((l) => l.mountPath === "global"),
        teamCount: resolution.layers.filter((l) => l.mountPath.startsWith("team-")).length,
      };
      if (turnSandboxResources) {
        Object.assign(turnContextBlocks, renderSandboxProfiles(turnSandboxResources.profiles(), workspaceLayout));
      } else {
        turnContextBlocks["Sandbox environment profile"] = renderComputerBlock(scopeProfile.spec, workspaceLayout);
      }

      const sandboxes = createTurnSandboxes({
        deps: { ...deps, sandboxResources: turnSandboxResources, isCurrentSharedScopeMember },
        input,
        actor,
        session,
        resolution,
        scopeId,
        memoryScopeId,
        transferId,
        turnSessionDir,
        turnFilesDir,
        connectorEnv,
        egressTokenForTurn,
        egressTokenForPolicy,
        openSpeakerKeychain: openSpeakerKeychain || openAutomationKeychain,
        openResourceAccess: !external && (liveAuthorTurn || openAutomationKeychain),
        ownerAuthAvailable,
        visibleSkillsForTurn,
        emitGapWork,
      });
      const { provision, reclaimBox } = sandboxes;
      const leaseStart = Date.now();
      const acquired = await acquireTurnLeaseOrRefuse(deps, {
        sessionId: session.id,
        site: "turn",
        scopeId,
        automated: automatedTurn,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.turnFenceToken ? { fenceToken: input.turnFenceToken } : {}),
        ...(input.surface ? { surface: input.surface } : {}),
      });
      if (!acquired.lease) return acquired.refusal;
      const lease = acquired.lease;
      if (!ambientTurn) assignSessionTitle();
      const trackRevisions = input.surface === "slack" && Boolean(deps.surfaceCache);
      const revisionAnchor = trackRevisions ? await revisionAnchorAt(deps.sessions, session.id) : undefined;
      const catchUpMessageRevisions = async (): Promise<void> => {
        if (!trackRevisions || !deps.surfaceCache) return;
        await reconcileMessageRevisions({
          sessions: deps.sessions,
          surfaceCache: deps.surfaceCache,
          lease,
          session,
          anchorAt: revisionAnchor,
          fallbackSince: leaseStart,
          ...(messageTs ? { triggerTs: messageTs } : {}),
        }).catch(swallowAs("orchestrator: message revision catch-up", undefined));
      };
      let tailOwnsCleanup = false;
      let leaseReleased = false;
      const turnAbort = new AbortController();
      if (input.cancel?.aborted) turnAbort.abort();
      else input.cancel?.addEventListener("abort", () => turnAbort.abort(), { once: true });
      const stopLeaseKeepalive = startLeaseKeepalive(deps.sessions, lease, leaseKeepaliveMs, () => leaseReleased, {
        progress: () => run.turnProgress,
        onStalled: () => turnAbort.abort(),
      });
      try {
        await withManagedRosterVersion(async () => {
          await reconcileSessionParticipants(session.id);
          await Promise.all(pendingScreenRequests.splice(0).map((rec) => recordScreenRequest(rec)));
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
            surface: input.surface,
            sessionId: session.id,
            lease,
            actorId: actor.id,
            scopeId,
            resolution,
            audience: conversation.audience,
            ledger: approvalLedger,
            withRosterVersion: withManagedRosterVersion,
            mirror: mirrorRunActivity,
          });
          if (decided.kind === "settled") return decided.result;
          releasedToolOutput = decided.releasedToolOutput;
          systemPrompt += decided.promptNote;
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
        const volatileContext = finished.volatileContext;

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
          if ((input.surface === "slack" || input.surface === "monitor") && input.runLeaseToken) {
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
        const { spine, spineFirst, postProvenance, turnKey, surfaceToolDeps, attachStaging } = turnTools;
        const publishFirstAck = (deliberatePost: boolean) => {
          if (
            !input.runId ||
            !input.addressed ||
            sessionTurn ||
            isPollFire ||
            !spineFirst.open ||
            resume ||
            approvalReplay
          )
            return;
          spineFirst.open = false;
          const ack = spineFirst.block.trim();
          if (deliberatePost || !ack || !defaultDestination || !deps.outbound) return;
          spineFirst.ackText = ack;
          const runId = input.runId;
          const ackKey = `ack:${turnKey}`;
          void reachPost({
            outbound: deps.outbound,
            destination: defaultDestination,
            text: ack,
            idempotencyKey: ackKey,
            provenance: postProvenance(ackKey),
          })
            .then(() => deps.turnStream?.markSurfacePosted(runId))
            .catch(swallowAs("orchestrator: first-block ack", undefined));
        };

        const prepared = await prepareTurnInput(ctx, {
          screen: screened.screen,
          strictReadOnly,
          context,
          framed,
          session,
          isRetry,
          recordedTurn,
          releasedToolOutput,
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
          classifySecurityData,
        });
        run.contextRecovered = prepared.contextRecovered;
        run.remainingDocumentBytes = prepared.remainingDocumentBytes;
        run.remainingDocumentCount = prepared.remainingDocumentCount;
        run.remainingDocumentTokens = prepared.remainingDocumentTokens;
        const { inboundIssues, partial, approvalReplay, resume, turnInput, isPollFire } = prepared;
        const turnStart = Date.now();
        const emittedEntries: Item[] = [];
        const syntheticPrompt = syntheticInput || partial || approvalReplay || !!releasedToolOutput;
        run.failureUserItem =
          !syntheticPrompt && (input.text.trim() || inboundIssues.length)
            ? {
                kind: "UserMessage",
                text: input.text,
                externalId: messageTs ?? entryTs ?? null,
                author: actor.id,
                body: {
                  ...(inboundIssues.length ? { environment: environmentNote(inboundIssuesNote(inboundIssues)) } : {}),
                  ...(humanInput ? { speakerId: actor.id } : {}),
                  ...(actor.displayName?.trim() ? { name: actor.displayName.trim() } : {}),
                  ...(input.displayText?.trim() ? { display: input.displayText } : {}),
                },
              }
            : undefined;
        const selected = await selectTurnRuntime(ctx, { session, isRetry, controlClaims, scopeAttestation });
        const { restoredRuntime } = selected;
        const runHarnessSegment = createHarnessSegment(ctx, {
          screen: screened.screen,
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
          quarantineReleaseApprovals,
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
          classifySecurityData,
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
          quarantineReleaseApprovals,
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
          leaseReleased = true;
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
        if (!leaseReleased) {
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
