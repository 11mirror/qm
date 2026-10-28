import {
  fetchTranscript,
  TAIL_TURNS,
  type CoreSession,
  type TranscriptPage,
  type PendingApproval,
} from "./core-bridge";
import type { Conversation } from "./conv-types";
import { currentEarlierCount, inheritedTranscript, itemsToMessages } from "./transcript-messages";
import { transcriptModel } from "./model-options";
import { pageAnchor } from "./chat-mount";
import { dropTranscript, storeTranscript, transcriptChanged } from "./transcript-cache";
import { isLiveConversation } from "./conversations";

export function mountTranscript(
  conv: Conversation,
  s: CoreSession,
  page: TranscriptPage,
  approvals: Promise<{ approvals: PendingApproval[] } | null> | null,
): void {
  if (s.canContinue === true) {
    const split = inheritedTranscript(s, page.items ?? []);
    conv.mountContinuable(
      s.threadRef,
      s.id,
      s.scopeId,
      itemsToMessages(split.current, transcriptModel()),
      s.channelName ?? null,
      s,
      itemsToMessages(split.inherited, transcriptModel()),
    );
    const rawEarlier = page.earlierItems ?? 0;
    conv.setTranscriptWindow(pageAnchor(page), currentEarlierCount(s, rawEarlier), rawEarlier > 0);
    if (approvals) conv.attachApprovalsWhenLoaded(s.id, approvals);
    conv.setPins(page.pins ?? []);
  } else {
    conv.mountReadOnlyPage(s, page);
  }
  conv.setGoal(page.goal ?? null);
  conv.setTurnRuntime(page.runtime ?? null);
}

export async function reconcileCachedTranscript(
  conv: Conversation,
  s: CoreSession,
  cached: TranscriptPage,
  approvals: Promise<{ approvals: PendingApproval[] } | null> | null,
  mountedAnchor: number | null,
): Promise<void> {
  let page: TranscriptPage;
  try {
    page = await fetchTranscript(s.id, { tailTurns: TAIL_TURNS });
  } catch (error) {
    dropTranscript(s.id);
    throw error;
  }
  if (!transcriptChanged(cached, page)) return;
  storeTranscript(s.id, page);
  if (isLiveConversation(conv) && conv.state.sessionId === s.id)
    await conv.applyTranscript(s, page, approvals, mountedAnchor);
}
