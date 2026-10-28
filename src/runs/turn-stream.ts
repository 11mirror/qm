import { goalIsOpen, type GoalRecord } from "../harness/goal.ts";
import type { TurnRuntime } from "../types.ts";
import type { Run, RunDeliveryState, RunStore } from "./run-store.ts";
import { swallowAs } from "../util/errors.ts";

export interface GoalView {
  objective: string;
  status: "active" | "paused" | "complete" | "cancelled";

  floor?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReasoningBlock {
  step: string;
  index: number;
  text: string;
}

export interface TurnStream {
  begin(runId: string, leaseToken?: string): void;
  publish(runId: string, delta: string, leaseToken?: string): void;
  publishBlockStart(runId: string, leaseToken?: string): void;
  publishReasoning(runId: string, step: string, index: number, delta: string, leaseToken?: string): void;
  settleReasoning(runId: string, step: string, index: number, leaseToken?: string): void;
  reasoning(runId: string): ReasoningBlock[];
  noteToolCall(runId: string, leaseToken?: string): void;
  noteRuntime(runId: string, runtime: TurnRuntime, leaseToken?: string): void;
  firstBlock(runId: string): { text: string; closed: boolean } | null;
  savedFirstBlock(runId: string): Promise<string | undefined>;
  markSurfacePosted(runId: string, leaseToken?: string): void;
  snapshot(runId: string): string | null;
  startOffset(runId: string): number;
  markReplyDone(runId: string, leaseToken?: string): void;
  end(runId: string, leaseToken?: string): void;
}

interface Entry {
  text: string;
  totalChars: number;
  firstBlock: string;
  firstBlockOpen: boolean;
  firstBlockClosed: boolean;
  firstBlockSaved: Promise<boolean> | null;
  leaseToken: string | null;
  reasoning: ReasoningBlock[];
  surfacePosted: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface TurnStreamOptions {
  runs: Pick<RunStore, "setDeliveryState">;
  onDelta?(runId: string, text: string, offset: number, startOffset: number): void;
  onReasoning?(runId: string, block: Omit<ReasoningBlock, "text">, text: string, offset: number): void;
  onChange?(runId: string): void;
}

const MAX_CHARS = 200_000;
const GRACE_MS = 30_000;
const BLOCK_JOIN = "\n\n";

function makeEntry(): Entry {
  return {
    text: "",
    totalChars: 0,
    firstBlock: "",
    firstBlockOpen: true,
    firstBlockClosed: false,
    firstBlockSaved: null,
    leaseToken: null,
    reasoning: [],
    surfacePosted: false,
    timer: null,
  };
}

function ensure(runs: Map<string, Entry>, runId: string): Entry {
  let entry = runs.get(runId);
  if (!entry) {
    entry = makeEntry();
    runs.set(runId, entry);
  }
  return entry;
}

function current(runs: Map<string, Entry>, runId: string, leaseToken: string | undefined): Entry | undefined {
  const entry = runs.get(runId);
  return entry?.leaseToken === (leaseToken ?? null) ? entry : undefined;
}

function owned(runs: Map<string, Entry>, runId: string, leaseToken: string | undefined): Entry | undefined {
  return runs.has(runId) || leaseToken ? current(runs, runId, leaseToken) : ensure(runs, runId);
}

function append(opts: TurnStreamOptions, runId: string, entry: Entry, delta: string): void {
  const offset = entry.totalChars;
  entry.totalChars += delta.length;
  entry.text += delta;
  if (entry.text.length > MAX_CHARS) entry.text = entry.text.slice(-Math.floor(MAX_CHARS / 2));
  opts.onDelta?.(runId, delta, offset, entry.totalChars - entry.text.length);
}

function persister(opts: TurnStreamOptions) {
  return (runId: string, entry: Entry, state: RunDeliveryState): Promise<boolean> =>
    opts.runs.setDeliveryState(runId, entry.leaseToken, state).then(
      (saved) => {
        opts.onChange?.(runId);
        return saved;
      },
      swallowAs("turn-stream: persist delivery state", false),
    );
}

function streamWriteMethods(opts: TurnStreamOptions, runs: Map<string, Entry>) {
  const persist = persister(opts);
  return {
    begin(runId, leaseToken) {
      const prior = runs.get(runId);
      if (prior?.timer) clearTimeout(prior.timer);
      const entry =
        prior && prior.leaseToken === (leaseToken ?? null) ? prior : { ...makeEntry(), leaseToken: leaseToken ?? null };
      if (prior) Object.assign(entry, { text: prior.text, totalChars: prior.totalChars });
      entry.reasoning = [];
      entry.timer = null;
      runs.set(runId, entry);
      opts.onChange?.(runId);
    },

    publish(runId, delta, leaseToken) {
      const entry = delta ? owned(runs, runId, leaseToken) : undefined;
      if (!entry) return;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.firstBlockOpen) entry.firstBlock += delta;
      append(opts, runId, entry, delta);
    },

    publishBlockStart(runId, leaseToken) {
      const entry = current(runs, runId, leaseToken);
      if (!entry) return;
      if (entry.firstBlock) entry.firstBlockOpen = false;
      if (!entry.text || entry.text.endsWith(BLOCK_JOIN)) return;
      append(opts, runId, entry, BLOCK_JOIN);
    },

    publishReasoning(runId, step, index, delta, leaseToken) {
      const entry = owned(runs, runId, leaseToken);
      if (!entry) return;
      let block = entry.reasoning.find((b) => b.step === step && b.index === index);
      if (!block) {
        block = { step, index, text: "" };
        entry.reasoning = [...entry.reasoning, block];
      }
      if (!delta) return;
      const offset = block.text.length;
      block.text += delta;
      opts.onReasoning?.(runId, { step, index }, delta, offset);
    },

    settleReasoning(runId, step, index, leaseToken) {
      const entry = current(runs, runId, leaseToken);
      if (entry) entry.reasoning = entry.reasoning.filter((b) => b.step !== step || b.index !== index);
    },

    reasoning(runId) {
      return (runs.get(runId)?.reasoning ?? []).map((b) => ({ ...b }));
    },

    noteToolCall(runId, leaseToken) {
      const entry = owned(runs, runId, leaseToken);
      if (!entry?.firstBlockOpen) return;
      entry.firstBlockOpen = false;
      entry.firstBlockClosed = entry.firstBlock.trim().length > 0;
      if (entry.firstBlockClosed) entry.firstBlockSaved = persist(runId, entry, { firstBlock: entry.firstBlock });
    },
  } satisfies Partial<TurnStream>;
}

function streamStateMethods(opts: TurnStreamOptions, runs: Map<string, Entry>) {
  const persist = persister(opts);
  return {
    noteRuntime(runId, runtime, leaseToken) {
      const entry = owned(runs, runId, leaseToken);
      if (entry) void persist(runId, entry, { runtime });
    },

    firstBlock(runId) {
      const entry = runs.get(runId);
      if (!entry || !entry.firstBlock.trim()) return null;
      return { text: entry.firstBlock, closed: entry.firstBlockClosed };
    },

    async savedFirstBlock(runId) {
      const entry = runs.get(runId);
      if (!entry?.firstBlockSaved || !(await entry.firstBlockSaved)) return undefined;
      return entry.firstBlock.trim() || undefined;
    },

    markSurfacePosted(runId, leaseToken) {
      const entry = owned(runs, runId, leaseToken);
      if (!entry || entry.surfacePosted) return;
      entry.surfacePosted = true;
      void persist(runId, entry, { surfacePosted: true });
    },

    snapshot(runId) {
      const text = runs.get(runId)?.text;
      return text ? text : null;
    },

    startOffset(runId) {
      const entry = runs.get(runId);
      return entry ? entry.totalChars - entry.text.length : 0;
    },

    markReplyDone(runId, leaseToken) {
      const entry = owned(runs, runId, leaseToken);
      if (entry) void persist(runId, entry, { replyDone: true });
    },

    end(runId, leaseToken) {
      const entry = current(runs, runId, leaseToken);
      if (!entry || entry.timer) return;
      const timer = setTimeout(() => runs.delete(runId), GRACE_MS);
      timer.unref?.();
      entry.timer = timer;
    },
  } satisfies Partial<TurnStream>;
}

export function createTurnStream(opts: TurnStreamOptions): TurnStream {
  const runs = new Map<string, Entry>();
  return {
    ...streamWriteMethods(opts, runs),
    ...streamStateMethods(opts, runs),
  };
}

export function runGoal(goal: GoalRecord | undefined, run: Pick<Run, "startedAt" | "finishedAt">): GoalView | null {
  if (!goal || run.startedAt === null) return null;
  const end = run.finishedAt ?? Infinity;
  const changedDuringRun = goal.updatedAt >= run.startedAt && goal.updatedAt <= end;
  return changedDuringRun || (goalIsOpen(goal) && goal.createdAt <= end) ? goalView(goal) : null;
}

export function goalView(goal: GoalRecord): GoalView {
  const floor = formatFloor((goal.floor as Record<string, unknown> | undefined) ?? null);
  return {
    objective: goal.objective,
    status: goal.status,
    ...(floor ? { floor } : {}),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function formatFloor(floor: Record<string, unknown> | null): string | undefined {
  if (!floor || typeof floor !== "object") return undefined;
  const parts: string[] = [];
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const ms = num(floor.minMs);
  if (ms !== null) {
    if (ms >= 3_600_000) parts.push(`${+(ms / 3_600_000).toFixed(1)}h`);
    else if (ms >= 60_000) parts.push(`${+(ms / 60_000).toFixed(1)}m`);
    else parts.push(`${Math.round(ms / 1000)}s`);
  }
  const turns = num(floor.minTurns);
  if (turns !== null) parts.push(`${turns} turns`);
  const tokens = num(floor.minTokens);
  if (tokens !== null) parts.push(`${tokens} tokens`);
  const usd = num(floor.minUsd);
  if (usd !== null) parts.push(`$${usd}`);
  return parts.length ? parts.join(", ") : undefined;
}
