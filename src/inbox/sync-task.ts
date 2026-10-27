import type { CronStore } from "../cron/cron-store.ts";
import type { Cron } from "../types.ts";
import { scopeId } from "../types.ts";
import { principalDestination } from "../reach/reach.ts";

export const INBOX_SYNC_TASK_VERSION = 11;

export const INBOX_SYNC_DEFAULT_EVERY_MS = 15 * 60 * 1000;

export const INBOX_LEDGER_MAX_ITEMS = 500;

export const INBOX_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const INBOX_SOURCES = [
  { source: "gmail", name: "Email" },
  { source: "slack", name: "Slack" },
] as const;

export function inboxName(source: string): string {
  return INBOX_SOURCES.find((entry) => entry.source === source)?.name ?? source;
}

const SOURCE_GUIDE = {
  gmail: {
    selfAuthored: "their own address or a send-as alias in the From line, or the SENT label. Ignore Gmail drafts.",
    scan: "   - Gmail (use the google-workspace skill): INBOX threads where the LAST message is inbound and the user is in To or Cc. sourceKey = the Gmail threadId. Record gmail metadata: threadId, messageId, the RFC-2822 Message-ID header (rfcMessageId), subject, and the reply recipients (to = reply-all sender+others minus the user; cc as appropriate).\n",
    voice: "follow the email-draft-in-voice skill (build the voice profile first if it is missing)",
    history: "earlier email history",
    draft: "{to, cc, subject, body}; body is plain text",
    title: "subject",
    fromDetail: "address",
    link: "Gmail",
    images: " (up to 4)",
  },
  slack: {
    selfAuthored: "their own Slack userId.",
    scan: '   - Slack (use your Slack access as the user): unanswered DMs, @mentions, and thread replies addressed to the user. ONE ITEM PER CONVERSATION, never per message: for unthreaded DMs and group DMs sourceKey = the channelId alone (two people posting in the same group DM is ONE item, refreshed with the latest state and a single draft answering everything outstanding); for all threaded asks sourceKey = channelId:threadTs (channelId:ts of a top-level message anchoring its own thread). Record slack metadata: channelId, channelLabel ("#channel" or "DM with <name>"), ts (the LATEST waiting message), userId (the Slack user id of that message\'s sender), isDirectMessage from Slack conversations.info is_im/is_mpim (NEVER infer group DMs from C/G ID prefixes), and threadTs for every threaded ask. For a top-level CHANNEL mention, threadTs is the original mentioned message ts, even before anyone replies. Preserve that anchor forever: unrelated channel chatter must not replace, refresh, or resolve this item. Read conversations.replies for that root, not the channel tail. For mentions inside a thread, include the root and only that thread. Relevant messages immediately before/after a channel mention may be included in context with nearby:true; never label these as thread replies, and never include unrelated neighboring messages.\n',
    voice: "match how the user actually writes in Slack (check their recent messages: register, length, punctuation)",
    history: "earlier Slack history",
    draft: "{body}",
    title: "channel label",
    fromDetail: "@handle",
    link: "Slack",
    images: " (url_private; up to 4)",
  },
} as const;

function renderInboxSyncTask(source: string): string {
  const guide = SOURCE_GUIDE[source as keyof typeof SOURCE_GUIDE] ?? SOURCE_GUIDE.gmail;
  return `Inbox sync v${INBOX_SYNC_TASK_VERSION}. Keep the user's QM inbox current: every ${source === "slack" ? "Slack message" : "email"} genuinely WAITING ON A REPLY FROM THEM gets a ledger item with a ready-to-send draft in their own voice. The inbox UI is the only delivery surface — never message the user, and NEVER send a reply yourself; you produce drafts only.

1. GET $AGENT_API_URL/v1/crons/<cron id>/items (agent capability header; the cron id is in the runtime context above) — note existing items: skip complete items already tracked. Preserve human-edited drafts. Repair incomplete open items first: an existing dedupeKey with missing sourcePayload, title, snippet, source metadata, or proposal is unfinished work, not a reason to skip it. Re-read its original conversation using the dedupeKey and summary, then ingest the complete item and draft under that same dedupeKey even when no newer message arrived. Never invent message content from a summary; if the source is unavailable, leave the item pending for retry.
   - Closed-loop detection: BEFORE scanning for new items, re-read the exact source conversation of EVERY unresolved item (held, pending, or failed), regardless of scannedThrough, age, read/unread state${source === "slack" ? "" : ", or whether Gmail still labels it INBOX"}. The intake watermark is NOT a reconciliation watermark. A pending item already carries a newer message in sourcePayload.latestEvent and has no draft. Decide every pending item, and every item whose conversation's LATEST message is newer than its sourceAt: the user wrote a message when it is ${guide.selfAuthored} If the user has already answered and nothing newer asks anything of them, POST $AGENT_API_URL/v1/crons/<cron id>/items/<item id>/action with {"kind":"replied","args":{"reason":"<one line>"}}. If the conversation needs nothing from them (closed out, a plain thanks, someone else answered, machine noise), send {"kind":"no_reply_needed","args":{"reason":"<one line>"}} instead. Otherwise re-post the item (step 4) with the newest waiting message and a fresh draft. If a source read fails or is incomplete, retain the item and retry later; do not treat it as resolved.
2. The GET in step 1 returns scannedThrough, this inbox's intake watermark (ms epoch; absent before the first successful pass). Scan the source since scannedThrough (fall back to ~3 days when it is absent), and advance it only after a successful pass by POSTing {"scannedThrough": <ms epoch when this pass began>} to $AGENT_API_URL/v1/crons/<cron id>/items, alongside "items" or on its own, so outages and missed fires backfill instead of leaving silent gaps. Skip the scan when the app is not connected. Judge "waiting on a reply" like a good chief of staff, with a deliberate asymmetry: (a) NEEDS REPLY: direct questions, requests, intros, and personal messages that expect acknowledgment; when in any doubt, this bucket. (b) PROBABLY RESOLVED: the transcript reads closed (a thanks, a "sounds good", a thread someone else already answered) but a reasonable person might still send a word; post the item anyway with "probablyResolved": true in the item body and a draft included; the UI shows these in a muted section. NEVER silently drop a human conversation you judged resolved; demote it instead. (c) SKIP entirely: only unmistakable machine noise (newsletters, receipts, calendar notices, bot chatter). Human words never skip; the lowest they go is probablyResolved.
${guide.scan}3. For each new or refreshed item, investigate before drafting: read the whole thread, and check whatever context makes the reply substantive (calendar for scheduling asks, ${guide.history} for open questions). Draft the reply in the user's own voice — ${guide.voice}. Punctuation hard rule: never use em dashes or en dashes in a draft; use a comma, period, or "..." instead, and re-read every draft before posting to strip any that slipped in.
4. POST $AGENT_API_URL/v1/crons/<cron id>/items with {"items": [...]}. Each item: source ("${source}"), sourceKey, title (${guide.title}), from (display name), fromDetail (${guide.fromDetail}), snippet (the full text of the waiting message, never shortened or ellipsized), context (up to 6 prior thread messages as {author, at, text}), receivedAt (ms epoch of the waiting message), externalUrl (deep link to the original in ${guide.link}), draft (${guide.draft}), and the ${source} metadata block from step 2. IMAGES: when a thread message carries image attachments, include an "images" array of their https URLs${guide.images} on the matching context entry, and on the item itself for the waiting message — the UI proxies and renders them inline as the user's own eyes would see them in ${guide.link}.
5. Found nothing new and changed nothing? Finish silently. Only raise your voice on a real fault (a connector that errors repeatedly) — and then only briefly.`;
}

export function renderSourceInboxTask(source: string): string {
  return `Source restriction: scan only ${source}. Never read or ingest another source.\n${renderInboxSyncTask(source)}`;
}

export async function inboxCrons(crons: Pick<CronStore, "list">, owner: string): Promise<Cron[]> {
  const scope = scopeId("personal", owner);
  return (await crons.list()).filter(
    (cron) => cron.inbox?.source && !cron.archived && cron.owner === owner && cron.ownerScopeId === scope,
  );
}

export async function ensureInboxCron(
  crons: Pick<CronStore, "list" | "create">,
  owner: string,
  source: string,
): Promise<Cron> {
  const existing = (await inboxCrons(crons, owner)).find((cron) => cron.inbox?.source === source);
  if (existing) return existing;
  return crons.create({
    owner,
    createdBy: owner,
    ownerScopeId: scopeId("personal", owner),
    destination: principalDestination(owner, owner),
    schedule: { everyMs: INBOX_SYNC_DEFAULT_EVERY_MS },
    enabled: false,
    title: `${inboxName(source)} sync`,
    action: renderSourceInboxTask(source),
    inbox: { source },
  });
}
