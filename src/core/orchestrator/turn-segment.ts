import { surfaceTraits } from "../../surfaces/surface.ts";
import type { TurnCtx } from "./turn-context.ts";
import type { ScreenTrace } from "./inbound-screen.ts";
import type { frameTurnPrompt } from "./turn-prompt.ts";
import type { ApprovalLedger } from "./approvals.ts";
import type { buildTurnTools } from "./turn-tools.ts";
import type { prepareTurnInput } from "./turn-input.ts";
import type { selectTurnRuntime } from "./turn-runtime.ts";
import type { SecurityObserver } from "./security-screen.ts";
import type { Outbound } from "../../surfaces/outbound.ts";
import type { Session } from "../../types.ts";
import { markFirstToken } from "../../../plugins/chassis/src/error-reporting.ts";
import { memoryRecallDelta } from "../../memory/recall-delta.ts";
import { loadDocumentInputs } from "../document-inputs.ts";
import { goalView } from "../../runs/turn-stream.ts";
import { type GoalRecord, openGoal } from "../../harness/goal.ts";
import { type Destination, type TurnRuntime } from "../../types.ts";
import { loadProtocolFile } from "../../resolution/prompt-vars.ts";
import { resolveTurnContext } from "../../resolution/turn-context.ts";
import { reachPost } from "../../reach/reach.ts";
import type { GapPhase, Lease } from "../../sessions/session-store.ts";
import { isUserMessage, type Item, type NewItem } from "../../sessions/items.ts";
import { environmentDelta } from "../environment-facts.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import type { GapWork, HarnessTurnInput, RuntimeChoice } from "../../harness/harness.ts";
import { forModelContext } from "../../harness/context-compaction.ts";
import { securityScreenChunks, toolLabelOf, type ToolResultScreenInput } from "../../security/security-screen.ts";
import { artifactImageLoader } from "../../harness/replay-images.ts";
import {
  environmentNote,
  inboundIssuesNote,
  inboundIssueList,
  inboundManifest,
  materializeInbound,
  safeAttachmentName,
} from "../attachments.ts";
import { runtimeSwitchNote } from "../turn-resume.ts";
import { errMessage, reportFailure, swallowAs } from "../../util/errors.ts";
import { absoluteAppLinks } from "../../util/markdown.ts";
import { NonRetryableTurnError } from "../turn-error.ts";
import { randomUUID } from "node:crypto";
import type { OrchestratorDeps } from "./types.ts";
import { stripAckPrefix } from "./turn-helpers.ts";
import { createCompaction } from "./compaction.ts";
import { createTurnSandboxes } from "./sandboxes.ts";

const FIRST_BLOCK_CAPTURE_MAX_CHARS = 20_000;
const ADDRESSED_NUDGE_MD = loadProtocolFile("turn-addressed-nudge");

export interface TurnRunState {
  toolCalls: number;
  turnProgress: number;
  failureUserItem?: NewItem<"UserMessage">;
  firstTokenMarked: boolean;
  turnRuntime?: TurnRuntime;
  runtimeHandoffs: number;
  contextRecovered: boolean;
  remainingDocumentBytes: number;
  remainingDocumentCount: number;
  remainingDocumentTokens: number;
}

export function createHarnessSegment(
  ctx: TurnCtx,
  turn: {
    screenTrace: ScreenTrace;
    framed: Awaited<ReturnType<typeof frameTurnPrompt>>;
    approvalLedger: ApprovalLedger;
    provision: ReturnType<typeof createTurnSandboxes>["provision"];
    turnTools: Awaited<ReturnType<typeof buildTurnTools>>;
    prepared: Awaited<ReturnType<typeof prepareTurnInput>>;
    selected: Awaited<ReturnType<typeof selectTurnRuntime>>;
    strictReadOnly: boolean;
    mcpToolsReady: ReturnType<NonNullable<OrchestratorDeps["mcp"]>["toolDefsFor"]> | undefined;
    context: Awaited<ReturnType<typeof resolveTurnContext>>;
    memoryView: Awaited<ReturnType<Awaited<ReturnType<typeof resolveTurnContext>>["memorySnapshot"]>>;
    systemPrompt: string;
    session: Session;
    gapWork: { listener?: (work: GapWork) => void };
    emitGapWork: (phase: GapPhase, start: number, end: number) => void;
    lease: Lease;
    turnAbort: AbortController;
    run: TurnRunState;
    publishFirstAck: (deliberatePost: boolean) => void;
    turnStart: number;
    emittedEntries: Item[];
    syntheticPrompt: boolean;
    blobTransfer: OrchestratorDeps["blobTransfer"];
    observeSecurityData: SecurityObserver;
  },
) {
  const {
    deps,
    input,
    actor,
    conversation,
    automatedTurn,
    sessionTurn,
    humanInput,
    messageTs,
    entryTs,
    coreReceivedAt,
    turnTimezone,
    withManagedRosterVersion,
    mirrorRunActivity,
    resolution,
    scopeId,
  } = ctx;
  const { surfaceName, delegateWork, turnContextBlocks, turnInboxDir, memoryHeading } = turn.framed;
  const { consume: consumeApproval } = turn.approvalLedger;
  const { spine, spineFirst, fileRegistration, earlyTaskAck, mayReadArtifact, surfaceToolDeps, tools } = turn.turnTools;
  const {
    inboundIssues,
    recalled,
    partial,
    resumePlan,
    history,
    documentInputs,
    observeDocuments,
    turnEnvironmentContents,
    continueTurn,
    isPollFire,
  } = turn.prepared;
  const {
    effectiveTurnWallClockMs,
    runtimePurpose,
    purposeDefault,
    runtimeDefaults,
    runtimeClaims,
    restoredRuntime,
    checkRuntimeAuth,
    runtimeState,
  } = turn.selected;
  const {
    screenTrace,
    provision,
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
    syntheticPrompt,
    blobTransfer,
    observeSecurityData,
  } = turn;
  const runHarnessSegment = async (
    harnessInput: string,
    extras: {
      priorTurns?: typeof input.priorTurns;
      overheard?: typeof turn.prepared.importedOverheard;
      attachments?: typeof turn.prepared.inbound.metas;
      images?: typeof turn.prepared.inbound.images;
    },
    continuation?: { history: Item[] },
  ) => {
    const recall = memoryRecallDelta(recalled, continuation?.history ?? history, memoryView.held, context.memoryLabels);
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
      run.turnProgress++;
      const persistStart = Date.now();
      try {
        const stored = ((): NewItem => {
          if (
            (entry.kind === "AgentMessage" && !entry.variant) ||
            entry.kind === "Elicitation" ||
            ((entry.kind === "ToolResult" || entry.kind === "ToolCall") && entry.body?.blocked === "needs_approval")
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
        if (isUserMessage(appended)) run.failureUserItem = undefined;
        if (appended.kind === "ToolCall") {
          run.toolCalls += 1;
          if (run.toolCalls === 1 && input.runId) {
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
          surfaceTraits(input.surface).sidebar &&
          conversation.kind === "dm" &&
          /^web:.+:inbox$/.test(conversation.threadRef) &&
          request?.conversation.threadRef === conversation.threadRef
            ? request.conversationHeader?.trim()
            : undefined;
        if (refreshedInbox) {
          for (const chunk of securityScreenChunks("conversation-header", refreshedInbox))
            void observeSecurityData(chunk, actor.id, scopeId, {
              ...screenTrace,
              sessionId: session.id,
              hook: "user_input",
              request: text,
              surface: "steer",
              origin: input.origin.kind,
            });
          text = `${text}\n\n${refreshedInbox}`;
        }
        if (!request?.attachments?.length) return { text, author };
        const seed = `${fileRegistration.seed}:steer:${randomUUID()}`;
        const inboxDir = `${turnInboxDir}/${randomUUID()}`;
        const received = strictReadOnly
          ? { metas: [], images: [], tooMany: [], unavailable: [] }
          : await materializeInbound(
              deps.sandbox,
              provision,
              request.attachments,
              blobTransfer,
              { ...fileRegistration, seed },
              inboxDir,
              ({ content, name, mimetype }) =>
                void observeSecurityData(JSON.stringify({ name, mimetype, content }), actor.id, scopeId, {
                  ...screenTrace,
                  sessionId: session.id,
                  hook: "tool_response",
                  surface: "inbound_file",
                  origin: input.origin.kind,
                }),
            );
        const steeredDocuments = await loadDocumentInputs(
          deps.files,
          received.metas,
          mayReadArtifact,
          run.remainingDocumentBytes,
          turnAbort.signal,
          run.remainingDocumentCount,
          initialDocuments,
          run.remainingDocumentTokens,
        );
        observeDocuments(steeredDocuments, text);
        run.remainingDocumentBytes -= steeredDocuments.documents.reduce(
          (sum, document) => sum + Buffer.byteLength(document.dataBase64, "base64"),
          0,
        );
        run.remainingDocumentCount -= steeredDocuments.documents.length;
        run.remainingDocumentTokens -= steeredDocuments.tokens;
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
          ]
            .filter(Boolean)
            .join("\n\n"),
          attachments: received.metas,
          images: received.images,
          documents: steeredDocuments.documents,
          author,
        };
      },
      ...(runtimeState.userProviderKeys ? { providerKeys: runtimeState.userProviderKeys } : {}),
      ...(runtimeState.personalAuth && !purposeDefault && !restoredRuntime && run.runtimeHandoffs === 0
        ? { runtimePinned: true }
        : {}),
      runtimeActorId: actor.id,
      onRuntime: (reported: TurnRuntime) => {
        const runtime: TurnRuntime = runtimeState.agentSwitch
          ? { ...reported, change: { agent: runtimeState.agentSwitch } }
          : reported;
        run.turnRuntime = runtime;
        if (input.runId) deps.turnStream?.noteRuntime(input.runId, runtime);
      },
      ...(runtimePurpose ? { runtimePurpose } : {}),
      ...(deps.runtime && input.runId
        ? {
            runtimeControl: (
              active: RuntimeChoice,
              request: import("../../harness/runtime-types.ts").RuntimeRequest,
              signal?: AbortSignal,
            ) =>
              deps.runtime!(
                sessionTurn && request.lifetime === "scope"
                  ? { ...runtimeClaims, liveActor: false, liveAuthor: false }
                  : runtimeClaims,
                active,
                request,
                checkRuntimeAuth,
                runtimeState.personalAuth,
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
      ...(Object.keys(runtimeState.requestedRuntime).length ? { runtime: runtimeState.requestedRuntime } : {}),
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
      observeToolResult: ({ tool, result, unscreenable, provenance, source }: ToolResultScreenInput) => {
        if (provenance !== "external" || unscreenable) return;
        const toolLabel = toolLabelOf(tool);
        const sourceLabel = source ? `:${source.replace(/[^A-Za-z0-9_-]/g, "_")}` : "";
        for (const chunk of securityScreenChunks(`tool_result:${toolLabel}${sourceLabel}`, result))
          void observeSecurityData(chunk, actor.id, scopeId, {
            ...screenTrace,
            sessionId: session.id,
            hook: "tool_response",
            request: input.text,
            surface: toolLabel,
            origin: input.origin.kind,
          });
      },
      toolApprovalGate: consumeApproval,
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
        if (!run.firstTokenMarked) {
          run.firstTokenMarked = true;
          markFirstToken();
        }
        if (input.runId && deps.turnStream && !input.surfaceTools) deps.turnStream.publish(input.runId, chunk);
        if (input.surfaceTools && spineFirst.open && spineFirst.block.length < FIRST_BLOCK_CAPTURE_MAX_CHARS)
          spineFirst.block += chunk;
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
        if (input.surfaceTools && spineFirst.block) spineFirst.open = false;
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
        gapWork.listener = cb;
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
  return runHarnessSegment;
}

export async function runSegments(
  ctx: TurnCtx,
  turn: {
    framed: Awaited<ReturnType<typeof frameTurnPrompt>>;
    turnTools: Awaited<ReturnType<typeof buildTurnTools>>;
    prepared: Awaited<ReturnType<typeof prepareTurnInput>>;
    selected: Awaited<ReturnType<typeof selectTurnRuntime>>;
    strictReadOnly: boolean;
    session: Session;
    run: TurnRunState;
    lease: Lease;
    turnAbort: AbortController;
    historyWindow: () => ReturnType<OrchestratorDeps["sessions"]["getContextWindow"]>;
    turnStart: number;
    runHarnessSegment: ReturnType<typeof createHarnessSegment>;
    compactRecent: ReturnType<typeof createCompaction>["compactRecent"];
  },
) {
  const { deps, input, actor, withManagedRosterVersion, resolution, scopeId, filterHistory } = ctx;
  const { defaultDestination } = turn.framed;
  const { surfaceToolDeps, spine, spineFirst, postKeys, postProvenance } = turn.turnTools;
  const { inbound, importedOverheard, priorTurns, baseText, turnInput, isPollFire } = turn.prepared;
  const { effectiveTurnWallClockMs, adoptRuntime, runtimeState } = turn.selected;
  const { strictReadOnly, session, run, lease, turnAbort, historyWindow, turnStart, runHarnessSegment, compactRecent } =
    turn;
  const runHarnessTurn = async (...args: Parameters<typeof runHarnessSegment>) => {
    let segment = await runHarnessSegment(...args);
    while (segment.runtimeHandoff && !segment.stopped && !turnAbort.signal.aborted) {
      if (++run.runtimeHandoffs > 8) throw new NonRetryableTurnError("Too many runtime changes in one task");
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
            ...(runtimeState.requestedRuntime.modelId ? { model: runtimeState.requestedRuntime.modelId } : {}),
            cancel: turnAbort.signal,
          }),
        );
      run.contextRecovered ||= recovery;
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
  const postToDefault = async (outbound: Outbound, destination: Destination, text: string): Promise<void> => {
    const key = postKeys.key(destination, postKeys.take());
    await reachPost({ outbound, destination, text, idempotencyKey: key, provenance: postProvenance(key) });
    spine.surfaceOutboundCount += 1;
    if (input.runId) deps.turnStream?.markSurfacePosted(input.runId);
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
    const primaryReply = stripAckPrefix(result.reply ?? "", spineFirst.ackText).trim();
    if (primaryReply && defaultDestination && deps.outbound) {
      try {
        await postToDefault(deps.outbound, defaultDestination, primaryReply);
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
        const fallback = stripAckPrefix(result.reply ?? "", spineFirst.ackText).trim();
        if (fallback && defaultDestination && deps.outbound) {
          try {
            await postToDefault(deps.outbound, defaultDestination, fallback);
          } catch (e) {
            console.error(`[orchestrator] shed-reply fallback delivery failed session=${session.id}:`, errMessage(e));
          }
        } else {
          console.error(`[orchestrator] addressed turn ended silent after nudge session=${session.id}`);
        }
      }
    }
  }
  return result;
}
