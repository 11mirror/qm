import { surfaceHas } from "../../surfaces/surface.ts";
import type { TurnCtx } from "./turn-context.ts";
import type { ApprovalLedger } from "./approvals.ts";
import type { selectTurnRuntime } from "./turn-runtime.ts";
import type { BegunTurn, HeldLease, ReadyTurn, TurnFrame } from "./handle-turn.ts";
import type { SecurityObserver } from "./security-screen.ts";
import type { Outbound } from "../../surfaces/outbound.ts";
import type { Session } from "../../types.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";
import { markFirstToken } from "../../../plugins/chassis/src/error-reporting.ts";
import { memoryRecallDelta } from "../../memory/recall-delta.ts";
import { loadDocumentInputs } from "../document-inputs.ts";
import { type GoalRecord, openGoal } from "../../harness/goal.ts";
import { type Destination, type TurnRuntime } from "../../types.ts";
import { loadProtocolFile } from "../../resolution/prompt-vars.ts";
import { postCounted } from "./surface-tools.ts";
import { isUserMessage, stepMessage, type Item, type NewItem } from "../../sessions/items.ts";
import { environmentDelta } from "../environment-facts.ts";
import type { HarnessTurnInput, RuntimeChoice } from "../../harness/harness.ts";
import { forModelContext } from "../../harness/context-compaction.ts";
import { securityScreenChunks, toolLabelOf, type ToolResultScreenInput } from "../../security/security-screen.ts";
import { artifactImageLoader } from "../../harness/replay-images.ts";
import { environmentNote, inboundIssuesNote } from "../attachments.ts";
import { runtimeSwitchNote } from "../turn-resume.ts";
import { reportFailure, swallowAs } from "../../util/errors.ts";
import { absoluteAppLinks } from "../../util/markdown.ts";
import { NonRetryableTurnError } from "../turn-error.ts";
import { randomUUID } from "node:crypto";
import { modelCallRecorder, stripAckPrefix } from "./turn-helpers.ts";
import { documentBytes, stageAttachments } from "./turn-input.ts";
import { createCompaction } from "./compaction.ts";
import { createTurnSandboxes } from "./sandboxes.ts";
import { isWebInboxThreadRef } from "../../sessions/thread-ref.ts";

const ADDRESSED_NUDGE_MD = loadProtocolFile("turn-addressed-nudge");

const ACTIVITY_KINDS = new Set<Item["kind"]>([
  "ToolCall",
  "ToolResult",
  "Elicitation",
  "ElicitationResponse",
  "SteeringMessage",
]);

export async function mirrorRunActivity(
  deps: OrchestratorDeps,
  input: OrchestratorInput,
  appended: Item,
): Promise<void> {
  if (!input.runId || !deps.runActivity) return;
  const append = (item: Item) =>
    deps.runActivity!.append(input.runId!, { item }).catch(swallowAs("orchestrator: run-activity append", undefined));
  if (ACTIVITY_KINDS.has(appended.kind) || (appended.kind === "AgentMessage" && appended.variant === "narration")) {
    await append(appended);
  } else if (appended.kind === "Reasoning") {
    const id = stepMessage(appended)?.id;
    const step = typeof id === "string" && appended.step !== null ? { id, index: appended.step } : undefined;
    if (appended.body.redacted !== true && appended.text?.trim())
      await append({ ...appended, body: step ? { wire: { message: { id: step.id } } } : {} });
    if (step) deps.turnStream?.settleReasoning(input.runId, step.id, step.index);
  }
}

export interface TurnRunState {
  toolCalls: number;
  failureUserItem?: NewItem<"UserMessage">;
  firstTokenMarked: boolean;
  turnRuntime?: TurnRuntime;
  runtimeHandoffs: number;
  contextRecovered: boolean;
  remainingDocumentBytes: number;
  remainingDocumentTokens: number;
  turnStart: number;
  emittedEntries: Item[];
  tailOwnsReclaim: boolean;
}

export interface SegmentTurn {
  frame: TurnFrame;
  session: Session;
  held: HeldLease;
  run: TurnRunState;
  begun: BegunTurn;
  ready: ReadyTurn;
  selected: Awaited<ReturnType<typeof selectTurnRuntime>>;
  approvalLedger: ApprovalLedger;
  provision: ReturnType<typeof createTurnSandboxes>["provision"];
  observeSecurityData: SecurityObserver;
}

type Prepared = ReadyTurn["prepared"];

async function runHarnessSegment(
  ctx: TurnCtx,
  turn: SegmentTurn,
  harnessInput: string,
  extras: {
    priorTurns?: typeof ctx.input.priorTurns;
    overheard?: Prepared["importedOverheard"];
    attachments?: Prepared["inbound"]["metas"];
    images?: Prepared["inbound"]["images"];
  },
  continuation?: { history: Item[] },
) {
  const { deps, input, messageTs, entryTs, turnTimezone, resolution, scopeId, strictReadOnly } = ctx;
  const { frame, ready, session, held, run } = turn;
  const { surfaceName, delegateWork } = frame.framed;
  const { consume: consumeApproval } = turn.approvalLedger;
  const { mayReadArtifact, surfaceToolDeps, tools } = ready.turnTools;
  const { partial, resumePlan, history, documentInputs, continueTurn, isPollFire } = ready.prepared;
  const { effectiveTurnWallClockMs, runtimeState } = turn.selected;
  const { mcpToolsReady } = frame;
  const { systemPrompt } = turn.begun;
  const { lease, turnAbort } = held;
  const { turnStart } = run;
  const segmentEnv = segmentEnvironment(
    { frame, prepared: ready.prepared, memoryView: turn.begun.memoryView, session },
    continuation,
  );
  const { environment, silentResume } = segmentEnv;
  const emit = createSegmentEmit(ctx, { framed: frame.framed, ready, lease, run }, segmentEnv, continuation);
  const initialDocuments = [...documentInputs.documents];
  const storedGoal = (await deps.sessions.goals([session.id])).get(session.id);
  const sessionGoal = openGoal(storedGoal);
  const saveGoal = async (goal: GoalRecord): Promise<void> => {
    await deps.sessions.setGoal(lease, goal);
  };
  const turnResult = await deps.harness.turns.runTurn({
    session,
    loadImage: artifactImageLoader(deps.files, mayReadArtifact),
    ...(turnTimezone ? { timezone: turnTimezone } : {}),
    prepareSteer: createPrepareSteer(ctx, turn, initialDocuments),
    ...segmentRuntimeOptions(ctx, turn.selected, run),
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
    ...segmentCallbacks(ctx, turn),
  });
  return turnResult;
}

function segmentEnvironment(
  turn: { frame: TurnFrame; prepared: Prepared; memoryView: BegunTurn["memoryView"]; session: Session },
  continuation: { history: Item[] } | undefined,
) {
  const { turnContextBlocks, memoryHeading } = turn.frame.framed;
  const { inboundIssues, recalled, history, documentInputs, turnEnvironmentContents, continueTurn } = turn.prepared;
  const { context } = turn.frame;
  const { memoryView, session } = turn;
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
  return { recall, snapshot, environment, silentResume };
}

function createSegmentEmit(
  ctx: TurnCtx,
  turn: { framed: TurnFrame["framed"]; ready: ReadyTurn; lease: HeldLease["lease"]; run: TurnRunState },
  { recall, snapshot, environment }: ReturnType<typeof segmentEnvironment>,
  continuation: { history: Item[] } | undefined,
): HarnessTurnInput["emit"] {
  const { deps, input, actor, humanInput, coreReceivedAt, withManagedRosterVersion } = ctx;
  const { surfaceName } = turn.framed;
  const { spine } = turn.ready.turnTools;
  const { partial } = turn.ready.prepared;
  const { publishFirstAck, syntheticPrompt } = turn.ready;
  const { lease, run } = turn;
  const { emittedEntries } = run;
  let recordedRecall = false;
  const emit: HarnessTurnInput["emit"] = async (entry) => {
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
    await mirrorRunActivity(deps, input, appended);
    return appended;
  };
  return emit;
}

function createPrepareSteer(
  ctx: TurnCtx,
  turn: Pick<SegmentTurn, "frame" | "ready" | "session" | "held" | "run" | "provision" | "observeSecurityData">,
  initialDocuments: HarnessTurnInput["documents"],
): NonNullable<HarnessTurnInput["prepareSteer"]> {
  const { deps, input, actor, conversation, scopeId } = ctx;
  const { screenTrace } = turn.frame;
  const { turnInboxDir } = turn.frame.framed;
  const { fileRegistration, mayReadArtifact } = turn.ready.turnTools;
  const { documentInputs, observeDocuments } = turn.ready.prepared;
  const { provision, session, run, observeSecurityData } = turn;
  const { turnAbort } = turn.held;
  return async (text, request) => {
    const author = request ? deps.identity.resolve(request.actor).id : actor.id;
    const refreshedInbox =
      surfaceHas(input.surface, "sidebar") &&
      conversation.kind === "dm" &&
      isWebInboxThreadRef(conversation.threadRef) &&
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
    const inboxDir = `${turnInboxDir}/${randomUUID()}`;
    const { inbound, manifest, issues } = await stageAttachments(ctx, {
      attachments: request.attachments,
      provision,
      registration: { ...fileRegistration, seed: `${fileRegistration.seed}:steer:${randomUUID()}` },
      inboxDir,
      surfaceNotes: [],
      observe: ({ content, name, mimetype }) =>
        void observeSecurityData(JSON.stringify({ name, mimetype, content }), actor.id, scopeId, {
          ...screenTrace,
          sessionId: session.id,
          hook: "tool_response",
          surface: "inbound_file",
          origin: input.origin.kind,
        }),
    });
    const steeredDocuments = await loadDocumentInputs(
      deps.files,
      inbound.metas,
      mayReadArtifact,
      run.remainingDocumentBytes,
      turnAbort.signal,
      initialDocuments,
      run.remainingDocumentTokens,
    );
    observeDocuments(steeredDocuments, text);
    run.remainingDocumentBytes -= documentBytes(steeredDocuments.documents);
    run.remainingDocumentTokens -= steeredDocuments.tokens;
    documentInputs.documents.push(...steeredDocuments.documents);
    return {
      text: [text, manifest, ...steeredDocuments.notices, inboundIssuesNote(issues)].filter(Boolean).join("\n\n"),
      attachments: inbound.metas,
      images: inbound.images,
      documents: steeredDocuments.documents,
      author,
    };
  };
}

function segmentRuntimeOptions(
  ctx: TurnCtx,
  selected: SegmentTurn["selected"],
  run: TurnRunState,
): Partial<HarnessTurnInput> {
  const { deps, input, actor, automatedTurn, sessionTurn } = ctx;
  const {
    runtimePurpose,
    purposeDefault,
    runtimeDefaults,
    runtimeClaims,
    restoredRuntime,
    checkRuntimeAuth,
    runtimeState,
  } = selected;
  return {
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
  };
}

function segmentCallbacks(
  ctx: TurnCtx,
  turn: Pick<SegmentTurn, "frame" | "ready" | "session" | "run" | "observeSecurityData">,
) {
  const { deps, input, actor, scopeId } = ctx;
  const { screenTrace } = turn.frame;
  const { surfaceName } = turn.frame.framed;
  const { spineFirst, earlyTaskAck } = turn.ready.turnTools;
  const { publishFirstAck } = turn.ready;
  const { session, run, observeSecurityData } = turn;
  const { emittedEntries } = run;
  return {
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
    onDelta: (chunk: string) => {
      if (!run.firstTokenMarked) {
        run.firstTokenMarked = true;
        markFirstToken();
      }
      if (input.runId && deps.turnStream && !input.surfaceTools) deps.turnStream.publish(input.runId, chunk);
      if (input.surfaceTools && spineFirst.open) spineFirst.block += chunk;
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
    recordModelCall: modelCallRecorder(deps, actor.id),
    recordLlmRequest: async (rec, signal) => {
      try {
        await deps.sessions.recordLlmRequest(session.id, { ...rec, scopeLabel: scopeId }, signal);
      } catch (err) {
        reportFailure("orchestrator: persist LLM request snapshot", err);
      }
    },
  } satisfies Partial<HarnessTurnInput>;
}

export async function runSegments(
  ctx: TurnCtx,
  turn: SegmentTurn,
  compactRecent: ReturnType<typeof createCompaction>["compactRecent"],
) {
  const { deps, input, actor, withManagedRosterVersion, resolution, scopeId, filterHistory, strictReadOnly } = ctx;
  const { defaultDestination } = turn.frame.framed;
  const { surfaceToolDeps, spine, spineFirst, postKeys, postProvenance } = turn.ready.turnTools;
  const { inbound, importedOverheard, baseText, isPollFire } = turn.ready.prepared;
  const { priorTurns } = input;
  const { effectiveTurnWallClockMs, adoptRuntime, runtimeState } = turn.selected;
  const { session, run } = turn;
  const { lease, turnAbort } = turn.held;
  const { historyWindow } = turn.begun;
  const { turnStart } = run;
  const runHarnessTurn = async (
    harnessInput: string,
    extras: Parameters<typeof runHarnessSegment>[3],
    continuation?: { history: Item[] },
  ) => {
    let segment = await runHarnessSegment(ctx, turn, harnessInput, extras, continuation);
    while (segment.runtimeHandoff && !segment.stopped && !turnAbort.signal.aborted) {
      run.runtimeHandoffs += 1;
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
        ctx,
        turn,
        runtimeSwitchNote("choice" in segment.runtimeHandoff ? segment.runtimeHandoff.choice : undefined) +
          (recovery && !resumedHistory.some((entry) => entry.seq === spine.turnUserEntrySeq)
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
  const postToDefault = (outbound: Outbound, destination: Destination, text: string) =>
    postCounted({ deps, input, postKeys, postProvenance, spine }, outbound, destination, text, postKeys.take());
  let result = await runHarnessTurn(baseText, {
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
    defaultDestination &&
    deps.outbound &&
    !input.cancel?.aborted &&
    spine.surfaceOutboundCount === 0 &&
    !result.silent &&
    !result.stopped
  ) {
    await spineFirst.ackDelivery;
    const outbound = deps.outbound;
    const deliverReply = async (reply: string | undefined): Promise<void> => {
      const text = stripAckPrefix(reply ?? "", spineFirst.ackText).trim();
      if (text) await postToDefault(outbound, defaultDestination, text);
    };
    await deliverReply(result.reply);
    if (spine.surfaceOutboundCount === 0 && !isPollFire) {
      const nudgeHistory = filterHistory(forModelContext((await historyWindow()).items));
      result = await runHarnessTurn(ADDRESSED_NUDGE_MD, inbound.images.length ? { images: inbound.images } : {}, {
        history: nudgeHistory,
      });
      if (spine.surfaceOutboundCount === 0 && !result.silent && !result.stopped) {
        await deliverReply(result.reply);
        if (spine.surfaceOutboundCount === 0)
          console.error(`[orchestrator] addressed turn ended silent after nudge session=${session.id}`);
      }
    }
  }
  return result;
}
