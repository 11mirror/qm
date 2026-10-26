import { acquireTurnLeaseOrRefuse } from "./turn-lease.ts";
import { openTurnSession } from "./turn-context.ts";
import { SECURITY_FLAGGED } from "../../audit/audit-log.ts";
import { type TurnResult, type PendingApproval, type PendingApprovalRecord } from "../../types.ts";
import { turnOriginRequestFields } from "../turn-origin.ts";
import type { HarnessLlmRequestRecord } from "../../harness/harness.ts";
import { securityScreenPayload, UNSCREENED_REASON } from "../../security/security-posture.ts";
import { inputApprovalId } from "../approval-id.ts";
import { collectBlob } from "../../persistence/blob-transfer.ts";
import { isVisionAttachment, safeAttachmentName, senderNote } from "../attachments.ts";
import {
  recordedMessageTimestamps,
  renderOverheard,
  selectOverheardToImport,
  type OverheardEntryPayload,
} from "../../harness/replay.ts";
import { reportFailure, swallowAs } from "../../util/errors.ts";
import type { OrchestratorDeps } from "./types.ts";
import { ProjectRosterChanged, rosterChangedRefusal } from "./admit.ts";
import { parkApprovals } from "./approvals.ts";
import { MAX_AUTO_ATTACHMENT_SCREEN_BYTES, isScreenableTextAttachment, replayableRequest } from "./turn-helpers.ts";

import type { TurnCtx } from "./turn-context.ts";
import type { SecurityClassifier } from "./security-screen.ts";

export interface InboundScreen {
  securityPolicy: TurnCtx["resolution"]["securityPolicy"];
  enforceScreen: boolean;
  screenTrace: { readonly mode: "enforce" | "observe"; readonly thread: string; readonly runId?: string };
  approvalRecord: PendingApprovalRecord | null | undefined;
  pendingScreenRequests: HarnessLlmRequestRecord[];
  recordScreenRequest: (rec: HarnessLlmRequestRecord, signal?: AbortSignal) => Promise<void>;
  inputUnscreened: boolean;
}

export async function screenInboundTurn(
  ctx: TurnCtx,
  services: { classifySecurityData: SecurityClassifier; blobTransfer: OrchestratorDeps["blobTransfer"] },
): Promise<{ screen: InboundScreen } | { result: TurnResult }> {
  const {
    deps,
    input,
    actor,
    conversation,
    automatedTurn,
    ambientTurn,
    sessionTurn,
    withManagedRosterVersion,
    resolution,
    actorGrants,
    approvalOwner,
    scopeId,
    reconcileSessionParticipants,
    screenSession,
  } = ctx;
  const { classifySecurityData, blobTransfer } = services;
  const pending = deps.approvals;
  const securityPolicy = resolution.securityPolicy;
  const enforceScreen = securityPolicy.screening === "enforce";
  const screenTrace = {
    mode: enforceScreen ? "enforce" : "observe",
    thread: conversation.threadRef,
    ...(input.runId ? { runId: input.runId } : {}),
  } as const;
  const approvalSession = input.approval ? await deps.sessions.getByThread(conversation.threadRef) : null;
  const approvalRecord = input.approval ? await pending.get(input.approval.requestId) : undefined;
  const approvalReplaysFlaggedRequest =
    !!approvalRecord?.request &&
    approvalRecord.request.text === input.text &&
    JSON.stringify(approvalRecord.request.overheard ?? []) === JSON.stringify(input.overheard ?? []) &&
    JSON.stringify(approvalRecord.request.attachments ?? []) === JSON.stringify(input.attachments ?? []) &&
    (approvalRecord.request.conversationHeader ?? "") === (input.conversationHeader ?? "");
  const screenInbound =
    securityPolicy.screening !== "off" &&
    !(
      approvalSession &&
      approvalRecord?.sessionId === approvalSession.id &&
      approvalRecord.kind === "input" &&
      approvalReplaysFlaggedRequest
    );
  const pendingScreenRequests: HarnessLlmRequestRecord[] = [];
  const recordScreenRequest = async (rec: HarnessLlmRequestRecord, signal?: AbortSignal): Promise<void> => {
    if (!screenSession.id) {
      pendingScreenRequests.push(rec);
      return;
    }
    try {
      await deps.sessions.recordLlmRequest(screenSession.id, { ...rec, scopeLabel: scopeId }, signal);
    } catch (err) {
      reportFailure("orchestrator: persist security screen request snapshot", err);
    }
  };
  const buildInboundScreen = async () => {
    let overheard: OverheardEntryPayload[] = [];
    if (screenInbound && conversation.kind !== "dm" && input.overheard?.length) {
      const existingSession = await deps.sessions.getByThread(conversation.threadRef);
      const existingEntries = existingSession ? await deps.sessions.getItems(existingSession.id) : [];
      overheard = selectOverheardToImport(input.overheard, recordedMessageTimestamps(existingEntries));
    }
    let hasUnscreenableAttachment = false;
    const attachmentPromptData: Array<{ source: string; content: string }> = [];
    if (screenInbound) {
      for (const attachment of input.attachments ?? []) {
        attachmentPromptData.push({
          source: "attachment-metadata",
          content: JSON.stringify({
            name: attachment.name,
            mimetype: attachment.mimetype,
            author: attachment.author,
          }),
        });
        if (
          isVisionAttachment(attachment) ||
          !isScreenableTextAttachment(attachment.mimetype) ||
          attachment.sizeBytes > MAX_AUTO_ATTACHMENT_SCREEN_BYTES
        ) {
          hasUnscreenableAttachment = true;
          continue;
        }
        const opened = await blobTransfer
          .open(attachment.blobId)
          .catch(swallowAs("attachment screening: open blob", null));
        if (!opened || opened.sizeBytes > MAX_AUTO_ATTACHMENT_SCREEN_BYTES) {
          hasUnscreenableAttachment = true;
          continue;
        }
        const data = await collectBlob(opened.stream).catch(swallowAs("attachment screening: read blob", null));
        if (!data || data.length > MAX_AUTO_ATTACHMENT_SCREEN_BYTES || data.includes(0)) {
          hasUnscreenableAttachment = true;
          continue;
        }
        attachmentPromptData.push({
          source: `attachment:${safeAttachmentName(attachment.name)}`,
          content: data.toString("utf8"),
        });
      }
    }
    const externalPromptData = screenInbound
      ? [
          ...(ambientTurn && actor.displayName?.trim()
            ? [{ source: "sender", content: senderNote(actor.displayName) }]
            : []),
          ...(input.conversationHeader?.trim()
            ? [{ source: "conversation-header", content: input.conversationHeader }]
            : []),
          ...overheard.map((entry) => ({ source: "overheard", content: renderOverheard(entry) })),
          ...attachmentPromptData,
          ...(input.inboundNotes ?? []).map((note) => ({ source: "inbound-file-note", content: note })),
        ]
      : [];
    const sessionSender = input.sessionSenderId ? await deps.sessions.get(input.sessionSenderId) : null;
    const verifiedSessionMessage = Boolean(
      sessionSender &&
      sessionSender.scopeId === scopeId &&
      (await deps.sessions.getForParticipant(sessionSender.id, actor.id)),
    );
    const screenPayload = screenInbound
      ? securityScreenPayload({
          ...input,
          ...turnOriginRequestFields(input.origin),
          ...(sessionTurn ? { triggered: true, securityScreenData: input.text } : {}),
          overheard: [],
          externalPromptData,
          verifiedSessionMessage,
        })
      : null;
    return { hasUnscreenableAttachment, externalPromptData, screenPayload };
  };
  let flaggedScreenedInput: { reason: string; sources: string[] } | undefined;
  let inputUnscreened = false;
  if (screenInbound && !enforceScreen) {
    void buildInboundScreen()
      .then(({ screenPayload }) =>
        screenPayload && !screenPayload.truncated
          ? classifySecurityData(screenPayload.content, actor.id, scopeId, undefined, {
              ...screenTrace,
              hook: "user_input",
              surface: input.surface,
              origin: input.origin.kind,
            })
          : undefined,
      )
      .catch(swallowAs("orchestrator: observed inbound screen", undefined));
  } else if (screenInbound) {
    const { hasUnscreenableAttachment, externalPromptData, screenPayload } = await buildInboundScreen();
    if (screenPayload || hasUnscreenableAttachment) {
      const canScreenText =
        !!screenPayload &&
        !screenPayload.truncated &&
        (!!deps.securityScreener || !!deps.harness.models.screenSecurity);
      const verdict = canScreenText
        ? await classifySecurityData(screenPayload!.content, actor.id, scopeId, recordScreenRequest, {
            ...screenTrace,
            hook: "user_input",
            surface: input.surface,
            origin: input.origin.kind,
          })
        : undefined;
      let unscreenableCause: "unscreenable-attachment" | "oversize-input" | "no-screener" | undefined;
      if (hasUnscreenableAttachment || !screenPayload) unscreenableCause = "unscreenable-attachment";
      else if (screenPayload.truncated) unscreenableCause = "oversize-input";
      else if (!deps.securityScreener && !deps.harness.models.screenSecurity) unscreenableCause = "no-screener";
      if (verdict?.decision === "strict") {
        const sources = externalPromptData.map((item) => item.source);
        flaggedScreenedInput = {
          reason: verdict.reason ?? "strict security screen verdict",
          sources,
        };
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.id,
          action: SECURITY_FLAGGED,
          resource: input.surface ?? "unknown",
          scopeLabel: scopeId,
          status: "pending_approval",
          detail: JSON.stringify({ cause: "strict-verdict", reason: flaggedScreenedInput.reason, source: sources }),
        });
      } else if (unscreenableCause || verdict?.unscreened) {
        inputUnscreened = true;
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.id,
          action: "security_posture.input_failed_open",
          resource: input.surface ?? "unknown",
          scopeLabel: scopeId,
          status: "allowed",
          detail: JSON.stringify({ cause: unscreenableCause ?? UNSCREENED_REASON }),
        });
      }
    }
  }
  if (flaggedScreenedInput) {
    const existing = await deps.sessions.getByThread(conversation.threadRef);
    const flagGrantKey = `security-screen:${input.surface ?? "unknown"}`;
    for (const grant of await actorGrants()) {
      if (!resolution.approvalGrantModes[grant.scope]) continue;
      if (grant.scope === "session" && grant.sessionId !== existing?.id) continue;
      if ((grant.approvalKey ?? grant.command) !== flagGrantKey && grant.command !== "security-screen") continue;
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: "security_posture.flag_allowed_by_grant",
        resource: input.surface ?? "unknown",
        scopeLabel: scopeId,
        status: "allowed",
        detail: JSON.stringify({ scope: grant.scope, reason: flaggedScreenedInput.reason }),
      });
      flaggedScreenedInput = undefined;
      break;
    }
  }
  if (flaggedScreenedInput) {
    const session = await openTurnSession(ctx);
    const acquired = await acquireTurnLeaseOrRefuse(deps, {
      sessionId: session.id,
      site: "flagged_input",
      scopeId,
      automated: automatedTurn,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.turnFenceToken ? { fenceToken: input.turnFenceToken } : {}),
      ...(input.surface ? { surface: input.surface } : {}),
    });
    if (!acquired.lease) return { result: acquired.refusal };
    const lease = acquired.lease;
    let flaggedApprovals: PendingApproval[] = [];
    try {
      await withManagedRosterVersion(async () => {
        await reconcileSessionParticipants(session.id);
        await Promise.all(pendingScreenRequests.splice(0).map((rec) => recordScreenRequest(rec)));
        flaggedApprovals = await parkApprovals(pending, approvalOwner(session.id), [
          {
            requestId: inputApprovalId(session.id, replayableRequest(input)),
            command: "security-screen",
            reason: `${flaggedScreenedInput.reason}; flagged sources: ${flaggedScreenedInput.sources.join(", ") || "message"}`,
            blocksInput: true,
            kind: "input",
            approvalKey: `security-screen:${input.surface ?? "unknown"}`,
          },
        ]);
        return true;
      });
    } catch (err) {
      if (err instanceof ProjectRosterChanged) {
        return { result: rosterChangedRefusal(session.id) };
      }
      throw err;
    } finally {
      await deps.sessions.releaseLease(lease);
    }
    return { result: { status: "pending_approval", sessionId: session.id, pendingApprovals: flaggedApprovals } };
  }
  return {
    screen: {
      securityPolicy,
      enforceScreen,
      screenTrace,
      approvalRecord,
      pendingScreenRequests,
      recordScreenRequest,
      inputUnscreened,
    },
  };
}
