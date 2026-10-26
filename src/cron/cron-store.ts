import type { Cron, CronFireLogEntry, CronFireNote, CronSchedule, Destination } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { type BeginFireResult, type CronFireRecord, type CronFireStore } from "./fire-store.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  contentPart,
  createDeduped,
  type CreateTriggerInput,
} from "../triggers/trigger-store.ts";
import { assertCronRuntime } from "./runtime.ts";
import { hashId } from "../util/crypto.ts";
import { advanceNextFireAt, isCalendarSchedule, normalizeSchedule, recoverNextFireAt } from "./schedule.ts";

export interface CreateCronInput extends CreateTriggerInput {
  runtime?: Cron["runtime"];
  enabled?: boolean;
  schedule: Cron["schedule"];
  title?: string;
  action?: string;
  message?: string;
  unattendedGrants?: string[];
  inbox?: Cron["inbox"];
  sessionRef?: string;
}

export interface CronPatch {
  runtime?: Cron["runtime"];
  title?: string;
  action?: string;
  message?: string;
  schedule?: CronSchedule;
  enabled?: boolean;
  archived?: boolean;
  destination?: Destination;
  unattendedGrants?: string[];
  sessionRef?: string | null;
}

export const DEFAULT_FIRE_RUNNING_STALE_MS = 24 * 60 * 60 * 1000;

export const STRANDED_FIRE_NOTE = "fire never completed — stranded by a restart or crash";

export const FIRE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const FIRE_RETENTION_KEEP_PER_CRON = 100;

export interface CronStore {
  create(input: CreateCronInput): Promise<Cron>;
  get(id: string): Promise<Cron | null>;
  list(): Promise<Cron[]>;
  update(id: string, patch: CronPatch): Promise<Cron | null>;
  delete(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setDestination(id: string, destination: Destination | undefined): Promise<void>;
  beginFire(id: string, entry: CronFireLogEntry, opts?: { exclusive?: boolean }): Promise<BeginFireResult>;
  sweepStrandedFires(now: number): Promise<number>;
  pruneFires(now: number): Promise<number>;
  recordFire(id: string, entry: CronFireLogEntry): Promise<void>;
  listFires(id: string, opts?: { limit?: number }): Promise<{ runs: CronFireLogEntry[]; total: number }>;
  firesByThreadRefs(threadRefs: readonly string[]): Promise<CronFireRecord[]>;
  latestFireForThread(id: string, threadRef: string): Promise<CronFireLogEntry | undefined>;
  backfillFires(): Promise<number>;
  setFireNote(id: string, note: CronFireNote): Promise<"applied" | "superseded" | "missing">;
  defer(id: string, until: number): Promise<void>;
  claimSlot(id: string, scheduledAt: number, at: number): Promise<boolean>;
  unclaimSlot(id: string, scheduledAt: number, at: number, priorLastFiredAt: number | undefined): Promise<void>;
}

export function cronIsActive(cron: Pick<Cron, "enabled" | "archived" | "schedule" | "lastFiredAt">): boolean {
  if (!cron.enabled || cron.archived) return false;
  const oneShot = cron.schedule.cron === undefined && cron.schedule.everyMs === undefined;
  return !(oneShot && cron.lastFiredAt !== undefined);
}

export function cronTiedTo(cron: Pick<Cron, "destination" | "sessionRef">, threadRef: string): boolean {
  return cron.destination?.target === threadRef || cron.sessionRef === threadRef;
}

export function isDeferred(cron: Pick<Cron, "deferUntil">, now: number): boolean {
  return cron.deferUntil !== undefined && now < cron.deferUntil;
}

function normalizeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}...` : trimmed;
}

export function createCronStore(
  backing: DurableMap<Cron>,
  opts: { staleRunningMs?: number; fires: CronFireStore },
): CronStore {
  const staleRunningMs = opts.staleRunningMs ?? DEFAULT_FIRE_RUNNING_STALE_MS;
  const fires = opts.fires;
  return {
    async create(input) {
      assertNoEscalation(input);
      assertCronRuntime(input);
      const now = Date.now();
      const title = normalizeTitle(input.title);
      const { schedule, nextFireAt } = normalizeSchedule(input.schedule, now);
      const contentId = hashId([
        contentPart(input.owner),
        contentPart(input.ownerScopeId),
        contentPart(input.schedule),
        contentPart(input.action),
        contentPart(input.message),
        contentPart(input.destination),
        contentPart(input.unattendedGrants),
        contentPart(title),
        ...(input.inbox !== undefined ? [contentPart(input.inbox)] : []),
        ...(input.runtime ? [contentPart(input.runtime)] : []),
      ]);
      return createDeduped(backing, contentId, (id) => ({
        ...buildTriggerBase(input, id, now),
        enabled: input.enabled !== false,
        schedule,
        ...(nextFireAt !== undefined ? { nextFireAt } : {}),
        ...(title ? { title } : {}),
        ...(input.action !== undefined ? { action: input.action } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.unattendedGrants ? { unattendedGrants: input.unattendedGrants } : {}),
        ...(input.inbox ? { inbox: input.inbox } : {}),
        ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
        ...(input.runtime ? { runtime: input.runtime } : {}),
      }));
    },
    get: (id) => backing.get(id),
    list: () => backing.all(),
    async update(id, patch) {
      const before = await backing.get(id);
      if (!before) return null;
      assertCronRuntime({ ...before, ...patch });
      const fields: Partial<Cron> = {};
      if (patch.runtime !== undefined) fields.runtime = patch.runtime;
      if (patch.title !== undefined) fields.title = normalizeTitle(patch.title);
      if (patch.action !== undefined) fields.action = patch.action;
      if (patch.message !== undefined) fields.message = patch.message;
      if (patch.schedule !== undefined) {
        const normalized = normalizeSchedule(patch.schedule, Date.now());
        fields.schedule = normalized.schedule;
        fields.nextFireAt = normalized.nextFireAt;
      }
      if (patch.enabled !== undefined) fields.enabled = patch.enabled;
      if (patch.archived !== undefined) fields.archived = patch.archived;
      if (patch.destination !== undefined) fields.destination = patch.destination;
      if (patch.archived === true) fields.enabled = false;
      if (patch.unattendedGrants !== undefined) fields.unattendedGrants = patch.unattendedGrants;
      if (patch.sessionRef !== undefined) fields.sessionRef = patch.sessionRef ?? undefined;
      return backing.merge(id, fields);
    },
    delete: (id) => backing.delete(id),
    async setEnabled(id, enabled) {
      await backing.merge(id, { enabled, ...(enabled ? { archived: false } : {}) });
    },
    async setDestination(id, destination) {
      await backing.merge(id, { destination });
    },
    async beginFire(id, entry, opts) {
      if ((await backing.get(id)) === null) return { begun: false };
      if (opts?.exclusive) return fires.beginExclusive(id, entry, staleRunningMs);
      await fires.record(id, entry);
      return { begun: true };
    },
    async sweepStrandedFires(now) {
      return fires.sweepStranded(now, staleRunningMs, STRANDED_FIRE_NOTE);
    },
    async pruneFires(now) {
      return fires.pruneEnded({ endedBefore: now - FIRE_RETENTION_MS, keepPerCron: FIRE_RETENTION_KEEP_PER_CRON });
    },
    async recordFire(id, entry) {
      await fires.record(id, entry);
    },
    listFires: (id, opts) => fires.listByCron(id, opts),
    firesByThreadRefs: (threadRefs) => fires.listByThreadRefs(threadRefs),
    latestFireForThread: (id, threadRef) => fires.latestForThread(id, threadRef),
    async backfillFires() {
      let backfilled = 0;
      for (const [id, cron] of await backing.entries()) {
        const log = cron.fireLog;
        if (log === undefined) continue;
        if (log.length) {
          await fires.backfill(id, log);
          backfilled += log.length;
        }
        if (backing.update) {
          await backing.update(id, (current) => {
            const { fireLog: _legacy, ...rest } = current;
            return rest;
          });
        } else {
          await backing.merge(id, { fireLog: undefined });
        }
      }
      return backfilled;
    },
    async setFireNote(id, note) {
      let applied = false;
      const apply = (cron: Cron): Cron => {
        applied = !(cron.lastFireNote && cron.lastFireNote.at > note.at);
        return applied ? { ...cron, lastFireNote: note } : cron;
      };
      if (backing.update) {
        if ((await backing.update(id, apply)) === null) return "missing";
        return applied ? "applied" : "superseded";
      }
      const cron = await backing.get(id);
      if (!cron) return "missing";
      apply(cron);
      if (applied) await backing.merge(id, { lastFireNote: note });
      return applied ? "applied" : "superseded";
    },
    async claimSlot(id, scheduledAt, at) {
      let claimed = false;
      const transform = (cron: Cron): Cron => {
        claimed = false;
        if (cron.archived || !cron.enabled) return cron;
        if (recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt) !== scheduledAt)
          return cron;
        claimed = true;
        const advanceFrom = isCalendarSchedule(cron.schedule) ? scheduledAt : at;
        const next = advanceNextFireAt(cron.schedule, advanceFrom);
        const { nextFireAt: _dropped, deferUntil: _cleared, ...rest } = cron;
        return { ...rest, lastFiredAt: at, ...(next !== undefined ? { nextFireAt: next } : {}) };
      };
      if (backing.update) {
        await backing.update(id, transform);
        return claimed;
      }
      const cron = await backing.get(id);
      if (!cron) return false;
      const next = transform(cron);
      if (!claimed) return false;
      await backing.merge(id, { lastFiredAt: next.lastFiredAt, nextFireAt: next.nextFireAt, deferUntil: undefined });
      return true;
    },
    async unclaimSlot(id, scheduledAt, at, priorLastFiredAt) {
      const restore = (cron: Cron): Cron => {
        if (cron.lastFiredAt !== at) return cron;
        const { lastFiredAt: _dropped, ...rest } = cron;
        return {
          ...rest,
          ...(priorLastFiredAt !== undefined ? { lastFiredAt: priorLastFiredAt } : {}),
          nextFireAt: scheduledAt,
        };
      };
      if (backing.update) {
        await backing.update(id, restore);
        return;
      }
      const cron = await backing.get(id);
      if (!cron || cron.lastFiredAt !== at) return;
      await backing.merge(id, { lastFiredAt: priorLastFiredAt, nextFireAt: scheduledAt });
    },
    async defer(id, until) {
      await backing.merge(id, { deferUntil: until });
    },
  };
}

export const DROP_RUN_AS_MIGRATION = {
  id: "durable-map/crons/0001-drop-run-as",
  statements: [
    ...["crons", "loops"].map(
      (table) => `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    ),
    `UPDATE crons SET json = jsonb_set(json, '{owner}', to_jsonb('system:' || (json ->> 'ownerScopeId'))) WHERE json ->> 'runAs' = 'scopeFloor' AND json ->> 'loopId' IS NULL AND json ->> 'ownerScopeId' NOT LIKE 'personal:%'`,
    "UPDATE crons SET json = json - 'runAs' - 'ownerResourcesRequireOpen' - 'members' WHERE json ?| array['runAs', 'ownerResourcesRequireOpen', 'members']",
    "UPDATE loops SET json = json - 'runAs' WHERE json ? 'runAs'",
  ],
};

function sqlText(text: string): string {
  if (text.includes("$qm_text$")) throw new Error("migration text contains its own quote tag");
  return `$qm_text$${text}$qm_text$`;
}

const LOOP_INBOX_TASK =
  'Inbox sync v8. Keep the user\'s QM inbox current: every Slack message and email genuinely WAITING ON A REPLY FROM THEM gets a ledger item with a ready-to-send draft in their own voice. The inbox UI is the only delivery surface — never message the user, and NEVER send a reply yourself; you produce drafts only.\n\n1. GET $AGENT_API_URL/v1/crons/<cron id>/items (agent capability header; the cron id is in the runtime context above) — note existing items: skip complete items already tracked. Preserve human-edited drafts. Repair incomplete open items first: an existing dedupeKey with missing sourcePayload, title, snippet, source metadata, or proposal is unfinished work, not a reason to skip it. Re-read its original conversation using the dedupeKey and summary, then ingest the complete item and draft under that same dedupeKey even when no newer message arrived. Never invent message content from a summary; if the source is unavailable, leave the item pending for retry.\n   - Closed-loop detection: BEFORE scanning for new items, re-read the exact source conversation of EVERY unresolved item (held, pending, or failed), regardless of lastScanAt, age, read/unread state, or whether Gmail still labels it INBOX. The intake watermark is NOT a reconciliation watermark. A pending item already carries a newer message in sourcePayload.latestEvent and has no draft. Decide every pending item, and every item whose conversation\'s LATEST message is newer than its sourceAt: the user wrote a message when it is their own Slack userId on Slack, or their own address or a send-as alias in the From line, or the SENT label, on Gmail. Ignore Gmail drafts. If the user has already answered and nothing newer asks anything of them, POST $AGENT_API_URL/v1/crons/<cron id>/items/<item id>/action with {"kind":"replied","args":{"reason":"<one line>"}}. If the conversation needs nothing from them (closed out, a plain thanks, someone else answered, machine noise), send {"kind":"no_reply_needed","args":{"reason":"<one line>"}} instead. Otherwise re-post the item (step 4) with the newest waiting message and a fresh draft. If a source read fails or is incomplete, retain the item and retry later; do not treat it as resolved. This applies to both Gmail and Slack items.\n2. Keep a lastScanAt watermark in a state file on your workspace (e.g. ~/workspace/inbox-sync/STATE.md); scan each connected source since that watermark (fall back to ~3 days on first run), and advance the watermark only after a successful pass, so outages and missed fires backfill instead of leaving silent gaps. Skip a source whose app is not connected. Judge "waiting on a reply" like a good chief of staff, with a deliberate asymmetry: (a) NEEDS REPLY: direct questions, requests, intros, and personal messages that expect acknowledgment; when in any doubt, this bucket. (b) PROBABLY RESOLVED: the transcript reads closed (a thanks, a "sounds good", a thread someone else already answered) but a reasonable person might still send a word; post the item anyway with "probablyResolved": true in the item body and a draft included; the UI shows these in a muted section. NEVER silently drop a human conversation you judged resolved; demote it instead. (c) SKIP entirely: only unmistakable machine noise (newsletters, receipts, calendar notices, bot chatter). Human words never skip; the lowest they go is probablyResolved.\n   - Gmail (use the google-workspace skill): INBOX threads where the LAST message is inbound and the user is in To or Cc. sourceKey = the Gmail threadId. Record gmail metadata: threadId, messageId, the RFC-2822 Message-ID header (rfcMessageId), subject, and the reply recipients (to = reply-all sender+others minus the user; cc as appropriate).\n   - Slack (use your Slack access as the user): unanswered DMs, @mentions, and thread replies addressed to the user. ONE ITEM PER CONVERSATION, never per message: for unthreaded DMs and group DMs sourceKey = the channelId alone (two people posting in the same group DM is ONE item, refreshed with the latest state and a single draft answering everything outstanding); for all threaded asks sourceKey = channelId:threadTs (channelId:ts of a top-level message anchoring its own thread). Record slack metadata: channelId, channelLabel ("#channel" or "DM with <name>"), ts (the LATEST waiting message), userId (the Slack user id of that message\'s sender), isDirectMessage from Slack conversations.info is_im/is_mpim (NEVER infer group DMs from C/G ID prefixes), and threadTs for every threaded ask. For a top-level CHANNEL mention, threadTs is the original mentioned message ts, even before anyone replies. Preserve that anchor forever: unrelated channel chatter must not replace, refresh, or resolve this item. Read conversations.replies for that root, not the channel tail. For mentions inside a thread, include the root and only that thread. Relevant messages immediately before/after a channel mention may be included in context with nearby:true; never label these as thread replies, and never include unrelated neighboring messages.\n3. For each new or refreshed item, investigate before drafting: read the whole thread, and check whatever context makes the reply substantive (calendar for scheduling asks, earlier email/Slack history for open questions). Draft the reply in the user\'s own voice — for email follow the email-draft-in-voice skill (build the voice profile first if it is missing); for Slack match how the user actually writes in Slack (check their recent messages: register, length, punctuation). Punctuation hard rule: never use em dashes or en dashes in a draft; use a comma, period, or "..." instead, and re-read every draft before posting to strip any that slipped in.\n4. POST $AGENT_API_URL/v1/crons/<cron id>/items with {"items": [...]}. Each item: source ("gmail"|"slack"), sourceKey, title (subject or channel label), from (display name), fromDetail (address or @handle), snippet (the full text of the waiting message, never shortened or ellipsized), context (up to 6 prior thread messages as {author, at, text}), receivedAt (ms epoch of the waiting message), externalUrl (deep link to the original in Gmail/Slack), draft ({to, cc, subject, body} for gmail — body plain text; {body} for slack), and the gmail/slack metadata block from step 2. IMAGES: when a thread message carries image attachments, include an "images" array of their https URLs (Slack: url_private; up to 4) on the matching context entry, and on the item itself for the waiting message — the UI proxies and renders them inline as the user\'s own eyes would see them in Slack/Gmail.\n5. Found nothing new and changed nothing? Finish silently. Only raise your voice on a real fault (a connector that errors repeatedly) — and then only briefly.';

function loopInboxTask(source: string): string {
  return `Source restriction: scan only ${source}. Never read or ingest another source. Keep a separate watermark for this inbox.\n${LOOP_INBOX_TASK}`;
}

const loopInboxSource = "substring(l.json ->> 'surface' from 7)";

function loopsToCrons(tenant: boolean): string {
  const col = tenant ? "tenant_id, " : "";
  const same = (a: string, b: string) => (tenant ? ` AND ${a}.tenant_id = ${b}.tenant_id` : "");
  return `INSERT INTO cron_items (${col}id, json)
     SELECT ${tenant ? "i.tenant_id, " : ""}i.id,
            (i.json - 'loopId' - 'previousLoopId' - 'triage' - 'attempts' - 'runIds' - 'outputIds' - 'claimedAt' - 'claimToken' - 'guidance')
            || jsonb_build_object('cronId', c.id, 'status', CASE WHEN i.json ->> 'status' = 'in_progress' THEN 'queued' ELSE i.json ->> 'status' END)
     FROM loop_items i
     JOIN loops l ON l.id = i.json ->> 'loopId'${same("l", "i")}
     JOIN crons c ON c.id = l.json ->> 'cronId' AND c.json ->> 'loopId' = l.id${same("c", "l")}
     WHERE l.json ->> 'state' <> 'archived'
     ON CONFLICT DO NOTHING;
    UPDATE crons c SET json = (c.json - 'loopId') || jsonb_build_object(
       'enabled', COALESCE((c.json ->> 'enabled')::boolean, false) AND l.json ->> 'state' = 'enabled',
       'title', CASE WHEN l.json ->> 'surface' LIKE 'inbox:%' THEN c.json ->> 'title' ELSE l.json ->> 'name' END,
       'action', CASE
         WHEN l.json ->> 'surface' = 'inbox:gmail' THEN ${sqlText(loopInboxTask("gmail"))}
         WHEN l.json ->> 'surface' = 'inbox:slack' THEN ${sqlText(loopInboxTask("slack"))}
         ELSE replace(replace(replace(l.json ->> 'playbook', '/v1/loops/$LOOP_ID', '/v1/crons/' || c.id), '/v1/loops/' || l.id, '/v1/crons/' || c.id), '$LOOP_ID', c.id)
       END,
       'inbox', CASE WHEN l.json ->> 'surface' LIKE 'inbox:%' THEN jsonb_build_object('source', ${loopInboxSource}) ELSE '{}'::jsonb END)
     FROM loops l
     WHERE c.json ->> 'loopId' = l.id${same("c", "l")} AND l.json ->> 'state' <> 'archived';`;
}

export const LOOPS_TO_CRONS_MIGRATION = {
  id: "durable-map/crons/0002-loops-to-crons",
  statements: [
    ...["crons", "loops", "loop_items", "cron_items"].map(
      (table) => `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    ),
    `DO $loops_to_crons$
     BEGIN
       IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'loops'::regclass AND attname = 'tenant_id' AND NOT attisdropped) THEN
         ALTER TABLE cron_items ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT qm_tenant_id();
         ${loopsToCrons(true)}
       ELSE
         ${loopsToCrons(false)}
       END IF;
     END
     $loops_to_crons$`,
    "DELETE FROM crons WHERE json ? 'loopId'",
  ],
};
