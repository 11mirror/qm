import { SECURITY_TOOL_RESULT_QUARANTINE } from "../audit/audit-log.ts";
import { createAdminCall } from "../tools/admin.ts";
import { currentExternalSlackRun } from "../resolution/external-slack.ts";
import { markFirstToken } from "../../plugins/chassis/src/error-reporting.ts";
import { externalTools } from "./orchestrator/external-tools.ts";
import { memoryRecallDelta } from "../memory/recall-delta.ts";
import { UNTRACKED_PROVENANCE } from "../memory/facts.ts";
import { memoryRecallQuery } from "../memory/semantic-recall.ts";
import {
  documentText,
  type ExtractedDocumentText,
  historicalDocumentMetas,
  loadDocumentInputs,
} from "./document-inputs.ts";
import { MAX_DOCUMENT_BYTES, estimateDocumentTokens, isDocumentAttachment, isTextDocument } from "./document-kinds.ts";
import { recoveredRuntime } from "../harness/runtime-recovery.ts";
import { goalView } from "../runs/turn-stream.ts";
import { type GoalRecord, openGoal } from "../harness/goal.ts";
import {
  type DeliveryProvenance,
  type ScopeId,
  type TurnResult,
  type TurnRuntime,
  type PendingApprovalRecord,
} from "../types.ts";
import { scopeId as toScopeId, personalScope } from "../types.ts";
import { desktopClientForTurn } from "./turn-origin.ts";
import { resolveTurnFastMode, turnRuntimePurpose } from "./turn-options.ts";
import { deriveTurnOutcome } from "./turn-outcome.ts";
import { loadProtocolFile } from "../resolution/prompt-vars.ts";
import { resolveTurnContext } from "../resolution/turn-context.ts";
import { resolveReachableChannel } from "../resolution/scope-reach.ts";
import { reachPost } from "../reach/reach.ts";
import { turnPostProvenance } from "../surfaces/outbound.ts";
import { recentPrincipalDeliveryNote } from "../surfaces/recent-dm-posts.ts";
import type { DirectoryStore, DirectoryChannel, DirectoryMember } from "../directory/directory-store.ts";
import { resolveEnvironmentId } from "../environments/environment-store.ts";
import type { GapPhase } from "../sessions/session-store.ts";
import { CONFIG_DEFAULTS } from "../config.ts";
import { isOverheard, isUserMessage, type Item, type NewItem } from "../sessions/items.ts";
import { supportsProcessSessions } from "../sandbox/sandbox.ts";
import { createBackgroundBroker } from "../connectors/background-exec-broker.ts";
import { createMonitorBroker, readBackgroundOutputTail } from "../monitors/monitor-broker.ts";
import { isPollSurface } from "../triggers/run-trigger.ts";
import { finishProcessCredentials } from "../credentials/execute-files.ts";
import { environmentDelta, renderComputerBlock, renderSandboxProfiles } from "./environment-facts.ts";
import { estimateCostUsd } from "../ratelimit/budget.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../auth/capability-token.ts";
import type { GapWork, HarnessDetectResult, HarnessTurnInput, RuntimeChoice } from "../harness/harness.ts";
import { forModelContext, forSearchView } from "../harness/context-compaction.ts";
import {
  quarantineReleaseKey,
  securityScreenChunks,
  securityScreenPayload,
  toolLabelOf,
  UNSCREENED_REASON,
  unscreenedNotice,
  type SecurityScreenVerdict,
  type ToolResultScreen,
  type ToolResultScreenInput,
} from "../security/security-posture.ts";
import { createPerTurnStrategy } from "../memory/strategies/per-turn.ts";
import { DEFAULT_MEMORY_POLICY } from "../memory/policy.ts";
import { skillsIndex } from "../skills/materialize.ts";
import { PROACTIVE_OPENER_PROMPT } from "../onboarding/onboarding.ts";
import { createToolContext, type CommandCredential } from "../tools/primitives.ts";
import type { FileArtifact } from "../files/file-artifact-store.ts";
import { artifactImageLoader } from "../harness/replay-images.ts";
import { principalEntitledToScope } from "../resolution/context-filter.ts";
import { openSessionItem, searchSessionItems } from "../sessions/history-search.ts";
import { createTranscriptSource } from "../sessions/transcript-source.ts";
import { defaultPublishAudience } from "../resolution/publish-audience.ts";
import {
  environmentNote,
  inboundIssuesNote,
  inboundIssueList,
  inboundManifest,
  materializeInbound,
  safeAttachmentName,
  senderNote,
  type ArtifactRegistration,
  withoutAlreadyIngested,
} from "./attachments.ts";
import {
  findTrailingPartialTurn,
  resumeStrategy,
  runtimeSwitchNote,
  turnAtSeq,
  unrecordedResultItems,
} from "./turn-resume.ts";
import type { RecordedTurn } from "./turn-resume.ts";
import {
  recordedMessageTimestamps,
  selectOverheardToImport,
  overheardItem,
  type OverheardEntryPayload,
} from "../harness/replay.ts";
import { errMessage, reportFailure, swallow, swallowAs } from "../util/errors.ts";
import { absoluteAppLinks } from "../util/markdown.ts";
import { NonRetryableTurnError } from "./turn-error.ts";
import { personKey } from "../directory/person.ts";
import { randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { Orchestrator, OrchestratorDeps, OrchestratorInput } from "./orchestrator/types.ts";
import { admitTurn, ProjectRosterChanged } from "./orchestrator/admit.ts";
import { acquireTurnLeaseOrRefuse } from "./orchestrator/turn-lease.ts";
import { openTurnSession, resolveTurnScope } from "./orchestrator/turn-context.ts";
import { screenInboundTurn } from "./orchestrator/inbound-screen.ts";
import { buildCredentialCatalog } from "./orchestrator/credential-catalog.ts";
import { frameTurnPrompt } from "./orchestrator/turn-prompt.ts";
import { mapTurnFailure, settleTurnResult } from "./orchestrator/settle.ts";
import { finishSystemPrompt } from "./orchestrator/turn-prompt.ts";
import {
  consumeApprovalDecision,
  loadApprovalLedger,
  type QuarantineReleaseApproval,
} from "./orchestrator/approvals.ts";
import { codexSubscriptionModelId, CODEX_SUBSCRIPTION_PROVIDER } from "../model/pi-models.ts";
import type { ProviderKeys } from "../harness/pi-harness.ts";
import { resolveIndividualAuthRouting } from "./individual-auth-routing.ts";
import { createSessionTitles } from "./session-title.ts";
import {
  completedSurfaceEnqueues,
  isScreenableTextAttachment,
  renderTitleTranscript,
  stripAckPrefix,
  turnPostKeys,
  visibleTitleItemText,
} from "./orchestrator/turn-helpers.ts";
import { createCompaction } from "./orchestrator/compaction.ts";
import { startLeaseKeepalive } from "./orchestrator/lease-keepalive.ts";
import { createSecurityClassifier } from "./orchestrator/security-screen.ts";
import { createTurnSandboxes } from "./orchestrator/sandboxes.ts";
import { createSurfaceToolDeps, type SpineState } from "./orchestrator/surface-tools.ts";
import { createAttachStaging } from "./orchestrator/attach-tool.ts";
import { reconcileMessageRevisions, revisionAnchorAt } from "./message-revisions.ts";

export { egressClaimAllowingControlPlane, filterConnectorSkills } from "./orchestrator/turn-helpers.ts";
export type { Orchestrator, OrchestratorDeps, OrchestratorInput, SurfaceContextPuller } from "./orchestrator/types.ts";

const ADDRESSED_NUDGE_MD = loadProtocolFile("turn-addressed-nudge");

const FIRST_BLOCK_CAPTURE_MAX_CHARS = 20_000;

const DETECT_HISTORY_TAIL = 400;

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
        liveTurn,
        liveAuthorTurn,
        messageTs,
        entryTs,
        coreReceivedAt,
        turnTimezone,
        delegatedSession,
        withManagedRosterVersion,
        mirrorRunActivity,
      } = admission.admitted;
      const ctx = await resolveTurnScope(deps, admission.admitted);
      const {
        resolution,
        actorGrants,
        scopeId,
        isCurrentSharedScopeMember,
        filterHistory,
        reconcileSessionParticipants,
      } = ctx;
      const screened = await screenInboundTurn(ctx, { classifySecurityData, blobTransfer });
      if ("result" in screened) return screened.result;
      const {
        securityPolicy,
        enforceScreen,
        screenTrace,
        approvalRecord,
        pendingScreenRequests,
        recordScreenRequest,
        inputUnscreened,
      } = screened.screen;
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
      const { sharingSources, memoryScopeId, memoryAccess } = context;
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
        surfaceName,
        sessionSyscalls,
        delegateWork,
        turnContextBlocks,
        scopeProfile,
        delivery,
        defaultDestination,
        configuredProviders,
        visibleSkillsForTurn,
        nativeSkills,
        transferId,
        turnSessionDir,
        turnFilesDir,
        turnInboxDir,
        timeBlock,
        memoryHeading,
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
      const recordedTurnForRun = async (): Promise<RecordedTurn | null> => {
        if (!input.runId || !deps.runs) return null;
        const seq = (await deps.runs.get(input.runId))?.turnUserSeq;
        if (seq == null) return null;
        const entries = await deps.sessions.getItems(session.id);
        if (!entries.some((entry) => entry.seq === seq)) return null;
        return turnAtSeq(
          entries.filter((entry) => entry.seq >= seq),
          seq,
        );
      };
      const recordedTurn = isRetry ? await recordedTurnForRun() : null;
      if (recordedTurn?.answer) {
        const recordedAnswer = recordedTurn.answer;
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.id,
          action: "turn.already_answered",
          resource: conversation.threadRef,
          scopeLabel: scopeId,
          detail: `attempt ${input.attempt}; replaying the answer the previous attempt recorded at seq ${recordedAnswer.seq}`,
        });
        console.error(
          `[orchestrator] turn.already_answered attempt=${input.attempt} run=${input.runId} thread=${conversation.threadRef} answerSeq=${recordedAnswer.seq}`,
        );
        return recordedAnswer.text.trim()
          ? {
              status: "ok",
              sessionId: session.id,
              reply: absoluteAppLinks(recordedAnswer.text, deps.publicWebUrl),
              sourceUserSeq: recordedTurn.userSeq,
              sourceAssistantEntrySeq: recordedAnswer.seq,
            }
          : { status: "silent", sessionId: session.id };
      }

      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: "turn",
        resource: conversation.threadRef,
        scopeLabel: scopeId,
      });

      let releasedToolOutput: PendingApprovalRecord["screenedOutput"];
      const approvalLedger = loadApprovalLedger(await actorGrants(), session.id, resolution.approvalGrantModes);
      const { consume: consumeApproval, authorizeToolCall, authorizeCommand } = approvalLedger;
      const quarantineReleaseApprovals: QuarantineReleaseApproval[] = [];
      const quarantinePreview = (payload: string): string => {
        const cleaned = payload
          .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return cleaned.length > 240 ? `${cleaned.slice(0, 240)}…` : cleaned;
      };
      const quarantineFullText = (payload: string): string => {
        const cleaned = payload.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
        return cleaned.length > 16_000 ? `${cleaned.slice(0, 16_000)}…` : cleaned;
      };
      const {
        openSpeakerKeychain,
        ownerAuthAvailable,
        connectorEnv,
        commandCredentials,
        credentialDescriptions,
        credentialBroker,
        registerKeychainCredentials,
        registerConnectorCredentials,
        serviceCredRecords,
        grantedCredSlugs,
        actorIsOrgAdmin,
        controlClaims,
        scopeAttestation,
        egressTokenForPolicy,
        egressTokenForTurn,
        registerServiceCredentials,
        openAutomationKeychain,
      } = await buildCredentialCatalog(ctx, {
        securityPolicy,
        strictReadOnly,
        sharingSources,
        delivery,
        defaultDestination,
        session,
      });
      let toolCalls = 0;
      let harnessOnGapWork: ((work: GapWork) => void) | undefined;
      const emitGapWork = (phase: GapPhase, start: number, end: number): void => {
        try {
          harnessOnGapWork?.({ phase, start, end });
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

      const {
        ownerAuthCommand,
        provision,
        provisionScratch,
        accessResource,
        provisionResource,
        provisionOwnerAuth,
        useSkill,
        provisionForReach,
        reclaimBox,
        invalidateProvision,
      } = createTurnSandboxes({
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
      let contextRecovered = false;
      let turnProgress = 0;
      const turnAbort = new AbortController();
      if (input.cancel?.aborted) turnAbort.abort();
      else input.cancel?.addEventListener("abort", () => turnAbort.abort(), { once: true });
      const stopLeaseKeepalive = startLeaseKeepalive(deps.sessions, lease, leaseKeepaliveMs, () => leaseReleased, {
        progress: () => turnProgress,
        onStalled: () => turnAbort.abort(),
      });
      let failureUserItem: NewItem<"UserMessage"> | undefined;
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
          toolCalls > 0 ||
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

        if (
          ambientTurn &&
          !sessionTurn &&
          deps.harness.models.shouldRespond &&
          !(
            isRetry &&
            (recordedTurn ?? findTrailingPartialTurn((await transcripts.forRender(session.id)).items, input.runId))
          )
        ) {
          const detectHistory = filterHistory((await historyWindow()).items.slice(-DETECT_HISTORY_TAIL));
          const decision = await deps.harness.models
            .shouldRespond({
              session,
              message: input.text,
              recentContext: input.detectContext ?? "",
              ...(input.detectOpener ? { threadOpener: input.detectOpener } : {}),
              systemPrompt: resolution.systemPrompt,
              ...(input.gatewayContext?.reactionGuidance
                ? { reactionGuidance: input.gatewayContext.reactionGuidance }
                : {}),
              history: detectHistory,
              recordModelCall: (rec) => {
                deps.modelGateway.recordCall({ at: Date.now(), scopeLabel: scopeId, ...rec });
                void deps.budget?.record(actor.id, estimateCostUsd(rec.inputTokens));
              },
            })
            .catch((e: unknown): HarnessDetectResult => {
              deps.errors?.record(
                {
                  category: "turn",
                  code: "detection_failed",
                  message: errMessage(e),
                  scopeLabel: scopeId,
                  sessionId: session.id,
                },
                e,
              );
              return { respond: false, reason: `detection failed: ${errMessage(e)}` };
            });
          if (!decision.respond) {
            const reactions = decision.reactions?.length ? decision.reactions : undefined;
            deps.auditLog.record({
              at: Date.now(),
              principalId: actor.id,
              action: reactions ? "turn.react" : "turn.silent",
              resource: conversation.threadRef,
              scopeLabel: scopeId,
              ...(decision.reason ? { detail: decision.reason } : {}),
            });
            console.error(
              `[orchestrator] turn.${reactions ? "react" : "silent"} (detection ${reactions ? `acknowledged emoji=${reactions.join(",")}` : "declined"}) thread=${conversation.threadRef}` +
                (decision.reason ? ` reason=${JSON.stringify(decision.reason)}` : ""),
            );
            return reactions
              ? { status: "react", sessionId: session.id, reactions }
              : { status: "silent", sessionId: session.id };
          }
        }
        if (ambientTurn) assignSessionTitle();

        if (input.runId) {
          if ((input.surface === "slack" || input.surface === "monitor") && input.runLeaseToken) {
            await deps.runs
              ?.setDeliveryState(input.runId, input.runLeaseToken, { replying: true })
              .catch(swallowAs("orchestrator: persist reply engagement", false));
          }
          deps.turnStream?.begin(input.runId);
        }

        const backgroundBroker =
          deps.processes && supportsProcessSessions(deps.sandbox)
            ? createBackgroundBroker({
                sandbox: deps.sandbox,
                registry: deps.processes,
                provisionSandbox: provisionResource,
                onExit: (handle, processId) =>
                  finishProcessCredentials(
                    {
                      sandbox: deps.sandbox,
                      processes: deps.processes!,
                      ...(deps.keychain ? { keychain: deps.keychain } : {}),
                    },
                    handle,
                    processId,
                  ),
                scopeId: memoryScopeId,
                sessionRef: conversation.threadRef,
                ...(deps.backgroundJobTtlMs !== undefined ? { ttlMs: deps.backgroundJobTtlMs } : {}),
                ...(deps.backgroundJobTtlMaxMs !== undefined ? { ttlMaxMs: deps.backgroundJobTtlMaxMs } : {}),
              })
            : undefined;

        const readOutputTail = backgroundBroker
          ? async (processId: string, maxBytes: number) => {
              const handle = (await backgroundBroker.handleFor?.(processId)) ?? (await provision());
              return readBackgroundOutputTail(maxBytes, async (cursor, readMaxBytes) => {
                const read = await backgroundBroker.poll(handle, processId, {
                  sinceCursor: cursor,
                  maxBytes: readMaxBytes,
                  waitMs: 0,
                });
                return {
                  chunks: read.chunks,
                  cursor: read.cursor,
                  ...(read.status.state === "exited" ? { exitCode: read.status.code } : {}),
                };
              });
            }
          : undefined;

        const monitorBroker =
          deps.monitors && deps.processes && supportsProcessSessions(deps.sandbox)
            ? createMonitorBroker({
                store: deps.monitors,
                registry: deps.processes,
                readOutputTail: readOutputTail ?? (async () => ({ outputTail: "" })),
                scopeId: memoryScopeId,
                owner: actor.id,
                ownerScopeId: scopeId,
                threadRef: conversation.threadRef,
                ...(defaultDestination ? { destination: defaultDestination } : {}),
              })
            : undefined;

        const spine: SpineState = {
          surfaceOutboundCount: 0,
          crossConversationPosts: 0,
          turnUserEntrySeq: undefined,
        };
        const turnKey = input.runId ?? randomUUID();
        const postKeys = turnPostKeys(turnKey);
        let spineFirstBlock = "";
        let spineFirstBlockOpen = true;
        let spineAckText: string | undefined;
        const fileAudience =
          !external && resolution.orgScopeId
            ? defaultPublishAudience({
                kind: conversation.kind,
                ...(conversation.isPrivate !== undefined ? { isPrivate: conversation.isPrivate } : {}),
                ...(conversation.isMpim !== undefined ? { isMpim: conversation.isMpim } : {}),
                ...(conversation.publishMembers ? { members: conversation.publishMembers } : {}),
                orgScopeId: resolution.orgScopeId,
                ownerId: actor.id,
              }).grantees
            : [];
        // Files posted into a group/DM conversation (e.g. a project web session) get no
        // per-member grants from defaultPublishAudience ("auto-share deferred"), which left
        // other members unable to load them. Grant the conversation scope itself read access
        // so everyone party to the conversation can fetch what was posted into it.
        const fileOwnerScopeId = external ? scopeId : toScopeId("personal", actor.id);
        const fileGrantees = [...fileAudience];
        if ((conversation.kind === "group" || conversation.kind === "dm") && scopeId !== fileOwnerScopeId) {
          fileGrantees.push(scopeId);
        }
        const fileRegistration: ArtifactRegistration = {
          store: deps.files,
          ownerScopeId: fileOwnerScopeId,
          createdBy: actor.id,
          createdInScope: scopeId,
          seed: input.runId ?? `${session.id}:${Date.now()}`,
          ...(fileGrantees.length
            ? {
                onRegistered: async ({ ownerScopeId, id }) => {
                  for (const granteeScopeId of fileGrantees) {
                    await deps.acl.grant({
                      ownerScopeId,
                      ref: id,
                      granteeScopeId,
                      permission: "read",
                      grantedBy: actor.id,
                    });
                  }
                },
              }
            : {}),
          onError: (e) =>
            deps.errors?.record(
              {
                category: "file_store",
                code: "register_failed",
                message: errMessage(e),
                scopeLabel: scopeId,
                sessionId: session.id,
              },
              e,
            ),
        };
        const postProvenance = (deliveryKey: string): DeliveryProvenance =>
          turnPostProvenance({
            origin: input.origin,
            surface: input.surface,
            fireKey: deliveryKey,
            sourceScopeId: scopeId as ScopeId,
            sourceThreadRef: session.threadRef,
            sourceSessionId: session.id,
          });
        const earlyTaskAck =
          input.surface === "slack" && humanInput && conversation.kind === "dm" && !input.approval && !input.botActor;
        const publishFirstAck = (deliberatePost: boolean) => {
          if (
            !input.runId ||
            !input.addressed ||
            sessionTurn ||
            isPollFire ||
            !spineFirstBlockOpen ||
            resume ||
            approvalReplay
          )
            return;
          spineFirstBlockOpen = false;
          const ack = spineFirstBlock.trim();
          if (deliberatePost || !ack || !defaultDestination || !deps.outbound) return;
          spineAckText = ack;
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
        let readableHandles: Awaited<ReturnType<typeof deps.acl.handlesForAudience>> | undefined;
        const mayReadArtifact = async (artifact: FileArtifact, fresh = false): Promise<boolean> => {
          if (
            conversation.audience.every((principal) =>
              principalEntitledToScope(principal, artifact.ownerScopeId, scopeId, resolution.orgScopeId),
            )
          )
            return true;
          let handles = fresh ? undefined : readableHandles;
          handles ??= await deps.acl.handlesForAudience(
            conversation.audience,
            scopeId,
            resolution.orgScopeId,
            principalEntitledToScope,
          );
          if (!fresh) readableHandles = handles;
          return handles.some(
            (handle) => handle.ownerScopeId === artifact.ownerScopeId && handle.fileId === artifact.id,
          );
        };
        const provisionOutbound = (sandboxId?: string) =>
          sandboxId !== undefined ? provisionResource(sandboxId) : provision();
        const openStoredOutbound = async (id: string) => {
          const artifact = await deps.files.get(id);
          if (!artifact || !(await mayReadArtifact(artifact, true))) return null;
          const opened = await deps.files.open(id);
          return opened ? { ...artifact, sizeBytes: opened.sizeBytes, stream: opened.stream } : null;
        };
        const surfaceToolDeps = createSurfaceToolDeps({
          deps,
          input,
          actor,
          conversation,
          session,
          scopeId,
          strictReadOnly,
          defaultDestination,
          blobTransfer,
          fileRegistration,
          provision: provisionOutbound,
          openStored: openStoredOutbound,
          postProvenance,
          postKeys,
          spine,
        });
        const attachStaging = createAttachStaging({
          sandbox: deps.sandbox,
          provision: provisionOutbound,
          openStored: openStoredOutbound,
          blobTransfer,
          fileRegistration,
        });
        if (input.surfaceTools && input.origin.kind === "automation" && input.origin.destination && !surfaceToolDeps)
          console.error(
            `[orchestrator] trigger delivery has no surface tools (no outbound sender?) — reply would be lost session=${session.id}`,
          );

        const canInstallCanvas =
          deps.installSharedCanvas &&
          liveTurn &&
          (await deps.featureFlags?.enabled("ui_canvas", personalScope(actor.id))) === true;
        const baseTools = createToolContext({
          desktopClientId: desktopClientForTurn(input),
          ...(canInstallCanvas
            ? {
                installSharedCanvas: (fileId: string) =>
                  deps.installSharedCanvas!(actor.id, fileId, {
                    threadRef: conversation.threadRef,
                    sessionId: session.id,
                  }),
              }
            : {}),
          sandbox: deps.sandbox,
          sandboxResources: turnSandboxResources,
          invalidateProvision,
          provision,
          provisionScratch,
          provisionResource,
          accessSandboxResource: accessResource,
          ...(provisionOwnerAuth ? { provisionOwnerAuth } : {}),
          ...(ownerAuthCommand ? { ownerAuthCommand } : {}),
          useSkill,
          listSkills: (source) => visibleSkillsForTurn(source ? [source] : [scopeId, resolution.orgScopeId]),
          ...(reachAvailable
            ? {
                reach: {
                  resolveChannel: (q: string) =>
                    resolveReachableChannel(q, { directory: deps.directory!, actorId: actor.id }),
                  provisionFor: provisionForReach,
                },
              }
            : {}),
          layers: resolution.layers,
          commandPolicy: () => commandPolicy,
          layerCommandRules: () => layerCommandRules,
          authorizeCommand,
          grantedHandles: resolution.grantedHandles,
          context,
          workspace: deps.workspace,
          deploy: deps.deploy,
          acl: deps.acl,
          files: deps.files,
          auditLog: deps.auditLog,
          createdBy: actor.id,
          commandCredentials,
          resolveCommandCredentials: async (handles) => {
            const refreshed = new Map<string, CommandCredential>();
            const identities = new Map<string, string>();
            const add: Parameters<typeof registerKeychainCredentials>[0] = (
              credential,
              _description,
              identity = credential.handle,
            ) => {
              const prior = identities.get(credential.handle);
              if (prior !== undefined) {
                if (prior !== identity) throw new Error(`credential handle collision: ${credential.handle}`);
                return;
              }
              identities.set(credential.handle, identity);
              refreshed.set(credential.handle, credential);
            };
            const broker = credentialBroker(handles);
            await registerKeychainCredentials(add, broker);
            await registerConnectorCredentials(add, broker);
            await registerServiceCredentials(add, broker);
            for (const credential of commandCredentials.filter((candidate) => candidate.handle.startsWith("broker_")))
              add(credential, "");
            return [...refreshed.values()];
          },
          ...(deps.publicWebUrl ? { publicWebUrl: deps.publicWebUrl } : {}),
          publishContext: {
            conversationKind: conversation.kind,
            ...(conversation.channelRef ? { channelRef: conversation.channelRef } : {}),
            ...(conversation.isPrivate !== undefined ? { isPrivate: conversation.isPrivate } : {}),
            ...(conversation.isMpim !== undefined ? { isMpim: conversation.isMpim } : {}),
            ...(conversation.publishMembers ? { publishMembers: conversation.publishMembers } : {}),
          },
          ...(deps.config ? { config: deps.config } : {}),
          ...(deps.control && controlClaims ? { control: deps.control, controlClaims } : {}),
          ...(deps.apiBaseUrl && connectorEnv.AGENT_API_TOKEN
            ? {
                admin: {
                  call: createAdminCall(deps.apiBaseUrl, connectorEnv.AGENT_API_TOKEN),
                  operationsAvailable:
                    actorIsOrgAdmin || Boolean(controlClaims?.grants?.some((grant) => grant.startsWith("admin."))),
                },
              }
            : {}),
          ...(deps.webhookPublicUrl ? { webhookPublicUrl: deps.webhookPublicUrl } : {}),
          ...(humanInput && !external ? { humanTurn: true } : {}),
          ...(deps.toolOutput ? { toolOutput: deps.toolOutput, sessionId: session.id } : {}),
          ...(surfaceToolDeps ? { surface: surfaceToolDeps } : {}),
          ...(sessionSyscalls
            ? {
                sessionSyscalls: sessionSyscalls.forTurn({
                  session,
                  scopeId: scopeId as ScopeId,
                  orgScopeId: resolution.orgScopeId,
                  liveTurn,
                  request: { ...input, readOnly: strictReadOnly, cancel: turnAbort.signal },
                }),
              }
            : {}),
          ...(strictReadOnly ? {} : { attach: attachStaging.attach }),
          memory: context.memory,
          memoryCaptureMetadata: () => ({ sessionId: session.id, inheritedFacts: captureDependencies() }),
          memoryScopeId,
          ...(memoryAccess ? { memoryAccess } : {}),
          ...(!external && deps.mcp ? { mcp: deps.mcp } : {}),
          ...(input.surface === "slack" ? { actingSlackUserId: actor.id } : {}),
          ...(deps.deploymentLayer
            ? {
                layerAuth: {
                  credentialPaths: deps.deploymentLayer.credentialPaths,
                  splitEnvTemplates: deps.deploymentLayer.splitEnvTemplates,
                },
              }
            : {}),
          sessionHistory: (() => {
            const historyView = async () => filterHistory(forSearchView(await deps.sessions.getItems(session.id)));
            return {
              search: async (q: string, limit?: number) => searchSessionItems(await historyView(), q, limit),
              open: async (seq: number) => openSessionItem(await historyView(), seq),
            };
          })(),
          ...(deps.execTimeoutMs !== undefined ? { execTimeoutMs: deps.execTimeoutMs } : {}),
          ...(deps.execTimeoutCeilingMs !== undefined ? { execTimeoutCeilingMs: deps.execTimeoutCeilingMs } : {}),
          ...(deps.ledger ? { ledger: deps.ledger } : {}),
          ...(deps.signals ? { signals: deps.signals } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          attempt: input.attempt ?? 1,
          ...(backgroundBroker ? { backgroundBroker } : {}),
          ...(monitorBroker ? { monitorBroker } : {}),
          onGapWork: (work) => {
            try {
              harnessOnGapWork?.(work);
            } catch (e) {
              swallow("gap-work forward", e);
            }
          },
        });

        const tools = external ? externalTools(baseTools, accessResource) : baseTools;

        if (input.attachments?.some((attachment) => attachment.sourceId)) {
          input.attachments = withoutAlreadyIngested(
            input.attachments,
            (await deps.sessions.getContextWindow(session.id)).items,
          );
        }
        const inbound =
          input.attachments?.length && !strictReadOnly
            ? await materializeInbound(
                deps.sandbox,
                provision,
                input.attachments,
                blobTransfer,
                fileRegistration,
                turnInboxDir,
                securityPolicy.screening !== "off" && (deps.securityScreener || deps.harness.models.screenSecurity)
                  ? ({ content }) =>
                      classifySecurityData(content, actor.id, scopeId, undefined, {
                        ...screenTrace,
                        sessionId: session.id,
                        hook: "tool_response",
                        request: input.text,
                        surface: "inbound_file",
                        origin: input.origin.kind,
                      })
                  : undefined,
              )
            : { metas: [], images: [], tooMany: [], unavailable: [], blocked: [], unscreened: [] };
        const manifest = inboundManifest(inbound.metas, turnInboxDir, inbound.unstaged);
        const inboundIssues = inboundIssueList({
          tooMany: inbound.tooMany,
          unavailable: inbound.unavailable,
          blocked: inbound.blocked,
          surfaceNotes: [
            ...(input.inboundNotes ?? []),
            ...(strictReadOnly
              ? (input.attachments ?? []).map(
                  (attachment) => `${safeAttachmentName(attachment.name)} — unavailable in Strict posture`,
                )
              : []),
          ],
        });

        const importedOverheard: OverheardEntryPayload[] = [];
        if ((!input.envelopeWrapped || humanInput) && input.overheard?.length) {
          const toImport = await transcripts
            .forRender(session.id)
            .then((read) => selectOverheardToImport(input.overheard!, recordedMessageTimestamps(read.items)))
            .catch(swallowAs("orchestrator: overheard catch-up import", [] as OverheardEntryPayload[]));
          let importedEntries: Item[] = [];
          try {
            importedEntries = await withManagedRosterVersion(() =>
              deps.sessions.appendMany(lease, toImport.map(overheardItem)),
            );
          } catch (e) {
            if (e instanceof ProjectRosterChanged) throw e;
            swallow("orchestrator: overheard catch-up import", e);
          }
          if (importedEntries.length) importedOverheard.push(...toImport);
        }

        const rawEntries = (await historyWindow()).items;
        const priorTurns = input.priorTurns;
        let visibleHistory = filterHistory(forModelContext(rawEntries));
        const recalled = await context.recallMemory(memoryRecallQuery(input.text, visibleHistory));
        const partial = isRetry ? (recordedTurn ?? findTrailingPartialTurn(visibleHistory, input.runId)) : null;
        let resumePlan = partial ? resumeStrategy(visibleHistory, partial) : null;
        if (partial && resumePlan?.kind === "settle") {
          const settle = resumePlan;
          const settled = await withManagedRosterVersion(() =>
            deps.sessions.appendMany(lease, unrecordedResultItems(settle, input.resumeCause)),
          );
          visibleHistory = filterHistory(forModelContext([...rawEntries, ...settled]));
          resumePlan = resumeStrategy(visibleHistory, partial);
        }
        const resume = resumePlan && resumePlan.kind !== "restart" ? partial : null;
        const documentBudget = documentTokenBudget(scopeId, input.model);
        const history = await withManagedRosterVersion(() =>
          compactContextIfNeeded({
            cancel: turnAbort.signal,
            session,
            lease,
            visibleHistory,
            scopeId,
            orgScopeId: resolution.orgScopeId,
            actorId: actor.id,
            ...(input.model ? { model: input.model } : {}),
            reservedTokens: strictReadOnly
              ? 0
              : inbound.metas.reduce(
                  (sum, meta) => sum + (isDocumentAttachment(meta) ? estimateDocumentTokens(meta) : 0),
                  0,
                ),
          }),
        );
        contextRecovered =
          history !== visibleHistory &&
          history.some((entry) => entry.kind === "ContextCompaction" && entry.body.mode === "recent");
        const documentInputs = strictReadOnly
          ? { documents: [], notices: [], tokens: 0 }
          : await loadDocumentInputs(
              deps.files,
              [...historicalDocumentMetas(history), ...inbound.metas],
              mayReadArtifact,
              undefined,
              turnAbort.signal,
              undefined,
              undefined,
              documentBudget,
            );
        const screenDocuments = async (
          documentInputs: Awaited<ReturnType<typeof loadDocumentInputs>>,
          requestText: string,
        ): Promise<boolean> => {
          let documentsUnscreened = false;
          if (securityPolicy.screening !== "off") {
            for (const document of documentInputs.documents.slice()) {
              documentsUnscreened ||= !isTextDocument(document);
              if (!(deps.securityScreener || deps.harness.models.screenSecurity)) {
                documentsUnscreened = true;
                continue;
              }
              let extracted: ExtractedDocumentText;
              try {
                extracted = await documentText(document, turnAbort.signal);
              } catch {
                turnAbort.signal.throwIfAborted();
                documentsUnscreened = true;
                continue;
              }
              const verdicts: Array<SecurityScreenVerdict | undefined> = [];
              for (const chunk of securityScreenChunks("tool_result:inbound_document", extracted.text)) {
                turnAbort.signal.throwIfAborted();
                const verdict = await classifySecurityData(chunk, actor.id, scopeId, undefined, {
                  ...screenTrace,
                  sessionId: session.id,
                  hook: "tool_response",
                  request: requestText,
                  surface: "inbound_file",
                  origin: input.origin.kind,
                });
                verdicts.push(verdict);
                if (verdict?.decision === "strict") break;
              }
              const verdict =
                verdicts.find((value) => value?.decision === "strict") ??
                verdicts.find((value) => value?.unscreened) ??
                verdicts[0];
              if (verdict?.decision === "strict") {
                documentInputs.documents.splice(documentInputs.documents.indexOf(document), 1);
                documentInputs.notices.push(
                  `${document.name}: document withheld by the external-data security screen.`,
                );
              } else if (
                !verdicts.every((value) => value?.decision === "auto" && !value.unscreened) ||
                extracted.truncated
              )
                documentsUnscreened = true;
            }
          }
          return enforceScreen && documentsUnscreened;
        };
        const observeDocuments = (inputs: Awaited<ReturnType<typeof loadDocumentInputs>>, requestText: string) =>
          void screenDocuments(inputs, requestText).catch(swallowAs("orchestrator: observed document screen", false));
        let documentsUnscreened = false;
        if (enforceScreen) documentsUnscreened = await screenDocuments(documentInputs, input.text);
        else observeDocuments(documentInputs, input.text);
        let remainingDocumentBytes =
          MAX_DOCUMENT_BYTES -
          documentInputs.documents.reduce((sum, document) => sum + Buffer.byteLength(document.dataBase64, "base64"), 0);
        let remainingDocumentCount = 10 - documentInputs.documents.length;
        let remainingDocumentTokens = documentBudget - documentInputs.tokens;
        const principalDelivered = await recentPrincipalDeliveryNote(
          deps.recentDmPosts,
          session.threadRef,
          visibleHistory.findLast((e) => isUserMessage(e) && !isOverheard(e))?.createdAt,
        );
        const sender = !automatedTurn && !sessionTurn && input.text.trim() ? senderNote(actor.displayName) : "";
        const unscreenedNote =
          inputUnscreened || (enforceScreen && inbound.unscreened.length) || documentsUnscreened
            ? unscreenedNotice("inbound content")
            : "";
        const usedSkills = history.flatMap((entry) =>
          entry.kind === "ToolCall" &&
          entry.tool === "skills" &&
          entry.body.action === "read" &&
          typeof entry.body.name === "string"
            ? [entry.body.name]
            : [],
        );
        turnContextBlocks["Skills"] = skillsIndex(nativeSkills, [scopeId, resolution.orgScopeId], usedSkills);
        const turnEnvironmentContents = [
          manifest,
          principalDelivered,
          sender,
          unscreenedNote,
          input.conversationHeader?.trim(),
          volatileContext,
        ]
          .filter((s) => s && s.trim())
          .join("\n\n");
        const baseText = input.proactiveOpener && !input.text.trim() ? PROACTIVE_OPENER_PROMPT : input.text;
        const pausedTurnUserEntry =
          input.approval && approvalRecord?.kind !== "input"
            ? [...visibleHistory].reverse().find((e) => isUserMessage(e) && !isOverheard(e))
            : undefined;
        const approvalReplay = !!pausedTurnUserEntry && (pausedTurnUserEntry.text ?? "").trim() === input.text.trim();
        if (partial) {
          const posted = completedSurfaceEnqueues(
            filterHistory(await deps.sessions.getItems(session.id, { sinceSeq: partial.userSeq })),
            partial.userSeq,
            surfaceName,
          );
          postKeys.seed(posted);
          spine.surfaceOutboundCount += posted;
        }
        if (partial) {
          deps.auditLog.record({
            at: Date.now(),
            principalId: actor.id,
            action: "turn.resume",
            resource: conversation.threadRef,
            scopeLabel: scopeId,
            detail: resume
              ? `attempt ${input.attempt}; resuming partial turn at seq ${partial.userSeq} (${partial.workEntries} recorded entries)`
              : `attempt ${input.attempt}; re-running turn at seq ${partial.userSeq} (no recorded work to resume)`,
          });
          console.error(
            `[orchestrator] turn.resume attempt=${input.attempt} thread=${conversation.threadRef} userSeq=${partial.userSeq} workEntries=${partial.workEntries} strategy=${resumePlan!.kind}`,
          );
        }
        let turnInput = baseText;
        const continueTurn = !!partial && history.some((entry) => entry.seq === partial.userSeq) && !releasedToolOutput;
        if (partial) spine.turnUserEntrySeq = partial.userSeq;
        if (releasedToolOutput) {
          turnInput = `The human released quarantined tool output recorded in the conversation. Continue the original task using that output. The tool action already ran; do not repeat it. Original task: ${baseText}`;
        }
        const isPollFire = automatedTurn && !!input.surface && isPollSurface(input.surface);
        const sessionUsedTools = visibleHistory.some(
          (e) => e.kind === "ToolCall" && !(e.tool === "skill" || (e.tool === "skills" && e.body.action === "read")),
        );
        if (
          !strictReadOnly &&
          deps.eagerProvision &&
          sessionUsedTools &&
          !isPollFire &&
          (await deps.sandboxResources?.resolve(memoryScopeId)) !== null
        ) {
          void provision(true).catch(swallowAs("orchestrator: eager provision", undefined));
        }
        const turnStart = Date.now();
        let firstTokenMarked = false;
        const emittedEntries: Item[] = [];
        let turnRuntime: TurnRuntime | undefined;
        const syntheticPrompt = syntheticInput || partial || approvalReplay || !!releasedToolOutput;
        failureUserItem =
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
        const effectiveTurnWallClockMs =
          typeof input.turnWallClockMs === "number" && input.turnWallClockMs > 0
            ? input.turnWallClockMs
            : (deps.defaultTurnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000);
        const runtimePurpose = turnRuntimePurpose(
          { surface: input.surface, triggered: automatedTurn },
          !!session.parentSessionId,
        );
        const purposeDefault = runtimePurpose ? await deps.config?.getPurposeRuntimeDurable(runtimePurpose) : undefined;
        const wantsOrgFastMode =
          typeof input.fastMode !== "boolean" &&
          !purposeDefault &&
          humanInput &&
          (await deps.config?.getInteractiveFastModeDurable());
        const effectiveFastMode = resolveTurnFastMode(input.fastMode, humanInput, wantsOrgFastMode === true);
        const loadRuntimeAuth = async (runtime: Partial<RuntimeChoice>) => {
          let userProviderKeys: ProviderKeys | undefined;
          let userModelOverride: string | undefined;
          let personalAuth = false;
          let authLabel = "api-key";
          const userCredStore = external ? undefined : deps.userModelCredentials;
          const account = external
            ? "company"
            : (input.modelAccount ?? (await deps.config?.getModelAccountDurable(actor.id)) ?? "company");
          if (userCredStore && humanInput && account !== "company") {
            const [anthCred, oaiCred] = await Promise.all([
              account === "openai" ? null : userCredStore.get(actor.id, "anthropic"),
              account === "anthropic" ? null : userCredStore.get(actor.id, "openai"),
            ]);
            const routing = resolveIndividualAuthRouting(
              anthCred ?? null,
              oaiCred ?? null,
              account === "personal" || input.surface === "web"
                ? (runtime.modelId ?? input.model ?? purposeDefault?.modelId)
                : (runtime.modelId ?? purposeDefault?.modelId),
            );
            if (routing?.kind === "apikey") {
              personalAuth = true;
              userProviderKeys = { [routing.provider]: routing.apiKey };
              userModelOverride = routing.model;
            } else if (routing?.kind === "oauth" && routing.provider === "anthropic" && anthCred?.oauth) {
              const derived = await userCredStore.derivedOAuth(actor.id, "anthropic");
              if (derived) {
                userProviderKeys = { anthropic: derived.accessToken };
                authLabel = "claude-oauth-pi";
                personalAuth = true;
                userModelOverride = routing.model;
              }
            } else if (routing?.kind === "oauth" && routing.provider === "openai" && oaiCred?.oauth) {
              const derived = await userCredStore.derivedOAuth(actor.id, "openai");
              if (derived) {
                userProviderKeys = { [CODEX_SUBSCRIPTION_PROVIDER]: derived.accessToken };
                authLabel = "codex-oauth-pi";
                personalAuth = true;
                userModelOverride = routing.model;
              }
            }
            if (!personalAuth) {
              throw new NonRetryableTurnError(
                "Your personal AI account is unavailable. Open Settings → AI access to reconnect Claude or ChatGPT / Codex, or choose company access. The chat cannot continue on company access.",
              );
            }
          }
          return { userProviderKeys, userModelOverride, personalAuth, authLabel };
        };
        const servesModel = (requested: string, routed: string | undefined, keys: ProviderKeys | undefined) =>
          (keys?.[CODEX_SUBSCRIPTION_PROVIDER] ? codexSubscriptionModelId(requested) : requested) === routed;
        const requestedModel = input.model ?? purposeDefault?.modelId;
        let { userProviderKeys, userModelOverride, personalAuth, authLabel } = await loadRuntimeAuth({});
        if (
          (input.surface === "web" || purposeDefault) &&
          personalAuth &&
          requestedModel &&
          !servesModel(requestedModel, userModelOverride, userProviderKeys)
        )
          throw new NonRetryableTurnError("Your connected AI account cannot serve this model.");
        const effectiveModel = userModelOverride ?? input.model;
        if (personalAuth) {
          console.log(`[individual-auth] user=${actor.id} model=${effectiveModel} auth=${authLabel}`);
        }
        let requestedRuntime: Partial<RuntimeChoice> = {
          ...(effectiveModel ? { modelId: effectiveModel } : {}),
          ...(input.thinkingLevel ? { effortLevel: input.thinkingLevel } : {}),
          ...(typeof effectiveFastMode === "boolean" ? { fastMode: effectiveFastMode } : {}),
        };
        const runtimeDefaults = requestedRuntime;
        const runtimeClaims: CapabilityClaims = controlClaims ?? {
          ...scopeAttestation,
          exp: Date.now() + CAPABILITY_TTL_MS,
          ...(liveAuthorTurn ? { liveAuthor: true } : {}),
          ...(automatedTurn ? { triggered: true } : {}),
        };
        const restoredRuntime =
          input.runId && isRetry
            ? recoveredRuntime(filterHistory(await deps.sessions.getItems(session.id)), input.runId, actor.id)
            : undefined;
        const checkRuntimeAuth = async (choice: RuntimeChoice): Promise<string | null> => {
          try {
            const auth = await loadRuntimeAuth(choice);
            if (auth.personalAuth && !servesModel(choice.modelId, auth.userModelOverride, auth.userProviderKeys))
              return "Your connected AI account cannot serve this model. Choose a compatible runtime from get.";
            return null;
          } catch (error) {
            return errMessage(error);
          }
        };
        let agentSwitch: "task" | "scope" | undefined;
        const adoptRuntime = async (choice: RuntimeChoice, lifetime: "task" | "scope") => {
          const error = await checkRuntimeAuth(choice);
          if (error) throw new NonRetryableTurnError(error);
          agentSwitch = lifetime;
          ({ userProviderKeys, userModelOverride, personalAuth, authLabel } = await loadRuntimeAuth(choice));
          requestedRuntime = userModelOverride ? { ...choice, modelId: userModelOverride } : choice;
        };
        if (restoredRuntime) await adoptRuntime(restoredRuntime.choice, restoredRuntime.lifetime);
        if (automatedTurn && input.model) {
          const error = await deps.validateScheduledRuntime?.(
            scopeId,
            {
              modelId: input.model,
              effortLevel: input.thinkingLevel,
              fastMode: input.fastMode,
            },
            runtimePurpose,
          );
          if (error) throw new NonRetryableTurnError(error);
        }
        const runHarnessSegment = async (
          harnessInput: string,
          extras: {
            priorTurns?: typeof input.priorTurns;
            overheard?: typeof importedOverheard;
            attachments?: typeof inbound.metas;
            images?: typeof inbound.images;
          },
          continuation?: { history: Item[] },
        ) => {
          const recall = memoryRecallDelta(
            recalled,
            continuation?.history ?? history,
            memoryView.held,
            context.memoryLabels,
          );
          const snapshot = environmentDelta(turnContextBlocks, continuation?.history ?? history, session.id);
          const turnEnvironment = environmentNote(
            [
              turnEnvironmentContents,
              snapshot.text,
              recall.text ? `${memoryHeading}${recall.text}` : "",
              inboundIssuesNote(inboundIssues),
            ]
              .filter(Boolean)
              .join("\n\n"),
          );
          const environment = [turnEnvironment, ...documentInputs.notices].filter(Boolean).join("\n");
          const silentResume = continueTurn && !continuation && !snapshot.text && !recall.text;
          let recordedRecall = false;
          const emit: HarnessTurnInput["emit"] = async (entry) => {
            turnProgress++;
            const persistStart = Date.now();
            try {
              const stored = ((): NewItem => {
                if (
                  (entry.kind === "AgentMessage" && !entry.variant) ||
                  entry.kind === "Elicitation" ||
                  ((entry.kind === "ToolResult" || entry.kind === "ToolCall") &&
                    entry.body?.blocked === "needs_approval")
                ) {
                  const body = { ...entry.body };
                  if (typeof body.workStartedAt !== "number") body.workStartedAt = input.runStartedAt ?? coreReceivedAt;
                  if (typeof body.workFinishedAt !== "number") body.workFinishedAt = Date.now();
                  return { ...entry, body };
                }
                if (entry.kind !== "UserMessage" && entry.kind !== "SteeringMessage") return entry;
                const body: Record<string, unknown> = { ...entry.body };
                const steered = entry.kind === "SteeringMessage";
                const overheard = body.overheard === true;
                const turnStart = !steered && !overheard;
                if (!recordedRecall && turnStart) {
                  recordedRecall = true;
                  body.environmentSnapshot = snapshot.record;
                  if (environment) body.environment = environment;
                  if (recall.text) body.memoryRecall = recall.record;
                }
                delete body.speakerId;
                if (humanInput && !syntheticPrompt && !continuation && turnStart) body.speakerId = actor.id;
                if (actor.displayName?.trim() && typeof body.name !== "string") body.name = actor.displayName.trim();
                if (input.displayText?.trim() && entry.text === input.text && typeof body.display !== "string")
                  body.display = input.displayText;
                if ((partial || continuation) && turnStart) body.resumeNote = true;
                return entry.kind === "UserMessage"
                  ? { ...entry, body, ...((syntheticPrompt || continuation) && { hidden: true }) }
                  : { ...entry, body };
              })();
              const appended = await withManagedRosterVersion(() => deps.sessions.append(lease, stored));
              emittedEntries.push(appended);
              if (isUserMessage(appended) && spine.turnUserEntrySeq === undefined) {
                spine.turnUserEntrySeq = appended.seq;
                if (input.runId && deps.runs)
                  await deps.runs
                    .noteTurnUserSeq(input.runId, appended.seq)
                    .catch(swallowAs("orchestrator: record turn boundary", false));
              }
              if (isUserMessage(appended)) failureUserItem = undefined;
              if (appended.kind === "ToolCall") {
                toolCalls += 1;
                if (toolCalls === 1 && input.runId) {
                  if (!input.surfaceTools) {
                    deps.turnStream?.noteToolCall(input.runId);
                  } else {
                    publishFirstAck(appended.tool === surfaceName && appended.body.action === "post");
                  }
                }
              }
              await mirrorRunActivity(appended);
              return appended;
            } finally {
              emitGapWork("persist", persistStart, Date.now());
            }
          };
          const initialDocuments = [...documentInputs.documents];
          const storedGoal = (await deps.sessions.goals([session.id])).get(session.id);
          const sessionGoal = openGoal(storedGoal);
          const saveGoal = async (goal: GoalRecord): Promise<void> => {
            await deps.sessions.setGoal(lease, goal);
            if (input.runId) deps.turnStream?.noteGoal(input.runId, goalView(goal));
          };
          const turnResult = await deps.harness.turns.runTurn({
            session,
            loadImage: artifactImageLoader(deps.files, mayReadArtifact),
            ...(turnTimezone ? { timezone: turnTimezone } : {}),
            prepareSteer: async (text, request) => {
              const author = request ? deps.identity.resolve(request.actor).id : actor.id;
              const refreshedInbox =
                input.surface === "web" &&
                conversation.kind === "dm" &&
                /^web:.+:inbox$/.test(conversation.threadRef) &&
                request?.conversation.threadRef === conversation.threadRef
                  ? request.conversationHeader?.trim()
                  : undefined;
              if (refreshedInbox) {
                let allowed = true;
                if (securityPolicy.screening !== "off") {
                  for (const chunk of securityScreenChunks("conversation-header", refreshedInbox)) {
                    const verdict = await classifySecurityData(chunk, actor.id, scopeId, recordScreenRequest, {
                      ...screenTrace,
                      sessionId: session.id,
                      hook: "user_input",
                      request: text,
                      surface: "steer",
                      origin: input.origin.kind,
                    });
                    if (verdict?.decision !== "auto" || verdict.unscreened) {
                      allowed = false;
                      break;
                    }
                  }
                }
                text = `${text}\n\n${allowed ? refreshedInbox : "Updated inbox context was withheld by the security screen."}`;
              }
              if (!request?.attachments?.length) return { text, author };
              const seed = `${fileRegistration.seed}:steer:${randomUUID()}`;
              const inboxDir = `${turnInboxDir}/${randomUUID()}`;
              const received = strictReadOnly
                ? { metas: [], images: [], tooMany: [], unavailable: [], blocked: [], unscreened: [] }
                : await materializeInbound(
                    deps.sandbox,
                    provision,
                    request.attachments,
                    blobTransfer,
                    { ...fileRegistration, seed },
                    inboxDir,
                    securityPolicy.screening !== "off"
                      ? ({ content, name, mimetype }) =>
                          classifySecurityData(
                            JSON.stringify({ name, mimetype, content }),
                            actor.id,
                            scopeId,
                            undefined,
                            {
                              ...screenTrace,
                              sessionId: session.id,
                              hook: "tool_response",
                              surface: "inbound_file",
                              origin: input.origin.kind,
                            },
                          )
                      : undefined,
                  );
              const steeredDocuments = await loadDocumentInputs(
                deps.files,
                received.metas,
                mayReadArtifact,
                remainingDocumentBytes,
                turnAbort.signal,
                remainingDocumentCount,
                initialDocuments,
                remainingDocumentTokens,
              );
              let steeredUnscreened = false;
              if (enforceScreen) steeredUnscreened = await screenDocuments(steeredDocuments, text);
              else observeDocuments(steeredDocuments, text);
              remainingDocumentBytes -= steeredDocuments.documents.reduce(
                (sum, document) => sum + Buffer.byteLength(document.dataBase64, "base64"),
                0,
              );
              remainingDocumentCount -= steeredDocuments.documents.length;
              remainingDocumentTokens -= steeredDocuments.tokens;
              documentInputs.documents.push(...steeredDocuments.documents);
              const issues = inboundIssueList({
                ...received,
                surfaceNotes: strictReadOnly
                  ? request.attachments.map((a) => `${safeAttachmentName(a.name)} — unavailable in read-only mode`)
                  : [],
              });
              return {
                text: [
                  text,
                  inboundManifest(received.metas, inboxDir, received.unstaged),
                  ...steeredDocuments.notices,
                  inboundIssuesNote(issues),
                  enforceScreen &&
                  (steeredUnscreened ||
                    received.unscreened.length ||
                    received.metas.some((a) => !isScreenableTextAttachment(a.mimetype)))
                    ? unscreenedNotice("inbound content")
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                attachments: received.metas,
                images: received.images,
                documents: steeredDocuments.documents,
                author,
              };
            },
            ...(userProviderKeys ? { providerKeys: userProviderKeys } : {}),
            ...(personalAuth && !purposeDefault && !restoredRuntime && runtimeHandoffs === 0
              ? { runtimePinned: true }
              : {}),
            runtimeActorId: actor.id,
            onRuntime: (reported: TurnRuntime) => {
              const runtime: TurnRuntime = agentSwitch ? { ...reported, change: { agent: agentSwitch } } : reported;
              turnRuntime = runtime;
              if (input.runId) deps.turnStream?.noteRuntime(input.runId, runtime);
            },
            ...(runtimePurpose ? { runtimePurpose } : {}),
            ...(deps.runtime && input.runId
              ? {
                  runtimeControl: (
                    active: RuntimeChoice,
                    request: import("../harness/runtime-types.ts").RuntimeRequest,
                    signal?: AbortSignal,
                  ) =>
                    deps.runtime!(
                      sessionTurn && request.lifetime === "scope"
                        ? { ...runtimeClaims, liveActor: false, liveAuthor: false }
                        : runtimeClaims,
                      active,
                      request,
                      checkRuntimeAuth,
                      personalAuth,
                      signal,
                      automatedTurn && input.surface === "cron",
                      runtimePurpose,
                      runtimeDefaults,
                    ),
                }
              : {}),
            ...(input.runId ? { runId: input.runId } : {}),
            cancel: turnAbort.signal,
            ...(silentResume ? { continueTurn: true, resumeUserSeq: partial!.userSeq } : {}),
            ...(input.shutdown ? { shutdown: input.shutdown } : {}),
            input: continueTurn && !continuation && !silentResume ? "" : harnessInput,
            ...(!partial && messageTs ? { triggerTs: messageTs } : {}),
            ...(!partial && entryTs ? { entryTs } : {}),
            ...(environment ? { environment } : {}),
            ...(extras.priorTurns?.length ? { priorTurns: extras.priorTurns } : {}),
            ...(extras.overheard?.length ? { overheard: extras.overheard } : {}),
            ...(extras.attachments?.length ? { attachments: extras.attachments } : {}),
            ...(extras.images?.length ? { images: extras.images } : {}),
            documents: initialDocuments,
            ...(Object.keys(requestedRuntime).length ? { runtime: requestedRuntime } : {}),
            ...(strictReadOnly ? { readOnly: true } : {}),
            surfaceName,
            delegateWork,
            ...((session.clientTools ?? input.clientTools)?.length
              ? { clientTools: session.clientTools ?? input.clientTools }
              : {}),
            ...(input.surfaceTools && surfaceToolDeps ? { surfaceTools: true } : {}),
            ...(isPollFire ? { pollFire: true } : {}),
            turnWallClockMs:
              effectiveTurnWallClockMs > 0
                ? Math.max(1, effectiveTurnWallClockMs - (Date.now() - turnStart))
                : effectiveTurnWallClockMs,
            ...(securityPolicy.screening !== "off"
              ? {
                  screenToolResult: async ({
                    tool,
                    result,
                    unscreenable,
                    provenance,
                    sourceScopeId,
                    source,
                  }: ToolResultScreenInput): Promise<ToolResultScreen> => {
                    if (provenance !== "external") return { outcome: "allow" };
                    const toolLabel = toolLabelOf(tool);
                    const sourceLabel = source ? `:${source.replace(/[^A-Za-z0-9_-]/g, "_")}` : "";
                    const screenChunk = (chunk: string) =>
                      classifySecurityData(chunk, actor.id, scopeId, recordScreenRequest, {
                        ...screenTrace,
                        sessionId: session.id,
                        hook: "tool_response",
                        request: input.text,
                        surface: toolLabel,
                        origin: input.origin.kind,
                      });
                    if (!enforceScreen) {
                      if (!unscreenable)
                        await Promise.all(
                          securityScreenChunks(`tool_result:${toolLabel}${sourceLabel}`, result).map(screenChunk),
                        );
                      return { outcome: "allow" };
                    }
                    if (authorizeCommand(quarantineReleaseKey(tool), quarantineReleaseKey(tool))) {
                      deps.auditLog.record({
                        at: Date.now(),
                        principalId: actor.id,
                        action: "security_posture.tool_result_released",
                        resource: input.surface ?? "unknown",
                        scopeLabel: scopeId,
                        status: "allowed",
                        detail: JSON.stringify({ reason: "human_release", tool: toolLabel }),
                      });
                      return { outcome: "unscreened" };
                    }
                    const chunks = unscreenable
                      ? []
                      : securityScreenChunks(`tool_result:${toolLabel}${sourceLabel}`, result);
                    if (!unscreenable && chunks.length === 0) return { outcome: "allow" };
                    const verdicts: Array<SecurityScreenVerdict | undefined> = [];
                    for (let i = 0; i < chunks.length && !verdicts.some((v) => v?.decision === "strict"); i += 4) {
                      verdicts.push(...(await Promise.all(chunks.slice(i, i + 4).map(screenChunk))));
                    }
                    const verdict =
                      verdicts.find((v) => v?.decision === "strict") ??
                      (verdicts.length === chunks.length &&
                      verdicts.every((v) => v?.decision === "auto" && !v.unscreened)
                        ? verdicts[0]
                        : undefined);
                    if (verdict?.decision === "auto" && !verdict.unscreened) return { outcome: "allow" };
                    if (verdict?.decision === "strict") {
                      const releaseKey = `security-screen-release:${toolLabel}`;
                      if (authorizeCommand(releaseKey)) {
                        deps.auditLog.record({
                          at: Date.now(),
                          principalId: actor.id,
                          action: "security_posture.tool_result_release",
                          resource: input.surface ?? "unknown",
                          scopeLabel: scopeId,
                          status: "allowed",
                          detail: JSON.stringify({ reason: "human_release", tool: toolLabel }),
                        });
                        return { outcome: "allow" };
                      }
                      deps.auditLog.record({
                        at: Date.now(),
                        principalId: actor.id,
                        action: SECURITY_TOOL_RESULT_QUARANTINE,
                        resource: input.surface ?? "unknown",
                        scopeLabel: scopeId,
                        status: "refused",
                        detail: JSON.stringify({
                          reason: "screen_verdict",
                          tool: toolLabel,
                          ...(source ? { source } : {}),
                          ...(verdict.reason ? { verdict: verdict.reason } : {}),
                        }),
                      });
                      if (
                        !quarantineReleaseApprovals.some(
                          (qa) =>
                            qa.approvalKey === releaseKey &&
                            qa.screenedOutput?.text === result &&
                            qa.screenedOutput?.sourceScopeId === sourceScopeId,
                        )
                      ) {
                        quarantineReleaseApprovals.push({
                          command: `release quarantined ${toolLabel} output`,
                          reason: verdict.reason
                            ? `security screen flagged this ${toolLabel} output: ${verdict.reason}`
                            : `security screen flagged this ${toolLabel} output`,
                          purpose: `Release the quarantined ${toolLabel} output into the conversation (once), or keep it blocked.`,
                          summary: `Blocked content preview: ${quarantinePreview(result)}`,
                          summaryDetail: quarantineFullText(result),
                          ...(!toolLabel.startsWith("session_message_")
                            ? {
                                screenedOutput: {
                                  tool: toolLabel,
                                  text: result,
                                  ...(sourceScopeId ? { sourceScopeId } : {}),
                                },
                              }
                            : {}),
                          approvalKey: releaseKey,
                          grantModes: { session: false, always: false },
                        });
                      }
                      return {
                        outcome: "quarantine",
                        approvalRequested: true,
                        ...(verdict.reason ? { reason: verdict.reason } : {}),
                      };
                    }
                    deps.auditLog.record({
                      at: Date.now(),
                      principalId: actor.id,
                      action: "security_posture.tool_result_failed_open",
                      resource: input.surface ?? "unknown",
                      scopeLabel: scopeId,
                      status: "allowed",
                      detail: JSON.stringify({
                        reason: unscreenable ? "unscreenable_payload" : UNSCREENED_REASON,
                      }),
                    });
                    return { outcome: "unscreened" };
                  },
                }
              : {}),
            toolApprovalGate: (tool: string, callKey?: string) => {
              if (callKey) return consumeApproval(callKey);
              return securityPolicy.toolApprovals !== "all" || authorizeToolCall(tool);
            },
            systemPrompt,
            history: continuation?.history ?? history,
            tools,
            ...(mcpToolsReady ? { mcpTools: await mcpToolsReady } : {}),
            ...(resumePlan?.kind === "retry" && !continuation ? { resumeToolCall: resumePlan.call } : {}),
            emit,
            goal: sessionGoal,
            saveGoal,
            scopeLabel: scopeId,
            orgScopeId: resolution.orgScopeId,
            onDelta: (chunk: string) => {
              if (!firstTokenMarked) {
                firstTokenMarked = true;
                markFirstToken();
              }
              if (input.runId && deps.turnStream && !input.surfaceTools) deps.turnStream.publish(input.runId, chunk);
              if (input.surfaceTools && spineFirstBlockOpen && spineFirstBlock.length < FIRST_BLOCK_CAPTURE_MAX_CHARS)
                spineFirstBlock += chunk;
            },
            onReasoningDelta: (step: string, index: number, chunk: string) => {
              if (input.runId && deps.turnStream && !input.surfaceTools)
                deps.turnStream.publishReasoning(input.runId, step, index, chunk);
            },
            onToolCallStart: (name: string) => {
              if (!earlyTaskAck || name === surfaceName) return;
              if (input.surfaceTools) publishFirstAck(false);
              else if (input.runId) deps.turnStream?.noteToolCall(input.runId);
            },
            onTextBlockStart: async (phase) => {
              if (input.runId && deps.turnStream && !input.surfaceTools) deps.turnStream.publishBlockStart(input.runId);
              if (input.surfaceTools && spineFirstBlock) spineFirstBlockOpen = false;
              if (!input.surfaceTools) {
                const streamOffset =
                  input.runId && deps.turnStream
                    ? deps.turnStream.startOffset(input.runId) + (deps.turnStream.snapshot(input.runId) ?? "").length
                    : undefined;
                if (input.runId && deps.runActivity) {
                  const started = deps.runActivity.append(input.runId, {
                    marker: "text_start",
                    seq: emittedEntries.at(-1)?.seq ?? 0,
                    createdAt: Date.now(),
                    ...(phase ? { phase } : {}),
                    ...(streamOffset !== undefined ? { streamOffset } : {}),
                  });
                  await (phase ? started : started.catch(swallowAs("orchestrator: text-start activity", undefined)));
                }
              }
            },
            onGapWork: (cb) => {
              harnessOnGapWork = cb;
            },
            recordModelCall: (rec) => {
              deps.modelGateway.recordCall({ at: Date.now(), scopeLabel: scopeId, ...rec });
              void deps.budget?.record(actor.id, estimateCostUsd(rec.inputTokens));
            },
            recordLlmRequest: async (rec, signal) => {
              try {
                await deps.sessions.recordLlmRequest(session.id, { ...rec, scopeLabel: scopeId }, signal);
              } catch (err) {
                reportFailure("orchestrator: persist LLM request snapshot", err);
              }
            },
          });
          return turnResult;
        };
        let runtimeHandoffs = restoredRuntime ? 1 : 0;
        const runHarnessTurn = async (...args: Parameters<typeof runHarnessSegment>) => {
          let segment = await runHarnessSegment(...args);
          while (segment.runtimeHandoff && !segment.stopped && !turnAbort.signal.aborted) {
            if (++runtimeHandoffs > 8) throw new NonRetryableTurnError("Too many runtime changes in one task");
            if (effectiveTurnWallClockMs && Date.now() - turnStart >= effectiveTurnWallClockMs)
              throw new NonRetryableTurnError("The task reached its wall-clock limit during runtime handoff");
            const recovery = "context" in segment.runtimeHandoff;
            if ("choice" in segment.runtimeHandoff) {
              await adoptRuntime(segment.runtimeHandoff.choice, segment.runtimeHandoff.lifetime);
            }
            let resumedHistory = filterHistory(forModelContext((await historyWindow()).items));
            if (recovery)
              resumedHistory = await withManagedRosterVersion(() =>
                compactRecent({
                  session,
                  lease,
                  visibleHistory: resumedHistory,
                  scopeId,
                  orgScopeId: resolution.orgScopeId,
                  actorId: actor.id,
                  ...(requestedRuntime.modelId ? { model: requestedRuntime.modelId } : {}),
                  cancel: turnAbort.signal,
                }),
              );
            contextRecovered ||= recovery;
            turnAbort.signal.throwIfAborted();
            segment = await runHarnessSegment(
              runtimeSwitchNote("choice" in segment.runtimeHandoff ? segment.runtimeHandoff.choice : undefined) +
                (recovery && !resumedHistory.some((entry) => isUserMessage(entry) && !!entry.text?.startsWith(baseText))
                  ? `\nCurrent request:\n${baseText}`
                  : ""),
              inbound.images.length ? { images: inbound.images } : {},
              { history: resumedHistory },
            );
          }
          return {
            ...segment,
            ...(segment.reply ? { reply: absoluteAppLinks(segment.reply, deps.publicWebUrl) } : {}),
          };
        };
        let result = await runHarnessTurn(turnInput, {
          ...(priorTurns?.length ? { priorTurns } : {}),
          ...(importedOverheard.length ? { overheard: importedOverheard } : {}),
          ...(inbound.metas.length ? { attachments: inbound.metas } : {}),
          ...(inbound.images.length ? { images: inbound.images } : {}),
        });
        if (
          input.addressed &&
          !strictReadOnly &&
          input.surfaceTools &&
          surfaceToolDeps &&
          !input.cancel?.aborted &&
          spine.surfaceOutboundCount === 0 &&
          !result.silent &&
          !result.stopped
        ) {
          // The model already wrote a reply as plain assistant text — deliver that text
          // directly instead of nudging it to re-post (a nudge here re-sends near-identical
          // text, which surfaces that render assistant entries show twice).
          const primaryReply = stripAckPrefix(result.reply ?? "", spineAckText).trim();
          if (primaryReply && defaultDestination && deps.outbound) {
            try {
              const directKey = postKeys.key(defaultDestination, postKeys.take());
              await reachPost({
                outbound: deps.outbound,
                destination: defaultDestination,
                text: primaryReply,
                idempotencyKey: directKey,
                provenance: postProvenance(directKey),
              });
              spine.surfaceOutboundCount += 1;
              if (input.runId) deps.turnStream?.markSurfacePosted(input.runId);
            } catch (e) {
              reportFailure("orchestrator: direct reply delivery", e, `session=${session.id}`);
            }
          }
          if (spine.surfaceOutboundCount === 0 && (!isPollFire || primaryReply)) {
            const nudgeHistory = filterHistory(forModelContext((await historyWindow()).items));
            result = await runHarnessTurn(ADDRESSED_NUDGE_MD, inbound.images.length ? { images: inbound.images } : {}, {
              history: nudgeHistory,
            });
            if (spine.surfaceOutboundCount === 0 && !result.silent && !result.stopped) {
              const fallback = stripAckPrefix(result.reply ?? "", spineAckText).trim();
              if (fallback && defaultDestination && deps.outbound) {
                try {
                  const fallbackKey = postKeys.key(defaultDestination, postKeys.take());
                  await reachPost({
                    outbound: deps.outbound,
                    destination: defaultDestination,
                    text: fallback,
                    idempotencyKey: fallbackKey,
                    provenance: postProvenance(fallbackKey),
                  });
                  spine.surfaceOutboundCount += 1;
                  if (input.runId) deps.turnStream?.markSurfacePosted(input.runId);
                } catch (e) {
                  console.error(
                    `[orchestrator] shed-reply fallback delivery failed session=${session.id}:`,
                    errMessage(e),
                  );
                }
              } else {
                console.error(`[orchestrator] addressed turn ended silent after nudge session=${session.id}`);
              }
            }
          }
        }

        const stagedAttachments = attachStaging.staged();
        const harvestedAck = (() => {
          if (input.surface !== "slack" || input.surfaceTools || !input.runId) return undefined;
          const fb = deps.turnStream?.firstBlock(input.runId);
          const text = fb?.text.trim();
          return fb?.closed && text ? text : undefined;
        })();
        const reply = stripAckPrefix(result.reply ?? "", harvestedAck);
        const cancelStopped = input.cancel?.aborted === true && result.stopped === true;

        const outcome = deriveTurnOutcome({
          ...(reply !== undefined ? { reply } : {}),
          attachments: stagedAttachments.length,
          pendingApprovals: result.pendingApprovals ?? [],
          terminatedOnApproval: result.pausedOnApproval === true,
        });
        const turnCompleted = outcome.completed;
        const pausing = outcome.paused;
        if (input.runId && !pausing && reply && reply.trim()) deps.turnStream?.markReplyDone(input.runId);
        const turnUserSeq = partial?.userSeq ?? emittedEntries.find(isUserMessage)?.seq;
        const onTurnEnd = memoryStrategy.onTurnEnd?.bind(memoryStrategy);
        if (!pausing && !cancelStopped && useMemory && memoryPolicy.capture !== "off" && onTurnEnd) {
          const prior = pendingCaptures.get(memoryScopeId);
          const capture = (async () => {
            if (prior) await prior.catch(swallowAs("prior memory capture", undefined));
            try {
              await onTurnEnd({
                scopeId: memoryScopeId,
                conversationScopeId: scopeId,
                inheritedFacts: captureDependencies(),
                input: turnInput,
                reply,
                actorId: actor.id,
                ...(automatedTurn ? { autonomous: true } : {}),
                sessionId: session.id,
                idempotencyKey: input.runId ?? `${session.id}:${spine.turnUserEntrySeq ?? "turn"}`,
              });
            } catch (e) {
              deps.errors?.record(
                {
                  category: "memory",
                  code: "capture_failed",
                  message: errMessage(e),
                  scopeLabel: scopeId,
                  sessionId: session.id,
                },
                e,
              );
            }
          })();
          pendingCaptures.set(memoryScopeId, capture);
          void capture.finally(() => {
            if (pendingCaptures.get(memoryScopeId) === capture) pendingCaptures.delete(memoryScopeId);
          });
        }

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
        if (turnRuntime) finalResult = { ...finalResult, runtime: turnRuntime };
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
        return await mapTurnFailure(ctx, { session, lease, failureUserItem }, err);
      } finally {
        if (input.runId) deps.turnStream?.end(input.runId);
        stopLeaseKeepalive();
        if (!tailOwnsCleanup) await reclaimBox();
        if (!leaseReleased) {
          await catchUpMessageRevisions();
          await deps.sessions.releaseLease(lease);
        }
        if (!contextRecovered && !turnAbort.signal.aborted)
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
