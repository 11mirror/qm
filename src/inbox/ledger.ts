import type { LedgerEvent, LedgerEventOp } from "./events.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { wireMentionKeys } from "../slack/mrkdwn.ts";
import type { InboxItem, InboxItemStatus, InboxProposal, InboxPayload, InboxThreadMessage } from "../types.ts";
import { isResolved } from "./view.ts";
import { adapterForItem, conversationKeyOf, inboxMetadataKeys, sourceAdapters } from "./sources/index.ts";
import { createPgPool, tenantCols, withPgTransaction } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, updateRow, type TableSpec } from "../persistence/typed-table.ts";
import { contentPart } from "../triggers/trigger-store.ts";
import { hashId } from "../util/crypto.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export interface IngestEntryInput {
  cronId: string;
  dedupeKey: string;
  source?: string;
  summary?: string;
  sourcePayload: InboxPayload;
  sourceAt?: number;
  proposal?: Omit<InboxProposal, "at">;
}

interface IngestOutcome {
  created: number;
  updated: number;
  skipped: number;
}

interface PruneOptions {
  maxItems: number;
  retentionMs: number;
  now?: number;
}

interface RecordActionInput {
  kind: string;
  result?: string;
  outcome: "actioned" | "dismissed" | "failed";
}

const ACTION_STATUS: Record<RecordActionInput["outcome"], InboxItemStatus> = {
  actioned: "shipped",
  dismissed: "skipped",
  failed: "failed",
};

export interface LatestEvent {
  author: "owner" | "other";
  at: number;
  text?: string;
  from?: string;
}

const EVENT_TEXT_CHARS = 2_000;

export interface InboxLedger {
  ingest(entries: IngestEntryInput[]): Promise<IngestOutcome>;
  recordEvent(item: InboxItem, event: LatestEvent): Promise<boolean>;
  setProposal(
    id: string,
    proposal: Omit<InboxProposal, "at">,
    opts?: { expectedAt?: number },
  ): Promise<InboxItem | null>;
  annotate(
    id: string,
    patch: InboxPayload,
    opts?: { summary?: string; expectedSourceAt?: number; expectedSourcePayload?: InboxPayload },
  ): Promise<InboxItem | null>;
  appendThread(id: string, messages: Array<Omit<InboxThreadMessage, "id" | "at">>): Promise<InboxItem | null>;
  recordAction(id: string, input: RecordActionInput): Promise<InboxItem | null>;
  reopen(id: string, opts?: { sentReply?: boolean }): Promise<InboxItem | null>;
  prune(cronId: string, options: PruneOptions): Promise<number>;
  get(id: string): Promise<InboxItem | null>;
  byCron(cronId: string): Promise<InboxItem[]>;
  byCrons(cronIds: readonly string[]): Promise<InboxItem[]>;
  byConversation(conversationKey: string): Promise<InboxItem[]>;
  summaries(
    cronIds: string[],
    options?: { includeInboxMetadata?: boolean },
  ): Promise<Array<Omit<InboxItem, "proposal" | "agentDrafts" | "thread" | "sourcePayload">>>;
  acquireDecision(id: string, decisionAt?: number): Promise<string | null>;
  releaseDecision(id: string, token: string): Promise<boolean>;
  deleteByCron(cronId: string): Promise<void>;
}

export type InboxEventSink = (item: InboxItem, event: LatestEvent) => Promise<void>;

export const INBOX_ITEM_SOURCE_MIGRATION = {
  id: "durable-map/crons/0004-inbox-item-source",
  statements: [
    `DO $$ BEGIN IF to_regclass('cron_items') IS NOT NULL THEN
       UPDATE cron_items SET json = jsonb_set(json, '{source}', json -> 'sourcePayload' -> 'source')
         WHERE NOT json ? 'source' AND jsonb_typeof(json -> 'sourcePayload' -> 'source') = 'string';
       UPDATE cron_items SET json = json #- '{sourcePayload,source}'
         WHERE json -> 'sourcePayload' ? 'source' AND json ->> 'source' = json -> 'sourcePayload' ->> 'source';
       UPDATE durable_map_versions SET v = v + 1 WHERE tbl = 'cron_items';
     END IF; END $$`,
  ],
};

export function inboxConversationKeyMigration(): { id: string; statements: string[] } {
  return {
    id: "durable-map/crons/0005-inbox-conversation-key",
    statements: [
      `DO $$ BEGIN IF to_regclass('cron_items') IS NOT NULL THEN
       ${sourceAdapters()
         .map((adapter) => {
           const path = `'{sourcePayload,${adapter.conversationKeyPath.join(",")}}'`;
           return `UPDATE cron_items SET json = jsonb_set(json, '{conversationKey}', json #> ${path})
         WHERE json ->> 'source' = '${adapter.id}' AND jsonb_typeof(json #> ${path}) = 'string';`;
         })
         .join("\n       ")}
       UPDATE durable_map_versions SET v = v + 1 WHERE tbl = 'cron_items';
     END IF; END $$`,
    ],
  };
}

function withConversationKey(item: InboxItem): InboxItem {
  const conversationKey = conversationKeyOf(item);
  return conversationKey === item.conversationKey ? item : { ...item, conversationKey };
}

export function inboxItemId(cronId: string, sourceKey: string): string {
  return hashId([contentPart(cronId), contentPart(sourceKey)]);
}

const DECISION_LEASE_MS = 300_000;

function nextIngestStatus(item: InboxItem, proposal: InboxProposal | undefined): InboxItemStatus {
  if (proposal) return "ready";
  return isResolved(item) ? "queued" : item.status;
}

const AGENT_DRAFT_HISTORY = 10;

function sameDraft(a: InboxProposal | undefined, b: InboxProposal): boolean {
  return a !== undefined && canonicalJson(a.data) === canonicalJson(b.data);
}

export function agentDraftsOf(item: Pick<InboxItem, "proposal" | "agentDrafts">): InboxProposal[] {
  const kept = item.agentDrafts ?? [];
  if (item.proposal?.by !== "agent" || sameDraft(kept.at(-1), item.proposal)) return kept;
  return [...kept, item.proposal];
}

export function agentDraftOf(item: Pick<InboxItem, "proposal" | "agentDrafts">): InboxProposal | undefined {
  return agentDraftsOf(item).at(-1);
}

function withAgentDraft(
  item: Pick<InboxItem, "proposal" | "agentDrafts" | "agentMentionKeys">,
  proposal: InboxProposal | undefined,
): Pick<InboxItem, "agentDrafts" | "agentMentionKeys"> {
  const drafts = agentDraftsOf(item);
  const next = proposal?.by === "agent" && !sameDraft(drafts.at(-1), proposal) ? [...drafts, proposal] : drafts;
  const keys = new Set(item.agentMentionKeys ?? []);
  for (const draft of next) for (const key of wireMentionKeys(canonicalJson(draft.data))) keys.add(key);
  return { agentDrafts: next.slice(-AGENT_DRAFT_HISTORY), agentMentionKeys: [...keys] };
}

function inboxPreview(payload: InboxPayload | undefined): InboxPayload {
  if (!payload) return {};
  return Object.fromEntries(
    ["title", "from", "fromDetail", "snippet", "receivedAt", "probablyResolved", "sentChat"].flatMap((key) =>
      payload[key] === undefined ? [] : [[key, payload[key]]],
    ),
  );
}

function eventEntry(item: InboxItem, event: LatestEvent): IngestEntryInput | null {
  const text = event.text?.trim().slice(0, EVENT_TEXT_CHARS);
  const other = event.author === "other";
  const from = other ? event.from?.slice(0, 300) : undefined;
  if (isResolved(item) && !other) return null;
  return {
    cronId: item.cronId,
    dedupeKey: item.sourceKey,
    ...(item.source !== undefined ? { source: item.source } : {}),
    ...(item.sourceSummary !== undefined ? { summary: item.sourceSummary } : {}),
    sourceAt: event.at,
    sourcePayload: {
      ...item.sourcePayload,
      latestEvent: {
        author: event.author,
        at: event.at,
        ...(text && !other ? { text } : {}),
        ...(from ? { from } : {}),
      },
      ...(other ? { receivedAt: event.at, ...(text ? { snippet: text } : {}) } : {}),
    },
  };
}

function mergeIngest(item: InboxItem, entry: IngestEntryInput, now: number): InboxItem | null {
  const newerSource = entry.sourceAt !== undefined && entry.sourceAt > (item.sourceAt ?? 0);
  if (isResolved(item) && !newerSource) return null;
  if (!isResolved(item) && !newerSource && !entry.proposal) return null;
  const keepHumanProposal = item.proposal?.by === "human" && !newerSource;
  const incoming = entry.proposal ? { ...entry.proposal, at: now } : item.proposal;
  const proposal =
    keepHumanProposal || (incoming && item.proposal?.by === "agent" && sameDraft(item.proposal, incoming))
      ? item.proposal
      : incoming;
  const refresh = newerSource && !entry.proposal;
  if (refresh && item.decisionToken && (item.decisionAt ?? 0) + DECISION_LEASE_MS > now)
    throw new Error("Item has an active decision; retry the source update");
  const status = refresh ? "queued" : nextIngestStatus(item, proposal);
  return {
    ...item,
    status,
    ...withAgentDraft(item, proposal),
    sourcePayload: entry.sourcePayload,
    inboxPreview: inboxPreview(entry.sourcePayload),
    sourceAt: entry.sourceAt ?? item.sourceAt,
    actedAt: undefined,
    actionKind: undefined,
    actionResult: undefined,
    parkedReason: undefined,
    updatedAt: now,
    ...(entry.source !== undefined ? { source: entry.source } : {}),
    ...(entry.summary !== undefined ? { sourceSummary: entry.summary } : {}),
    ...(proposal ? { proposal } : { proposal: undefined }),
    ...(refresh
      ? {
          proposal: undefined,
          ...(item.proposal?.by === "human"
            ? {
                thread: [
                  ...(item.thread ?? []),
                  {
                    id: randomUUID(),
                    role: "human" as const,
                    text: `Previous draft before a newer message arrived:\n${JSON.stringify(item.proposal.data)}`,
                    at: now,
                  },
                ],
              }
            : {}),
        }
      : {}),
  };
}

const CRON_ITEMS: TableSpec = {
  table: "cron_items",
  key: "id",
  keyIsField: true,
  columns: cols(`cronId text!, sourceKey text!, sourceSummary text, source text, sourcePayload jsonb,
    conversationKey text, sourceAt float, inboxPreview jsonb, proposal jsonb, agentDrafts jsonb,
    agentMentionKeys text[], thread jsonb, status text!, parkedReason text, actedAt bigint,
    actionKind text, actionResult text, decisionAt float, decisionToken text, createdAt bigint!,
    updatedAt bigint!`),
};

export const CRON_ITEMS_MIGRATION = mapToTableMigration("triggers/cron-items/0001-typed", CRON_ITEMS, {
  statements: [
    `CREATE INDEX IF NOT EXISTS cron_items_cron_id ON cron_items (cron_id)`,
    `CREATE INDEX IF NOT EXISTS cron_items_conversation_key ON cron_items (conversation_key)`,
  ],
});

const codec = tableCodec<InboxItem>(CRON_ITEMS);

const HEAVY_FIELDS = new Set(["proposal", "agentDrafts", "thread", "sourcePayload"]);

const summary = tableCodec<Omit<InboxItem, "proposal" | "agentDrafts" | "thread" | "sourcePayload">>({
  ...CRON_ITEMS,
  columns: Object.fromEntries(Object.entries(CRON_ITEMS.columns).filter(([field]) => !HEAVY_FIELDS.has(field))),
});

function itemRows(databaseUrl: string) {
  const { q, pool } = createPgPool(databaseUrl, [CRON_ITEMS_MIGRATION]);
  const forCrons = async (cronIds: readonly string[]): Promise<InboxItem[]> => {
    if (!cronIds.length) return [];
    return codec.rows(
      await q(`SELECT ${codec.columns} FROM cron_items WHERE cron_id = ANY($1::text[]) ORDER BY id`, [[...cronIds]]),
    );
  };
  return {
    q,
    forCrons,
    update: async (id: string, fn: (item: InboxItem) => InboxItem): Promise<InboxItem | null> =>
      updateRow(await pool(), CRON_ITEMS, id, fn),
    get: async (id: string): Promise<InboxItem | null> =>
      codec.rows(await q(`SELECT ${codec.columns} FROM cron_items WHERE id = $1`, [id]))[0] ?? null,
    summaries: async (cronIds: readonly string[]) =>
      summary.rows(
        await q(`SELECT ${summary.columns} FROM cron_items WHERE cron_id = ANY($1::text[]) ORDER BY id`, [
          [...cronIds],
        ]),
      ),
    mutateMany: async (updates: ReadonlyArray<{ id: string; apply: (item: InboxItem | null) => InboxItem }>) =>
      withPgTransaction(await pool(), async (client) => {
        const found = await client.query(
          `SELECT ${codec.columns} FROM cron_items WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
          [updates.map(({ id }) => id)],
        );
        const pending = new Map(codec.rows(found.rows).map((item) => [item.id, item]));
        const written = new Map<string, InboxItem>();
        for (const { id, apply } of updates) {
          const before = pending.get(id) ?? null;
          const next = apply(before ? structuredClone(before) : null);
          pending.set(id, next);
          written.set(id, next);
        }
        for (const [id, item] of written)
          await client.query(
            `INSERT INTO cron_items (${codec.columns}) VALUES (${codec.placeholders})
             ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${codec.updates}`,
            codec.values(id, item),
          );
      }),
  };
}

type ItemRows = ReturnType<typeof itemRows>;

type ItemEdits = Pick<
  InboxLedger,
  "setProposal" | "annotate" | "appendThread" | "recordAction" | "reopen" | "acquireDecision" | "releaseDecision"
>;

function itemEdits({ update, get }: ItemRows, emit: (item: InboxItem | null, op: LedgerEventOp) => void): ItemEdits {
  return {
    async setProposal(id, proposal, opts) {
      let applied = false;
      const after = await update(id, (item) => {
        if (item.status === "shipped") return item;
        if (opts?.expectedAt !== undefined && item.proposal?.at !== opts.expectedAt) return item;
        applied = true;
        const now = Date.now();
        const stamped = { ...proposal, at: now };
        return {
          ...item,
          proposal: stamped,
          ...withAgentDraft(item, stamped),
          status: item.status === "queued" ? "ready" : item.status,
          updatedAt: now,
        };
      });
      if (applied) emit(after, "proposal");
      return applied ? after : null;
    },
    async annotate(id, patch, opts) {
      let applied = false;
      const after = await update(id, (item) => {
        if (
          (opts?.expectedSourceAt !== undefined && item.sourceAt !== opts.expectedSourceAt) ||
          (opts?.expectedSourcePayload !== undefined &&
            !isDeepStrictEqual(item.sourcePayload, opts.expectedSourcePayload))
        )
          return item;
        applied = true;
        return withConversationKey({
          ...item,
          sourcePayload: { ...item.sourcePayload, ...patch },
          ...(opts?.summary !== undefined ? { sourceSummary: opts.summary } : {}),
          updatedAt: Date.now(),
        });
      });
      if (applied) emit(after, "annotate");
      return applied ? after : null;
    },
    async appendThread(id, messages) {
      if (messages.length === 0) return get(id);
      let applied = false;
      const after = await update(id, (item) => {
        applied = true;
        const now = Date.now();
        const added = messages.map((message) => ({ ...message, id: randomUUID(), at: now }));
        return {
          ...item,
          thread: [...(item.thread ?? []), ...added],
          updatedAt: now,
        };
      });
      if (applied) emit(after, "thread");
      return applied ? after : null;
    },
    async recordAction(id, input) {
      let applied = false;
      const after = await update(id, (item) => {
        if (item.status === "shipped") return item;
        applied = true;
        const now = Date.now();
        const status = ACTION_STATUS[input.outcome];
        return {
          ...item,
          status,
          actionKind: input.kind,
          actedAt: now,
          updatedAt: now,
          parkedReason: status === "failed" ? input.result : undefined,
          ...(input.result !== undefined && status !== "failed" ? { actionResult: input.result } : {}),
        };
      });
      if (applied) emit(after, "action");
      return applied ? after : null;
    },
    async reopen(id, opts) {
      let applied = false;
      const after = await update(id, (item) => {
        const sentReply = opts?.sentReply === true && item.sourcePayload?.sentChat === true;
        if (item.status !== "skipped" && item.status !== "failed" && !(sentReply && item.status === "shipped"))
          return item;
        applied = true;
        const now = Date.now();
        return {
          ...item,
          status: sentReply || item.proposal ? "ready" : "queued",
          ...(sentReply
            ? {
                proposal: { data: { body: "" }, by: "human" as const, at: Math.max(now, (item.proposal?.at ?? 0) + 1) },
              }
            : {}),
          actedAt: undefined,
          actionKind: undefined,
          actionResult: undefined,
          parkedReason: undefined,
          updatedAt: now,
        };
      });
      if (applied) emit(after, "reopen");
      return applied ? after : null;
    },
    async acquireDecision(id, decisionAt = Date.now()) {
      let token: string | null = null;
      await update(id, (item) => {
        const active = item.decisionToken && (item.decisionAt ?? 0) + DECISION_LEASE_MS > decisionAt;
        if (active) return item;
        token = randomUUID();
        return { ...item, decisionAt, decisionToken: token, updatedAt: decisionAt };
      });
      return token;
    },
    async releaseDecision(id, token) {
      let released = false;
      await update(id, (item) => {
        if (item.decisionToken !== token) return item;
        released = true;
        return { ...item, decisionAt: undefined, decisionToken: undefined, updatedAt: Date.now() };
      });
      return released;
    },
  };
}

export function createInboxLedger(databaseUrl: string, onEvent?: (event: LedgerEvent) => void): InboxLedger {
  const rows = itemRows(databaseUrl);
  const { q, get, forCrons } = rows;
  const emit = (item: InboxItem | null | undefined, op: LedgerEventOp): void => {
    if (item && onEvent) onEvent({ cronId: item.cronId, itemId: item.id, op, at: Date.now() });
  };

  const ledger: InboxLedger = {
    async summaries(cronIds, options) {
      if (!options?.includeInboxMetadata) return rows.summaries(cronIds);
      const found = await q(
        `SELECT ${summary.columns}, (SELECT jsonb_object_agg(key, value) FROM jsonb_each(source_payload)
           WHERE key = ANY($2::text[])) AS metadata
         FROM cron_items WHERE cron_id = ANY($1::text[]) ORDER BY id`,
        [cronIds, inboxMetadataKeys()],
      );
      return found.map((row) => {
        const item = summary.row(row);
        const adapter = adapterForItem(item);
        return adapter
          ? {
              ...item,
              inboxPreview: {
                ...item.inboxPreview,
                ...adapter.inboxMetadata((row.metadata as InboxPayload | null) ?? {}),
              },
            }
          : item;
      });
    },
    async ingest(entries) {
      const outcome: IngestOutcome = { created: 0, updated: 0, skipped: 0 };
      if (!entries.length) return outcome;
      const existing = await rows.summaries([...new Set(entries.map((entry) => entry.cronId))]);
      const idByKey = new Map(existing.map((item) => [JSON.stringify([item.cronId, item.sourceKey]), item.id]));
      const changed: InboxItem[] = [];
      await rows.mutateMany(
        entries.map((entry) => {
          const id =
            idByKey.get(JSON.stringify([entry.cronId, entry.dedupeKey])) ?? inboxItemId(entry.cronId, entry.dedupeKey);
          return {
            id,
            apply: (item: InboxItem | null): InboxItem => {
              const now = Date.now();
              const candidate: InboxItem = {
                id,
                cronId: entry.cronId,
                sourceKey: entry.dedupeKey,
                status: entry.proposal ? "ready" : "queued",
                sourcePayload: entry.sourcePayload,
                inboxPreview: inboxPreview(entry.sourcePayload),
                createdAt: now,
                updatedAt: now,
                ...(entry.source !== undefined ? { source: entry.source } : {}),
                ...(entry.summary !== undefined ? { sourceSummary: entry.summary } : {}),
                ...(entry.sourceAt !== undefined ? { sourceAt: entry.sourceAt } : {}),
                ...(entry.proposal ? { proposal: { ...entry.proposal, at: now } } : {}),
                ...withAgentDraft({ agentDrafts: [] }, entry.proposal ? { ...entry.proposal, at: now } : undefined),
              };
              if (!item) {
                outcome.created++;
                const created = withConversationKey(candidate);
                changed.push(created);
                return created;
              }
              const merged = mergeIngest(item, entry, now);
              if (merged) {
                outcome.updated++;
                const next = withConversationKey(merged);
                changed.push(next);
                return next;
              }
              outcome.skipped++;
              return item;
            },
          };
        }),
      );
      for (const item of changed) emit(item, "ingest");
      return outcome;
    },
    ...itemEdits(rows, emit),
    async recordEvent(item, event) {
      const current = await get(item.id);
      if (!current) return false;
      const entry = eventEntry(current, event);
      if (!entry) return false;
      return (await ledger.ingest([entry])).updated > 0;
    },
    async prune(cronId, options) {
      const now = options.now ?? Date.now();
      const items = await rows.summaries([cronId]);
      const expired = items.filter(
        (item) => isResolved(item) && now - (item.actedAt ?? item.updatedAt) >= options.retentionMs,
      );
      const doomed = new Map(expired.map((item) => [item.id, item]));
      const surviving = items.filter((item) => !doomed.has(item.id));
      if (surviving.length > options.maxItems) {
        const resolvedOldestFirst = surviving
          .filter(isResolved)
          .sort((a, b) => (a.actedAt ?? a.updatedAt) - (b.actedAt ?? b.updatedAt));
        for (const item of resolvedOldestFirst.slice(0, surviving.length - options.maxItems)) doomed.set(item.id, item);
      }
      if (doomed.size) await q(`DELETE FROM cron_items WHERE id = ANY($1::text[])`, [[...doomed.keys()]]);
      return doomed.size;
    },
    get,
    byCron: (cronId) => forCrons([cronId]),
    byCrons: forCrons,
    async byConversation(conversationKey) {
      return codec.rows(
        await q(`SELECT ${codec.columns} FROM cron_items WHERE conversation_key = $1 ORDER BY id`, [conversationKey]),
      );
    },
    async deleteByCron(cronId) {
      await q(`DELETE FROM cron_items WHERE cron_id = $1`, [cronId]);
    },
  };
  return ledger;
}
