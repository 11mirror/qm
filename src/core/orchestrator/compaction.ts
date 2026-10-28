import type { ScopeId, Session } from "../../types.ts";
import type { Item } from "../../sessions/items.ts";
import { countTokens } from "../../util/tokens.ts";
import { parseScopeId } from "../../types.ts";
import type { Lease } from "../../sessions/session-store.ts";
import { acquireLeaseWithin, contextSummary, contextSummaryItem } from "../../sessions/session-store.ts";
import {
  COMPACT_HARD_FRACTION,
  COMPACT_KEEP_RECENT_FRACTION,
  COMPACT_SOFT_FRACTION,
  compactSummaryTokenBudget,
  validateCompactSummary,
  compactionThroughSeq,
  estimateItemTokens,
  estimateHistoryTokens,
  forModelContext,
  overBudgetFraction,
  planCompaction,
  recentItemCountWithinBudget,
} from "../../harness/context-compaction.ts";
import { modelCallRecorder } from "./turn-helpers.ts";
import { errMessage } from "../../util/errors.ts";
import type { OrchestratorDeps } from "./types.ts";

const MAX_CONTEXT_TOKENS = 120_000;
const DOCUMENT_TOKEN_FRACTION = 0.5;
const WRITE_LEASE_WAIT_MS = 60_000;

interface Summarized {
  text: string;
  throughSeq: number;
  mode?: "recent";
}

interface CompactInput {
  session: Session;
  lease: Lease;
  visibleHistory: Item[];
  scopeId: string;
  orgScopeId: string;
  actorId: string;
  model?: string;
  cancel?: AbortSignal;
  reservedTokens?: number;
}

export interface CompactionContext {
  compactContextIfNeeded(input: CompactInput): Promise<Item[]>;
  compactRecent(input: CompactInput): Promise<Item[]>;
  scheduleBackgroundCompaction(job: BackgroundCompaction): void;
  documentTokenBudget(scopeId: string, model?: string): number;
}

export function createCompaction(deps: OrchestratorDeps): CompactionContext {
  deps.jobs.handle(BACKGROUND_COMPACTION_JOB, async (params) => {
    await runBackgroundCompaction(deps, params as BackgroundCompaction);
    return "done";
  });
  return {
    compactContextIfNeeded: (input) => compactContextIfNeeded(deps, input),
    compactRecent: (input) => compactRecent(deps, input),
    scheduleBackgroundCompaction: (job) => scheduleBackgroundCompaction(deps, job),
    documentTokenBudget: (scopeId, model) => documentTokenBudget(deps, scopeId, model),
  };
}
export function tokenBudgetFor(
  deps: Pick<OrchestratorDeps, "maxContextTokens" | "harness">,
  scopeLabel?: string,
  model?: string,
): number {
  return deps.maxContextTokens ?? deps.harness.models.contextTokenBudget?.(scopeLabel, model) ?? MAX_CONTEXT_TOKENS;
}
function documentTokenBudget(deps: OrchestratorDeps, scopeId: string, model?: string): number {
  return Math.floor(tokenBudgetFor(deps, scopeId, model) * DOCUMENT_TOKEN_FRACTION);
}
function historyBudgetFor(
  deps: OrchestratorDeps,
  input: { scopeId: string; model?: string; reservedTokens?: number },
): number {
  const total = tokenBudgetFor(deps, input.scopeId, input.model);
  const reserved = Math.min(
    Math.max(0, input.reservedTokens ?? 0),
    documentTokenBudget(deps, input.scopeId, input.model),
  );
  return Math.max(1, total - reserved);
}

function boundRecent(entries: Item[], maxContextTokens: number): Item[] {
  const summary = entries.find((e) => contextSummary(e));
  const rest = summary ? entries.filter((e) => e !== summary) : entries;
  const kept = rest.slice(
    rest.length - recentItemCountWithinBudget(rest, maxContextTokens - (summary ? estimateItemTokens(summary) : 0)),
  );
  return summary ? [summary, ...kept] : kept;
}
function isManagedGroupScope(deps: OrchestratorDeps, scope: string): boolean {
  const parsed = parseScopeId(scope);
  return parsed.kind === "group" && deps.managedGroups?.recognizes(parsed.ref) === true;
}

async function summarizeForCompaction(
  deps: OrchestratorDeps,
  input: Omit<CompactInput, "lease">,
  recoverOnFailure = false,
): Promise<Summarized | null> {
  if (isManagedGroupScope(deps, input.scopeId)) return null;
  if (!deps.harness.models.compactHistory) return null;
  const maxContextTokens = historyBudgetFor(deps, input);
  const reuseBudgetTokens = Math.floor(maxContextTokens * COMPACT_KEEP_RECENT_FRACTION);
  const plan = planCompaction(input.visibleHistory, maxContextTokens, COMPACT_KEEP_RECENT_FRACTION, reuseBudgetTokens);
  if (!plan || !plan.toSummarize.length) return null;
  input.cancel?.throwIfAborted();
  let text: string;
  const summaryTokenBudget = compactSummaryTokenBudget(maxContextTokens);
  try {
    const raw = await deps.harness.models.compactHistory({
      session: input.session,
      history: plan.toSummarize,
      summaryTokenBudget,
      recordModelCall: modelCallRecorder(deps, input.actorId),
    });
    text = validateCompactSummary(raw, summaryTokenBudget);
  } catch (error) {
    input.cancel?.throwIfAborted();
    if (!recoverOnFailure || (error instanceof Error && error.name === "AbortError")) throw error;
    deps.errors?.record(
      {
        category: "turn",
        code: "compaction_summary_failed",
        message: errMessage(error),
        scopeLabel: input.scopeId as ScopeId,
        sessionId: input.session.id,
      },
      error,
    );
    return null;
  }
  input.cancel?.throwIfAborted();
  return {
    text,
    throughSeq: compactionThroughSeq(plan.toSummarize),
  };
}

async function writeCompaction(
  deps: OrchestratorDeps,
  input: { session: Session; lease: Lease; summarized: Summarized },
): Promise<Item> {
  const { text, throughSeq, mode } = input.summarized;
  const summary = await deps.sessions.append(input.lease, {
    ...contextSummaryItem(throughSeq, text),
    ...(mode ? { body: { mode } } : {}),
  });
  return summary;
}

async function applyCompaction(deps: OrchestratorDeps, input: CompactInput): Promise<Item[] | null> {
  const summarized = await summarizeForCompaction(deps, input, true);
  if (!summarized) return null;
  const summary = await writeCompaction(deps, { ...input, summarized });
  const recent = input.visibleHistory.filter((entry) => entry.seq > summarized.throughSeq && !contextSummary(entry));
  return boundRecent([summary, ...recent], historyBudgetFor(deps, input));
}

async function compactContextIfNeeded(deps: OrchestratorDeps, input: CompactInput): Promise<Item[]> {
  const maxContextTokens = historyBudgetFor(deps, input);
  if (!overBudgetFraction(input.visibleHistory, maxContextTokens, COMPACT_HARD_FRACTION)) {
    return input.visibleHistory;
  }
  const rebuilt = await applyCompaction(deps, input);
  return (
    rebuilt ??
    (!deps.harness.models.compactHistory || isManagedGroupScope(deps, input.scopeId)
      ? boundRecent(input.visibleHistory, maxContextTokens)
      : compactRecent(deps, input))
  );
}

async function compactRecent(deps: OrchestratorDeps, input: CompactInput): Promise<Item[]> {
  input.cancel?.throwIfAborted();
  const budget = Math.floor(historyBudgetFor(deps, input) * COMPACT_KEEP_RECENT_FRACTION);
  const prior = input.visibleHistory.findLast((entry) => contextSummary(entry));
  const rest = input.visibleHistory.filter((entry) => !contextSummary(entry));
  const notice =
    "[Context reduced without a new summary. Earlier entries are excluded, not deleted. Use history to reopen missing requests and tool calls; history does not return tool results. Check actual state before repeating actions whose outcomes are missing.]";
  const markerTokens = countTokens(`${notice}\n\nLast saved summary (not updated):\n`);
  let remaining = Math.max(0, budget - markerTokens);
  let start = rest.length;
  while (start > 0) {
    const cost = estimateItemTokens(rest[start - 1]!);
    if (cost > remaining) break;
    remaining -= cost;
    start--;
  }
  const retainedCalls = new Set<string | null>();
  for (let i = start; i < rest.length; i++) {
    const entry = rest[i]!;
    if (entry.kind === "ToolCall" && entry.callId) retainedCalls.add(entry.callId);
    if (entry.kind === "ToolResult" && !retainedCalls.has(entry.callId)) {
      start = i + 1;
      retainedCalls.clear();
    }
  }
  const recent = rest.slice(start);
  remaining = budget - markerTokens - estimateHistoryTokens(recent);
  const includedPrior = prior && estimateItemTokens(prior) <= remaining ? prior : undefined;
  const priorText = includedPrior ? contextSummary(includedPrior)!.text : undefined;
  let text = notice;
  if (priorText)
    text = priorText.startsWith(notice) ? priorText : `${notice}\n\nLast saved summary (not updated):\n${priorText}`;
  const window = await deps.sessions.getContextWindow(input.session.id);
  const boundary = window.items.reduce((seq, entry) => Math.max(seq, contextSummary(entry)?.throughSeq ?? -1), -1);
  const throughSeq = Math.max(boundary, compactionThroughSeq([...(prior ? [prior] : []), ...rest.slice(0, start)]));
  input.cancel?.throwIfAborted();
  const summary = await writeCompaction(deps, {
    ...input,
    summarized: {
      text,
      throughSeq,
      mode: "recent",
    },
  });
  return [summary, ...recent];
}

interface BackgroundCompaction {
  sessionId: string;
  afterSeq: number;
  scopeId: string;
  orgScopeId: string;
  actorId: string;
  model?: string;
}

const BACKGROUND_COMPACTION_JOB = "background-compaction";

function recordBackgroundFailure(deps: OrchestratorDeps, job: BackgroundCompaction, error: unknown): void {
  deps.errors?.record(
    {
      category: "turn",
      code: "background_compaction_failed",
      message: errMessage(error),
      scopeLabel: job.scopeId as ScopeId,
      sessionId: job.sessionId,
    },
    error,
  );
}

async function runBackgroundCompaction(deps: OrchestratorDeps, job: BackgroundCompaction): Promise<void> {
  let lease: Lease | null = null;
  try {
    const session = await deps.sessions.get(job.sessionId);
    if (!session) return;
    const maxContextTokens = tokenBudgetFor(deps, job.scopeId, job.model);
    const entries = (await deps.sessions.getContextWindow(job.sessionId)).items;
    const history = forModelContext(entries);
    if (!overBudgetFraction(history, maxContextTokens, COMPACT_SOFT_FRACTION)) return;
    const snapshotSeq = entries.at(-1)?.seq ?? -1;
    const summarized = await summarizeForCompaction(deps, {
      session,
      visibleHistory: history,
      scopeId: job.scopeId,
      orgScopeId: job.orgScopeId,
      actorId: job.actorId,
      ...(job.model ? { model: job.model } : {}),
    });
    if (!summarized) return;
    lease = (await acquireLeaseWithin(deps.sessions, job.sessionId, "compaction", WRITE_LEASE_WAIT_MS)).lease;
    if (!lease) return;
    const since = await deps.sessions.getItems(job.sessionId, { sinceSeq: snapshotSeq + 1 });
    if (!since.some((entry) => !!contextSummary(entry))) {
      await writeCompaction(deps, { session, lease, summarized });
    }
  } catch (e) {
    recordBackgroundFailure(deps, job, e);
  } finally {
    if (lease) await deps.sessions.releaseLease(lease);
  }
}

function scheduleBackgroundCompaction(deps: OrchestratorDeps, job: BackgroundCompaction): void {
  deps.jobs
    .spawn(BACKGROUND_COMPACTION_JOB, job, `compaction:${job.sessionId}:${job.afterSeq}`)
    .catch((e: unknown) => recordBackgroundFailure(deps, job, e));
}
