import type { TurnCtx } from "./turn-context.ts";
import { ProjectRosterChanged } from "./admit.ts";
import type { ScreenTrace } from "./inbound-screen.ts";
import type { frameTurnPrompt } from "./turn-prompt.ts";
import type { buildTurnTools } from "./turn-tools.ts";
import type { SecurityObserver } from "./security-screen.ts";
import type { Session } from "../../types.ts";
import { MAX_TURN_DOCUMENTS } from "../document-inputs.ts";
import { memoryRecallQuery } from "../../memory/semantic-recall.ts";
import { documentText, historicalDocumentMetas, loadDocumentInputs } from "../document-inputs.ts";
import { MAX_DOCUMENT_BYTES, estimateDocumentTokens, isDocumentAttachment } from "../document-kinds.ts";
import { resolveTurnContext } from "../../resolution/turn-context.ts";
import { recentPrincipalDeliveryNote } from "../../surfaces/recent-dm-posts.ts";
import type { Lease } from "../../sessions/session-store.ts";
import { isOverheard, isUserMessage, type Item, type NewItem } from "../../sessions/items.ts";
import { isPollSurface } from "../../triggers/run-trigger.ts";
import { forModelContext } from "../../harness/context-compaction.ts";
import { securityScreenChunks } from "../../security/security-screen.ts";
import { skillsIndex } from "../../skills/materialize.ts";
import { PROACTIVE_OPENER_PROMPT } from "../../onboarding/onboarding.ts";
import { createTranscriptSource } from "../../sessions/transcript-source.ts";
import {
  environmentNote,
  inboundIssuesNote,
  inboundIssueList,
  inboundManifest,
  materializeInbound,
  safeAttachmentName,
  senderNote,
  withoutAlreadyIngested,
} from "../attachments.ts";
import { findTrailingPartialTurn, resumeStrategy, unrecordedResultItems } from "../turn-resume.ts";
import type { RecordedTurn } from "../turn-resume.ts";
import {
  recordedMessageTimestamps,
  selectOverheardToImport,
  overheardItem,
  type OverheardEntryPayload,
} from "../../harness/replay.ts";
import { swallow, swallowAs } from "../../util/errors.ts";
import type { OrchestratorDeps } from "./types.ts";
import { completedSurfaceEnqueues } from "./turn-helpers.ts";
import { createCompaction } from "./compaction.ts";
import { createTurnSandboxes } from "./sandboxes.ts";

export async function prepareTurnInput(
  ctx: TurnCtx,
  turn: {
    screenTrace: ScreenTrace;
    disclosedFacts: Awaited<ReturnType<Awaited<ReturnType<typeof resolveTurnContext>>["memorySnapshot"]>>["loaded"];
    strictReadOnly: boolean;
    context: Awaited<ReturnType<typeof resolveTurnContext>>;
    framed: Awaited<ReturnType<typeof frameTurnPrompt>>;
    session: Session;
    isRetry: boolean;
    recordedTurn: RecordedTurn | null;
    provision: ReturnType<typeof createTurnSandboxes>["provision"];
    lease: Lease;
    turnAbort: AbortController;
    historyWindow: () => ReturnType<OrchestratorDeps["sessions"]["getContextWindow"]>;
    volatileContext: string;
    turnTools: Awaited<ReturnType<typeof buildTurnTools>>;
    transcripts: ReturnType<typeof createTranscriptSource>;
    blobTransfer: OrchestratorDeps["blobTransfer"];
    documentTokenBudget: ReturnType<typeof createCompaction>["documentTokenBudget"];
    compactContextIfNeeded: ReturnType<typeof createCompaction>["compactContextIfNeeded"];
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
    withManagedRosterVersion,
    resolution,
    scopeId,
    filterHistory,
  } = ctx;
  const {
    screenTrace,
    disclosedFacts,
    strictReadOnly,
    context,
    session,
    isRetry,
    recordedTurn,
    provision,
    lease,
    turnAbort,
    historyWindow,
    volatileContext,
    transcripts,
    blobTransfer,
    documentTokenBudget,
    compactContextIfNeeded,
    observeSecurityData,
  } = turn;
  const { memoryScopeId } = context;
  const { surfaceName, turnContextBlocks, nativeSkills, turnInboxDir } = turn.framed;
  const { spine, postKeys, fileRegistration, mayReadArtifact } = turn.turnTools;
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
          ({ content }) =>
            void observeSecurityData(content, actor.id, scopeId, {
              ...screenTrace,
              sessionId: session.id,
              hook: "tool_response",
              request: input.text,
              surface: "inbound_file",
              origin: input.origin.kind,
            }),
        )
      : { metas: [], images: [], tooMany: [], unavailable: [] };
  const manifest = inboundManifest(inbound.metas, turnInboxDir, inbound.unstaged);
  const inboundIssues = inboundIssueList({
    tooMany: inbound.tooMany,
    unavailable: inbound.unavailable,
    surfaceNotes: [
      ...(input.inboundNotes ?? []),
      ...(strictReadOnly
        ? (input.attachments ?? []).map(
            (attachment) => `${safeAttachmentName(attachment.name)} — unavailable in read-only mode`,
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
  const recalled = await context.recallMemory(memoryRecallQuery(input.text, visibleHistory), disclosedFacts);
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
        : inbound.metas.reduce((sum, meta) => sum + (isDocumentAttachment(meta) ? estimateDocumentTokens(meta) : 0), 0),
    }),
  );
  const contextRecovered =
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
  const observeDocuments = (inputs: Awaited<ReturnType<typeof loadDocumentInputs>>, requestText: string) => {
    if (!(deps.securityScreener || deps.harness.models.screenSecurity)) return;
    const documents = inputs.documents.slice();
    void (async () => {
      for (const document of documents) {
        const extracted = await documentText(document, turnAbort.signal).catch(
          swallowAs("document screen: extract", null),
        );
        if (turnAbort.signal.aborted) return;
        if (!extracted) continue;
        for (const chunk of securityScreenChunks("tool_result:inbound_document", extracted.text))
          void observeSecurityData(chunk, actor.id, scopeId, {
            ...screenTrace,
            sessionId: session.id,
            hook: "tool_response",
            request: requestText,
            surface: "inbound_file",
            origin: input.origin.kind,
          });
      }
    })().catch(swallowAs("orchestrator: observed document screen", undefined));
  };
  observeDocuments(documentInputs, input.text);
  const remainingDocumentBytes =
    MAX_DOCUMENT_BYTES -
    documentInputs.documents.reduce((sum, document) => sum + Buffer.byteLength(document.dataBase64, "base64"), 0);
  const remainingDocumentCount = MAX_TURN_DOCUMENTS - documentInputs.documents.length;
  const remainingDocumentTokens = documentBudget - documentInputs.tokens;
  const principalDelivered = await recentPrincipalDeliveryNote(
    deps.recentDmPosts,
    session.threadRef,
    visibleHistory.findLast((e) => isUserMessage(e) && !isOverheard(e))?.createdAt,
  );
  const sender = !automatedTurn && !sessionTurn && input.text.trim() ? senderNote(actor.displayName) : "";
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
    input.conversationHeader?.trim(),
    volatileContext,
  ]
    .filter((s) => s && s.trim())
    .join("\n\n");
  const baseText = input.proactiveOpener && !input.text.trim() ? PROACTIVE_OPENER_PROMPT : input.text;
  const pausedTurnUserEntry = input.approval
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
  const turnInput = baseText;
  const continueTurn = !!partial && history.some((entry) => entry.seq === partial.userSeq);
  if (partial) spine.turnUserEntrySeq = partial.userSeq;
  const isPollFire = automatedTurn && !!input.surface && isPollSurface(input.surface);
  const sessionUsedTools = visibleHistory.some(
    (e) => e.kind === "ToolCall" && !(e.tool === "skill" || (e.tool === "skills" && e.body.action === "read")),
  );
  if (
    !strictReadOnly &&
    sessionUsedTools &&
    !isPollFire &&
    (await deps.sandboxResources?.resolve(memoryScopeId)) !== null
  ) {
    void provision(true).catch(swallowAs("orchestrator: eager provision", undefined));
  }
  return {
    contextRecovered,
    remainingDocumentBytes,
    remainingDocumentCount,
    remainingDocumentTokens,
    inbound,
    inboundIssues,
    importedOverheard,
    priorTurns,
    recalled,
    partial,
    resumePlan,
    history,
    documentInputs,
    observeDocuments,
    turnEnvironmentContents,
    baseText,
    approvalReplay,
    resume,
    turnInput,
    continueTurn,
    isPollFire,
  };
}

export function turnFailureUserItem(
  ctx: TurnCtx,
  inboundIssues: Awaited<ReturnType<typeof prepareTurnInput>>["inboundIssues"],
): NewItem<"UserMessage"> | undefined {
  const { input, actor, humanInput, messageTs, entryTs } = ctx;
  return input.text.trim() || inboundIssues.length
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
}
