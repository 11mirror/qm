import { UNTRACKED_PROVENANCE } from "../../memory/facts.ts";
import { type ScopeId, type Session, type TurnResult } from "../../types.ts";
import type { DirectoryStore, DirectoryChannel, DirectoryMember } from "../../directory/directory-store.ts";
import type { GapPhase } from "../../sessions/session-store.ts";
import { type Item } from "../../sessions/items.ts";
import type { GapWork } from "../../harness/harness.ts";
import { createTranscriptSource } from "../../sessions/transcript-source.ts";
import { swallow, swallowAs } from "../../util/errors.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";
import { admitTurn } from "./admit.ts";
import { holdTurnLease } from "./turn-lease.ts";
import { openTurnSession, resolveTurnScope, resolveTurnWorkspace } from "./turn-context.ts";
import { observeInboundTurn } from "./inbound-screen.ts";
import { buildCredentialCatalog } from "./credential-catalog.ts";
import { frameTurnPrompt } from "./turn-prompt.ts";
import { concludeTurn, mapTurnFailure, settleTurnResult } from "./settle.ts";
import { detectAmbientDecline, findRecordedTurn, replayRecordedAnswer } from "./turn-replay.ts";
import { openTurnSandboxes } from "./turn-sandboxes.ts";
import { finishSystemPrompt } from "./turn-prompt.ts";
import { buildTurnTools, firstAckPublisher } from "./turn-tools.ts";
import { prepareTurnInput, turnFailureUserItem } from "./turn-input.ts";
import { selectTurnRuntime } from "./turn-runtime.ts";
import { createHarnessSegment, runSegments, type TurnRunState } from "./turn-segment.ts";
import { consumeApprovalDecision, loadApprovalLedger } from "./approvals.ts";
import { createSessionTitles } from "../session-title.ts";
import type { MemoryPolicy } from "../../memory/policy.ts";
import type { MemoryStrategy } from "../../memory/strategy.ts";
import type { CompactionContext } from "./compaction.ts";
import type { SecurityObserver } from "./security-screen.ts";

const MODEL_ACCESS_BLOCK =
  "## Model access\nAn OpenAI-compatible model gateway is at `$MODEL_GATEWAY_URL` in the sandbox; authenticate with `Authorization: Bearer $MODEL_GATEWAY_TOKEN`. `GET $MODEL_GATEWAY_URL/v1/models` lists the usable models. The token is bound to this turn and expires with it; never send it anywhere but the gateway.";

export interface OrchestratorInstance {
  deps: OrchestratorDeps;
  transcripts: ReturnType<typeof createTranscriptSource>;
  memoryPolicy: MemoryPolicy;
  memoryStrategy: MemoryStrategy;
  blobTransfer: OrchestratorDeps["blobTransfer"];
  pendingCaptures: Map<ScopeId, Promise<void>>;
  reachableChannelsFor: (directory: DirectoryStore, principalId: string) => Promise<DirectoryChannel[]>;
  directoryIndexFor: (directory: DirectoryStore) => Promise<Map<string, DirectoryMember>>;
  compaction: CompactionContext;
  observeSecurityData: SecurityObserver;
  titles: ReturnType<typeof createSessionTitles>;
}

export async function handleTurn(o: OrchestratorInstance, requested: OrchestratorInput): Promise<TurnResult> {
  const opened = await openTurn(o, requested);
  if (opened.done) return opened.result;
  const t = opened.turn;
  try {
    const begun = await beginHeldTurn(o, t);
    if (begun.done) return begun.result;
    return await executeHeldTurn(o, t, await prepareHeldTurnInput(o, t, begun));
  } catch (err) {
    return await mapTurnFailure(
      t.ctx,
      { session: t.session, lease: t.lease, failureUserItem: t.run.failureUserItem },
      err,
    );
  } finally {
    await releaseHeldTurn(o, t);
  }
}

type HeldTurn = Extract<Awaited<ReturnType<typeof openTurn>>, { done: false }>["turn"];
type BegunHeldTurn = Extract<Awaited<ReturnType<typeof beginHeldTurn>>, { done: false }>;
type PreparedHeldTurn = Awaited<ReturnType<typeof prepareHeldTurnInput>>;

async function openTurn(o: OrchestratorInstance, requested: OrchestratorInput) {
  const { deps, memoryPolicy, memoryStrategy, blobTransfer, observeSecurityData, titles } = o;
  const admission = await admitTurn(deps, requested);
  if ("refused" in admission) return { done: true as const, result: admission.refused };
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
  await context.memorySnapshot(false);
  const framed = await frameTurnPrompt(ctx, {
    screenTrace,
    useMemory,
    context,
    memoryScopeId,
    memoryStrategy,
    observeSecurityData,
  });
  const systemPrompt = framed.systemPrompt;
  const { turnContextBlocks, delivery, defaultDestination, configuredProviders, timeBlock, onboardingBlock } = framed;

  const session = await openTurnSession(ctx);

  const delegatedTask = !!input.sessionSenderId && session.parentSessionId === input.sessionSenderId;
  const syntheticInput =
    (input.proactiveOpener && !input.text.trim()) ||
    ((automatedTurn || (sessionTurn && input.envelopeWrapped)) && !delegatedTask);
  const { titleText, title, assignSessionTitle } = sessionTitling(titles, input, session, scopeId, syntheticInput);

  const isRetry = (input.attempt ?? 1) > 1;
  const recordedTurn = isRetry ? await findRecordedTurn(ctx, session) : null;
  const recordedReplay = recordedTurn ? replayRecordedAnswer(ctx, session, recordedTurn) : undefined;
  if (recordedReplay) return { done: true as const, result: recordedReplay };

  deps.auditLog.record({
    at: Date.now(),
    principalId: actor.id,
    action: "turn",
    resource: conversation.threadRef,
    scopeLabel: scopeId,
  });

  const approvalLedger = loadApprovalLedger(await actorGrants(), session.id, resolution.approvalGrantModes);
  const catalog = await buildCredentialCatalog(ctx, {
    strictReadOnly,
    sharingSources,
    delivery,
    defaultDestination,
    session,
  });
  if (catalog.sandboxModelGateway) turnContextBlocks["Model access"] = MODEL_ACCESS_BLOCK;
  const run = newTurnRunState();
  const { gapWork, emitGapWork } = createGapWork();
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
  if ("refused" in held) return { done: true as const, result: held.refused };
  const { lease, turnAbort, catchUpMessageRevisions, stopLeaseKeepalive, leaseState } = held;
  const cleanup = { tailOwns: false };
  if (!ambientTurn) assignSessionTitle();
  return {
    done: false as const,
    turn: {
      ctx,
      reconcileSessionParticipants,
      input,
      actor,
      ambientTurn,
      withManagedRosterVersion,
      mirrorRunActivity,
      resolution,
      scopeId,
      screenTrace,
      strictReadOnly,
      mcpToolsReady,
      useMemory,
      context,
      memoryScopeId,
      framed,
      systemPrompt,
      turnContextBlocks,
      defaultDestination,
      configuredProviders,
      timeBlock,
      onboardingBlock,
      session,
      syntheticInput,
      titleText,
      title,
      assignSessionTitle,
      isRetry,
      recordedTurn,
      approvalLedger,
      catalog,
      run,
      gapWork,
      emitGapWork,
      commandPolicy,
      layerCommandRules,
      reachAvailable,
      turnSandboxResources,
      sandboxes,
      provision,
      reclaimBox,
      lease,
      turnAbort,
      catchUpMessageRevisions,
      stopLeaseKeepalive,
      leaseState,
      cleanup,
    },
  };
}

async function beginHeldTurn(o: OrchestratorInstance, t: HeldTurn) {
  const { deps, transcripts, reachableChannelsFor, directoryIndexFor } = o;
  const {
    ctx,
    reconcileSessionParticipants,
    input,
    actor,
    ambientTurn,
    withManagedRosterVersion,
    mirrorRunActivity,
    resolution,
    scopeId,
    strictReadOnly,
    context,
    systemPrompt,
    turnContextBlocks,
    configuredProviders,
    timeBlock,
    onboardingBlock,
    session,
    assignSessionTitle,
    isRetry,
    recordedTurn,
    approvalLedger,
    catalog,
    run,
    reachAvailable,
    lease,
  } = t;
  await withManagedRosterVersion(async () => {
    await reconcileSessionParticipants(session.id);
    return true;
  });
  const memoryWindow = await deps.sessions.getContextWindow(session.id);

  const memoryView = await context.memorySnapshot();
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
  let approvalNote = "";
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
    if (decided.kind === "settled") return { done: true as const, result: decided.result };
    approvalNote = decided.approvalNote;
  }

  const { openSpeakerKeychain, credentialDescriptions, serviceCredRecords, grantedCredSlugs, actorIsOrgAdmin } =
    catalog;
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
  const volatileContext = [finished.volatileContext, approvalNote].filter(Boolean).join("\n\n");

  const declined = await detectAmbientDecline(ctx, {
    session,
    isRetry,
    recordedTurn,
    historyWindow,
    transcripts,
  });
  if (declined) return { done: true as const, result: declined };
  if (ambientTurn) assignSessionTitle();

  return {
    done: false as const,
    memoryView,
    captureDependencies,
    historyWindow,
    systemPrompt: finished.systemPrompt,
    volatileContext,
  };
}

async function prepareHeldTurnInput(o: OrchestratorInstance, t: HeldTurn, b: BegunHeldTurn) {
  const { deps, transcripts, blobTransfer, observeSecurityData } = o;
  const { compactContextIfNeeded, documentTokenBudget } = o.compaction;
  const {
    ctx,
    input,
    screenTrace,
    strictReadOnly,
    context,
    framed,
    defaultDestination,
    session,
    isRetry,
    recordedTurn,
    approvalLedger,
    catalog,
    run,
    gapWork,
    commandPolicy,
    layerCommandRules,
    reachAvailable,
    turnSandboxResources,
    sandboxes,
    provision,
    lease,
    turnAbort,
  } = t;
  const { captureDependencies, historyWindow, volatileContext } = b;
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
  const { approvalReplay, resume, isPollFire } = prepared;
  const publishFirstAck = firstAckPublisher(ctx, {
    turnTools,
    defaultDestination,
    isPollFire,
    resume,
    approvalReplay,
  });
  return { ...b, turnTools, prepared, publishFirstAck };
}

async function executeHeldTurn(o: OrchestratorInstance, t: HeldTurn, p: PreparedHeldTurn): Promise<TurnResult> {
  const { deps, memoryPolicy, memoryStrategy, blobTransfer, pendingCaptures, observeSecurityData, titles } = o;
  const { compactRecent } = o.compaction;
  const {
    ctx,
    input,
    scopeId,
    screenTrace,
    strictReadOnly,
    mcpToolsReady,
    useMemory,
    context,
    memoryScopeId,
    framed,
    session,
    syntheticInput,
    titleText,
    title,
    isRetry,
    approvalLedger,
    run,
    gapWork,
    emitGapWork,
    provision,
    reclaimBox,
    lease,
    turnAbort,
    catchUpMessageRevisions,
    leaseState,
    cleanup,
  } = t;
  const { memoryView, captureDependencies, historyWindow, systemPrompt, turnTools, prepared, publishFirstAck } = p;
  const { spine, surfaceToolDeps, attachStaging } = turnTools;
  const { inboundIssues, partial, approvalReplay, turnInput, isPollFire } = prepared;
  const turnStart = Date.now();
  const emittedEntries: Item[] = [];
  const syntheticPrompt = syntheticInput || partial || approvalReplay;
  run.failureUserItem = syntheticPrompt ? undefined : turnFailureUserItem(ctx, inboundIssues);
  const { controlClaims, scopeAttestation } = t.catalog;
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

  const { stagedAttachments, reply, cancelStopped, outcome, turnCompleted, pausing, turnUserSeq } = await concludeTurn(
    ctx,
    {
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
    },
  );

  const tail = async (): Promise<void> => {
    try {
      if (!pausing && turnCompleted && !session.title && !title.write) {
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
  await title.write;

  if (input.background) {
    cleanup.tailOwns = true;
    await catchUpMessageRevisions();
    await deps.sessions.releaseLease(lease);
    leaseState.released = true;
    void tail().catch(swallowAs("orchestrator: background tail", undefined));
  } else {
    await tail();
    cleanup.tailOwns = true;
  }
  await deps.errors?.flush();
  return finalResult;
}

async function releaseHeldTurn(o: OrchestratorInstance, t: HeldTurn): Promise<void> {
  const { deps } = o;
  const { scheduleBackgroundCompaction } = o.compaction;
  const {
    input,
    actor,
    resolution,
    scopeId,
    session,
    run,
    reclaimBox,
    lease,
    turnAbort,
    catchUpMessageRevisions,
    stopLeaseKeepalive,
    leaseState,
    cleanup,
  } = t;
  if (input.runId) deps.turnStream?.end(input.runId);
  stopLeaseKeepalive();
  if (!cleanup.tailOwns) await reclaimBox();
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

function newTurnRunState(): TurnRunState {
  return {
    toolCalls: 0,
    turnProgress: 0,
    firstTokenMarked: false,
    runtimeHandoffs: 0,
    contextRecovered: false,
    remainingDocumentBytes: 0,
    remainingDocumentCount: 0,
    remainingDocumentTokens: 0,
  };
}

function createGapWork() {
  const gapWork: { listener?: (work: GapWork) => void } = {};
  const emitGapWork = (phase: GapPhase, start: number, end: number): void => {
    try {
      gapWork.listener?.({ phase, start, end });
    } catch (e) {
      swallow("gap-work emit", e);
    }
  };
  return { gapWork, emitGapWork };
}

function sessionTitling(
  titles: OrchestratorInstance["titles"],
  input: OrchestratorInput,
  session: Session,
  scopeId: ScopeId,
  syntheticInput: boolean | undefined,
) {
  const titleText = input.displayText?.trim() || input.text;
  const title: { write?: Promise<void> } = {};
  const assignSessionTitle = () => {
    if (!session.title && !syntheticInput && !input.approval)
      title.write = titles.titleFromFirstMessage(session, scopeId, titleText);
  };
  return { titleText, title, assignSessionTitle };
}
