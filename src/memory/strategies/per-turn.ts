import { randomUUID } from "node:crypto";
import type { HarnessModelUtilities } from "../../harness/harness.ts";
import type { DurableMap } from "../../persistence/durable-map.ts";
import { type MemoryService, type MemoryCaptureContext, isSystemActor } from "../memory-service.ts";
import type { MemoryStrategy } from "../strategy.ts";
import type { ScopeId } from "../../types.ts";
import { bullets } from "../notebook.ts";
import { parseSensitivity, SENSITIVITY_PROMPT } from "../classification.ts";
import { UNTRACKED_PROVENANCE, type MemoryCaptureMetadata } from "../facts.ts";

export const DEFAULT_CAPTURE_QUIET_MS = 180_000;
const DEFAULT_CAPTURE_MAX_TURNS = 10;

export const MEMORY_EXTRACTION_PROMPT = [
  "You extract durable facts worth remembering about the user across FUTURE conversations.",
  "Given one or more consecutive exchanges (user message + assistant reply), output a markdown bullet list",
  "(`- fact`), one concise standalone fact per line, written in the third person",
  "(e.g. `- Prefers terse replies`, `- Owns the billing service`, `- Working on the Q3 launch`).",
  "Include preferences, identifiers, ongoing projects, and how they like to work.",
  "PROVENANCE: a preference, intent, or instruction is a valid fact ONLY when the user's own",
  "message in these exchanges states it. Never derive one from the assistant's reply — an",
  'assistant saying "per X\'s preference" or describing its own strategy ("queued silently to',
  'avoid spam") is NOT evidence that anyone holds that preference. Likewise EXCLUDE second-hand',
  "claims about a person who did not speak in these exchanges.",
  "EXCLUDE secrets/credentials, one-off trivia, and anything already obvious.",
  "EXCLUDE system mechanics you can look up when needed: API endpoints/headers, credential or",
  "broker plumbing, state-file paths, tool invocation details, schemas. For a standing system",
  "the user relies on (a cron, a watcher, an integration), record its EXISTENCE and purpose as",
  'one fact — not its internals. A user-stated convention ("always via the broker, never raw',
  'tokens") is a preference and belongs in memory; how the broker works does not.',
  "When the user's own message states an instruction, rule, or directive to the assistant about",
  "how future work should be done, record it VERBATIM as a quoted fact",
  '(e.g. `- Directive (user\'s words): "always run the linter before pushing"`), not a paraphrase.',
  "If nothing is worth remembering, output exactly: NONE",
  SENSITIVITY_PROMPT,
  "Prepend exactly SENSITIVITY: <label> on its own first line, classifying the entire extracted list.",
].join("\n");

export function parseFacts(out: string): string[] {
  const trimmed = out.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return [];
  return bullets(trimmed).filter(Boolean);
}

async function extractFacts(
  harness: HarnessModelUtilities,
  turns: Array<{ input: string; reply: string }>,
): Promise<{ facts: string[]; sensitivity: NonNullable<MemoryCaptureMetadata["sensitivity"]> }> {
  if (!harness.oneShot) return { facts: [], sensitivity: "unknown" };
  const transcript = turns.map((t) => `User said:\n${t.input}\n\nAssistant replied:\n${t.reply}`).join("\n\n---\n\n");
  const out = await harness.oneShot(MEMORY_EXTRACTION_PROMPT, transcript);
  return {
    facts: parseFacts(out ?? ""),
    sensitivity: parseSensitivity(/^SENSITIVITY: (ordinary|unknown|sensitive|restricted)\n/.exec(out ?? "")?.[1]),
  };
}

/** A burst of turns waiting out the quiet window, kept in Postgres so a restart or another instance can finish it. */
export interface PendingCapture extends MemoryCaptureMetadata {
  scopeId: ScopeId;
  actorId?: string;
  conversationScopeId: ScopeId;
  sessionId?: string;
  idempotencyKey?: string;
  turns: Array<{ input: string; reply: string }>;
  /** Written by the latest append; only the holder of the latest token may take the burst. */
  token: string;
  at: number;
}
type Burst = Omit<PendingCapture, "token" | "at">;

type TurnEndCtx = MemoryCaptureMetadata & {
  scopeId: ScopeId;
  input: string;
  reply: string;
  actorId?: string;
  autonomous?: boolean;
  conversationScopeId?: ScopeId;
  sessionId?: string;
  idempotencyKey?: string;
};

/** How long past its quiet window a burst waits before the sweep takes it from an instance that went away. */
const ORPHAN_GRACE_MS = 60_000;

function createBurstBuffer(
  quietMs: number,
  maxTurns: number,
  pending: DurableMap<PendingCapture> | undefined,
  flush: (burst: Burst) => Promise<void>,
  onError?: (e: unknown, burst: Burst) => void,
): { add(ctx: TurnEndCtx): Promise<void>; sweep(): Promise<void> } {
  const timers = new Map<string, NodeJS.Timeout>();
  const take = async (key: string, burst: PendingCapture): Promise<boolean> =>
    pending!.deleteIf(key, (current) => current.token === burst.token);
  return {
    async add({
      scopeId,
      input,
      reply,
      actorId,
      autonomous,
      conversationScopeId,
      sessionId,
      idempotencyKey,
      inheritedFacts,
    }) {
      if (autonomous === true || isSystemActor(actorId)) return;
      const burst: Burst = {
        scopeId,
        conversationScopeId: conversationScopeId ?? scopeId,
        turns: [{ input, reply }],
        ...(inheritedFacts !== undefined ? { inheritedFacts: structuredClone(inheritedFacts) } : {}),
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      };
      if (quietMs <= 0 || !pending) return flush(burst);

      const key = JSON.stringify([scopeId, burst.conversationScopeId, actorId ?? "", sessionId ?? ""]);
      const token = randomUUID();
      const [active] = await pending.mutateMany([
        {
          id: key,
          apply: (current) =>
            current
              ? {
                  ...current,
                  turns: [...current.turns, { input, reply }],
                  inheritedFacts: [
                    ...(current.inheritedFacts ?? [UNTRACKED_PROVENANCE]),
                    ...(burst.inheritedFacts ?? [UNTRACKED_PROVENANCE]),
                  ],
                  token,
                  at: Date.now(),
                }
              : { ...burst, token, at: Date.now() },
        },
      ]);
      clearTimeout(timers.get(key));
      timers.delete(key);
      if (active!.turns.length >= maxTurns) {
        if (await take(key, active!)) await flush(active!);
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(key);
        void (async () => {
          if (await take(key, active!)) await flush(active!);
        })().catch((e) => onError?.(e, active!));
      }, quietMs);
      timer.unref?.();
      timers.set(key, timer);
    },
    async sweep() {
      if (!pending) return;
      const cutoff = Date.now() - quietMs - ORPHAN_GRACE_MS;
      for (const [key, burst] of await pending.entries()) {
        if (burst.at > cutoff || !(await take(key, burst))) continue;
        await flush(burst).catch((e) => onError?.(e, burst));
      }
    },
  };
}

function burstCaptureContext(burst: Burst): MemoryCaptureContext {
  return {
    mode: "automatic",
    ...(burst.inheritedFacts !== undefined ? { inheritedFacts: burst.inheritedFacts } : {}),
    ...(burst.actorId ? { actorId: burst.actorId } : {}),
    conversationScopeId: burst.conversationScopeId,
    input: burst.turns.map((turn) => turn.input).join("\n\n"),
    reply: burst.turns.map((turn) => turn.reply).join("\n\n"),
    ...(burst.sessionId ? { sessionId: burst.sessionId } : {}),
    ...(burst.idempotencyKey ? { idempotencyKey: burst.idempotencyKey } : {}),
  };
}

export function createPerTurnStrategy(deps: {
  harness: HarnessModelUtilities;
  memory: MemoryService;
  /** With a quiet window, turns from one speaker in one conversation are extracted together once it passes. */
  captureQuietMs?: number;
  /** Where bursts wait out the quiet window; required when captureQuietMs is set. */
  pending?: DurableMap<PendingCapture>;
  captureMaxTurns?: number;
  onCaptureError?: (e: unknown, scopeId: ScopeId) => void;
}): MemoryStrategy & { sweep(): Promise<void> } {
  const quietMs = deps.captureQuietMs ?? 0;
  if (quietMs > 0 && !deps.pending) throw new Error("a memory capture quiet window needs a pending-capture store");
  async function flush(burst: Burst): Promise<void> {
    const { facts, sensitivity } = await extractFacts(deps.harness, burst.turns);
    if (!facts.length) return;
    const at = Date.now();
    await deps.memory.capture(burst.scopeId, facts, at, burst.actorId, { ...burstCaptureContext(burst), sensitivity });
  }
  const buffer = createBurstBuffer(
    quietMs,
    deps.captureMaxTurns ?? DEFAULT_CAPTURE_MAX_TURNS,
    deps.pending,
    flush,
    (e, burst) => deps.onCaptureError?.(e, burst.scopeId),
  );
  return { onTurnEnd: buffer.add, sweep: buffer.sweep };
}
