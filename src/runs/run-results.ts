import { surfaceHas } from "../surfaces/surface.ts";
import { isSubagentThreadRef } from "../sessions/thread-ref.ts";
import { type Destination, sourceDestination, turnSource } from "../types.ts";
import type { Item } from "../sessions/items.ts";
import type { Run, RunStore } from "./run-store.ts";
import { turnPostProvenance, type Outbound, type OutboundPost } from "../surfaces/outbound.ts";
import { isSessionTurn } from "../core/turn-origin.ts";
import { turnFailureItem } from "../core/turn-error.ts";
import { standaloneFailureText, userFacingFailureClause } from "../core/failure-copy.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { acquireLeaseWithin, type SessionStore } from "../sessions/session-store.ts";
import { reportFailureAs, withCleanup } from "../util/errors.ts";

const turnRecordedFailure = (turnItems: readonly Item[]): boolean => turnItems.some((item) => item.kind === "Error");

export type AdminUrlFor = (sessionId: string) => string | undefined;

export function runResultPost(run: Run, adminUrlFor?: AdminUrlFor): OutboundPost | null {
  if (isSubagentThreadRef(run.sessionId) || run.request.privateSessionMessage) return null;
  const target = run.request.deliveryTarget;
  const surface = run.request.surface;
  if (!target || !surface) return null;
  const origin = run.request.origin;
  const editRef = run.deliveryState?.editRef;
  const failed = run.status === "failed";
  if (surfaceHas(surface, "transcript")) {
    const unrecordedReply =
      run.result?.status === "ok" && Boolean(run.result.reply) && run.result.sourceAssistantEntrySeq === undefined;
    if (!unrecordedReply) return null;
  }
  const webTranscript: Destination["webTranscript"] | undefined = surfaceHas(surface, "transcript")
    ? { kind: "reply" }
    : undefined;
  const destination: Destination = {
    type: surface,
    target,
    ...sourceDestination(turnSource(run.request)),
    ...(editRef ? { editRef } : {}),
    ...(webTranscript ? { webTranscript } : {}),
  };
  const idempotencyKey = `run:${run.id}`;
  const createdAt = run.finishedAt ?? run.createdAt;
  const provenance = turnPostProvenance({
    origin,
    surface,
    fireKey: idempotencyKey,
    sourceScopeId: conversationScope(run.request.conversation, run.request.actor.id),
    sourceThreadRef: run.request.conversation.threadRef,
    ...(run.result?.sessionId ? { sourceSessionId: run.result.sessionId } : {}),
    ...(run.result?.sourceUserSeq !== undefined ? { sourceUserSeq: run.result.sourceUserSeq } : {}),
    ...(run.result?.sourceAssistantEntrySeq !== undefined
      ? { sourceAssistantEntrySeq: run.result.sourceAssistantEntrySeq }
      : {}),
  });
  if (
    surfaceHas(surface, "quarantineNotice") &&
    run.result?.status === "refused" &&
    (run.result.refusalKind === "security_quarantine" || run.result.refusalKind === "model_budget") &&
    run.request.addressed
  ) {
    return { destination, text: standaloneFailureText(run.result)!, provenance, idempotencyKey, createdAt };
  }
  if (run.request.surfaceTools && run.result?.status !== "failed" && !run.result?.attachments?.length) return null;
  if (failed) {
    if (origin.kind === "ambient" && !isSessionTurn(run.request)) return null;
    const clause = userFacingFailureClause(run.result ?? { status: "failed" });
    const adminUrl = run.result?.sessionId ? adminUrlFor?.(run.result.sessionId) : undefined;
    const detail = adminUrl ? ` — full error: ${adminUrl}` : "";
    return {
      destination,
      text: `⚠️ I couldn't finish that turn: ${clause}${detail}`,
      provenance,
      idempotencyKey,
      createdAt,
    };
  }
  if (run.result?.status === "ok" && (run.result.reply || run.result.attachments?.length)) {
    return {
      destination,
      text: run.result.reply ?? "",
      ...(run.result.attachments?.length ? { attachments: run.result.attachments } : {}),
      provenance,
      idempotencyKey,
      createdAt,
    };
  }
  return null;
}

export type TurnFailureSessions = Pick<
  SessionStore,
  "append" | "getByThread" | "acquireLease" | "peekLease" | "releaseLease" | "getItems"
>;

const FAILURE_RECORD_WAIT_MS = 10 * 60_000;

export type FailureEntryOutcome = "recorded" | "present" | "unneeded" | "busy";

export async function recordRunFailureEntry(
  sessions: TurnFailureSessions,
  run: Run,
  waitMs = FAILURE_RECORD_WAIT_MS,
): Promise<FailureEntryOutcome> {
  if (run.status !== "failed") return "unneeded";
  const session = await sessions.getByThread(run.sessionId);
  if (!session) {
    console.error(
      `[run-results] failed run ${run.id} targets ${run.sessionId}, which has no session — no turn_failure entry recorded`,
    );
    return "unneeded";
  }
  const { lease } = await acquireLeaseWithin(sessions, session.id, "append", waitMs);
  if (!lease) {
    console.error(`[run-results] session ${session.id} stayed busy — failed run ${run.id} has no turn_failure entry`);
    return "busy";
  }
  return withCleanup(
    async (): Promise<FailureEntryOutcome> => {
      if (turnRecordedFailure(await sessions.getItems(session.id, { turnId: run.id }))) return "present";
      await sessions.append(
        lease,
        turnFailureItem(
          `I couldn't finish that turn: ${userFacingFailureClause(run.result ?? { status: "failed" })}`,
          run.id,
        ),
      );
      return "recorded";
    },
    () => sessions.releaseLease(lease),
  );
}

const RUN_RESULT_SWEEP_GRACE_MS = 60_000;
const RUN_RESULT_SWEEP_PAGE = 200;
const RUN_RECOVERY_GRACE_MS = 15_000;

export interface RunResultRecovery {
  sweep(now?: number): Promise<number>;
}

export function wireRunResultPosts(
  runs: Pick<RunStore, "onTerminal" | "unsettledTerminal" | "get" | "setDeliveryState">,
  outbound: Pick<Outbound, "send">,
  opts: {
    sessions: TurnFailureSessions;
    adminUrlFor?: AdminUrlFor;
    postsImmediately?: (surface: string) => boolean;
  },
): RunResultRecovery {
  const owed = (run: Run): OutboundPost | null =>
    run.deliveryState?.postedAt === undefined ? runResultPost(run, opts.adminUrlFor) : null;
  const settled = (run: Run, posted: boolean) => {
    const at = Date.now();
    return runs.setDeliveryState(run.id, null, posted ? { postedAt: at, settledAt: at } : { settledAt: at });
  };
  const postOwed = async (run: Run, post: OutboundPost): Promise<boolean> => {
    try {
      const receipt = await outbound.send(post);
      if (receipt?.deferred) return false;
    } catch (error) {
      if (!(error as { permanent?: boolean }).permanent) throw error;
      reportFailureAs("run results: reply is undeliverable (not retried)", undefined, `run=${run.id}`)(error);
      await settled(run, true);
      return false;
    }
    await settled(run, true);
    return true;
  };
  runs.onTerminal((run) => {
    void (async () => {
      const failure = await recordRunFailureEntry(opts.sessions, run);
      if (failure === "busy" || !owed(run)) return;
      const surface = run.request.surface;
      if (!surfaceHas(surface, "transcript") && !(surface && opts.postsImmediately?.(surface)))
        await new Promise((resolve) => setTimeout(resolve, RUN_RECOVERY_GRACE_MS).unref?.());
      const latest = (await runs.get(run.id)) ?? run;
      const post = owed(latest);
      if (post) await postOwed(latest, post);
    })().catch(reportFailureAs("run results: post recovered result (the sweep retries)", undefined, `run=${run.id}`));
  });
  return {
    async sweep(now = Date.now()) {
      const before = now - RUN_RESULT_SWEEP_GRACE_MS;
      let cursor = { finishedAt: 0, id: "" };
      let recovered = 0;
      for (;;) {
        const batch = await runs.unsettledTerminal(cursor, before, RUN_RESULT_SWEEP_PAGE);
        for (const run of batch) {
          const post = owed(run);
          try {
            const failure = await recordRunFailureEntry(opts.sessions, run, 0);
            if (failure === "busy") continue;
            if (failure === "recorded") {
              console.error(`[run-results] failed run ${run.id} had no turn_failure entry — recorded it`);
              recovered += 1;
            }
            if (!post) await settled(run, false);
            else if (await postOwed(run, post)) {
              console.error(`[run-results] terminal run ${run.id} still owed its reply — posted it`);
              recovered += 1;
            }
          } catch (error) {
            reportFailureAs("run results: sweep post", undefined, `run=${run.id}`)(error);
          }
        }
        const last = batch.at(-1);
        if (!last || batch.length < RUN_RESULT_SWEEP_PAGE) return recovered;
        cursor = { finishedAt: last.finishedAt!, id: last.id };
      }
    },
  };
}
