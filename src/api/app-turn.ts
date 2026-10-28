import { surfaceHas } from "../surfaces/surface.ts";
import { isTerminal, isUnstarted } from "../runs/run-store.ts";
import { stopSessionTree, withSessionTreeLock } from "../subagents/tree.ts";
import type { TurnRequest, TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { desktopClientForTurn, isPersonAuthored } from "../core/turn-origin.ts";
import type { SessionStateEvent } from "../runs/session-state-bus.ts";
import { samePerson } from "../directory/person.ts";
import { swallowAs } from "../util/errors.ts";
import { sleep } from "../util/async.ts";

import type { App, AppDeps } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import type { AmbientHelpers } from "./app-ambient.ts";
import { isUserMessage } from "../sessions/items.ts";
import {
  admitTurn,
  alreadyDelivered,
  attributedSteerText,
  refuseSealedThread,
  refuseUnservedRuntime,
  steerAmbientRun,
  steerLiveRun,
  stopRunTree,
  turnConversation,
  turnInput,
  turnIntent,
  USER_STOP,
  warmRuntimeCatalog,
  withCurrentProjectRoster,
} from "./app-turn-pipeline.ts";

const PARTICIPANT_REHYDRATE_TIMEOUT_MS = 5_000;

function turnMethod(deps: AppDeps, h: AppHelpers, ambient: AmbientHelpers) {
  const { shouldRouteToSpine, markTriggerHandled, addressedWakeText } = ambient;
  return {
    async turn(req: TurnRequest, replay?: { signalDedupKey: string }): Promise<TurnResult> {
      const startedAt = performance.now();
      const adm = await admitTurn(deps, h, req);
      if ("status" in adm) return adm;
      const { actor, targetScope, projectVersion } = adm;
      const storedOrgRuntime = await warmRuntimeCatalog(deps, targetScope);
      const intent = await turnIntent(deps, req, actor);
      const { origin } = intent;
      const unserved = await refuseUnservedRuntime(deps, h, req, adm, intent, storedOrgRuntime);
      if (unserved) return unserved;
      const conversation = turnConversation(deps, req, adm);
      const input = turnInput(req, adm, intent, conversation);
      const sealed = await refuseSealedThread(deps, h, req, adm, conversation);
      if (sealed) return sealed;
      let request = input;

      const redeliveryKey = req.approval ? undefined : req.redeliveryKey;
      if (await alreadyDelivered(deps, redeliveryKey, conversation.threadRef)) return { status: "silent" };
      let dedupKey: string | undefined = redeliveryKey;
      if (req.idempotencyKey) {
        dedupKey =
          projectVersion === undefined ? req.idempotencyKey : `${req.idempotencyKey}:project-${projectVersion}`;
        if (req.approval) dedupKey = `${dedupKey}:approval:${req.approval.requestId}:${req.approval.approved}`;
      }

      if (replay) dedupKey = replay.signalDedupKey;

      const liveRouted = await steerLiveRun(deps, h, req, adm, origin, conversation, input, redeliveryKey);
      if (liveRouted) return liveRouted;

      const spineRouted = !req.externalSlack && !req.approval && shouldRouteToSpine(request as OrchestratorInput);
      if (spineRouted) {
        request = { ...input, surfaceTools: true };
        if (origin.kind !== "ambient")
          request = {
            ...request,
            text: await addressedWakeText(input as OrchestratorInput),
            displayText: input.text,
            envelopeWrapped: true,
          };
      }
      const ambientRouted = spineRouted
        ? await steerAmbientRun(deps, h, req, adm, origin, conversation, input, redeliveryKey)
        : null;
      if (ambientRouted) return ambientRouted;

      const enqueue = () =>
        deps.runs.enqueue({
          sessionId: conversation.threadRef,
          request,
          maxAttempts: deps.maxAttempts,
          ...(dedupKey ? { dedupKey } : {}),
        });
      const enqueueStartedAt = performance.now();
      const enqueued = await withCurrentProjectRoster(deps, adm, enqueue);
      if (!enqueued) return { status: "refused", reason: "project membership changed; retry from the current project" };
      const { run, deduped } = enqueued;
      console.info("[turn] queued", {
        runId: run.id,
        preEnqueueMs: Math.round(enqueueStartedAt - startedAt),
        enqueueMs: Math.round(performance.now() - enqueueStartedAt),
      });
      if (deduped && redeliveryKey && run.dedupKey === redeliveryKey) return { status: "silent" };
      if (spineRouted && !deduped) markTriggerHandled(input as OrchestratorInput);
      if (deduped && run.result && isTerminal(run.status)) return h.withAdminLink(run.result);
      if (req.async) return { status: "queued", runId: run.id };
      return h.drive(run.id);
    },
  } satisfies Partial<App>;
}

function sessionStateMethods(deps: AppDeps, h: AppHelpers) {
  return {
    subscribeSessionStates(cb, opts) {
      if (!deps.sessionStateBus) return () => {};
      const lookupParticipants = async (threadRef: string): Promise<string[]> => {
        const session = await deps.sessions.getByThread(threadRef);
        return session ? deps.sessions.participantsOf(session.id) : [];
      };
      const rehydrate = async (event: SessionStateEvent): Promise<SessionStateEvent> => {
        if (!event.participantsShed) return event;
        const { participantsShed: _shed, ...bare } = event;
        const participants = await Promise.race([
          lookupParticipants(event.threadRef),
          sleep(PARTICIPANT_REHYDRATE_TIMEOUT_MS, { unref: true }).then(() => null),
        ]).catch(swallowAs("session-state: rehydrate participants", null));
        return participants?.length ? { ...bare, participants } : bare;
      };
      let tail: Promise<void> = Promise.resolve();
      const queue = (step: () => void | Promise<void>): void => {
        tail = tail.then(step).catch(swallowAs("session-state: subscriber", undefined));
      };
      const onResync = opts?.onResync;
      return deps.sessionStateBus.subscribe(
        (event) => queue(async () => cb(await rehydrate(event))),
        onResync ? { onResync: () => queue(onResync) } : undefined,
      );
    },

    subscribeLedgerEvents: (cb, opts) => deps.ledgerEventBus?.subscribe(cb, opts) ?? (() => {}),

    async getApproval(requestId, viewer) {
      const record = await deps.approvals?.get(requestId);
      if (!record || !(await h.approvalRecordIsCurrent(record))) return null;
      if (viewer) {
        const session = await deps.sessions.get(record.sessionId);
        if (!session || !(await h.approvalVisibleToViewer(session, viewer, record))) return null;
      }
      return { requestId, ...record };
    },

    async listSessionApprovals(sessionId, viewer) {
      if (!(await h.sessionForViewer(sessionId, viewer))) return [];
      return h.pendingApprovalForSession(sessionId, { blockingOnly: false, viewer });
    },

    pendingApprovalForThread: (threadRef, viewer) => h.pendingApprovalResultForThread(threadRef, viewer),

    subscribeRun(runId, listener, onResync) {
      return (
        deps.runStreamEvents?.subscribe(
          (event) => {
            if (event.runId === runId) listener(event);
          },
          { onResync },
        ) ?? (() => {})
      );
    },

    syncRunStream(runId, offset, reasoning) {
      deps.runStreamEvents?.emit({ runId, kind: "sync", offset, reasoning });
    },
  } satisfies Partial<App>;
}

function runViewMethods(deps: AppDeps, h: AppHelpers) {
  return {
    async getRun(runId, viewer) {
      const run = await deps.runs.get(runId);
      if (!run) return null;
      if (viewer && !(await h.viewerMayUseRun(run, viewer))) return null;
      const partial = deps.turnStream?.snapshot(runId);
      const goal = deps.turnStream?.goal(runId);
      const runtime = deps.turnStream?.runtime(runId) ?? run.result?.runtime;
      const firstBlock = deps.turnStream?.firstBlock(runId);
      const surfacePosted = deps.turnStream?.surfacePosted(runId) ?? false;
      const alive = run.status === "running";
      const replying = deps.turnStream?.replying(runId) ?? false;
      const replyComplete = deps.turnStream?.isReplyDone(runId) ?? false;
      const activity = await deps.runActivity?.list(runId);
      const reasoning = deps.turnStream?.reasoning(runId) ?? [];
      const stale = run.status === "pending" && run.attempts > 0;
      return {
        desktopClientId: desktopClientForTurn({ ...run.request, attempt: run.attempts }),
        status: run.status,
        attempt: run.attempts,
        result: run.result ? await h.withAdminLink(run.result) : run.result,
        ...(surfaceHas(run.request.surface, "editableTurns") &&
        !run.request.approval &&
        !run.request.envelopeWrapped &&
        !(run.request.proactiveOpener && !run.request.text.trim()) &&
        isPersonAuthored(run.request.origin.kind)
          ? {
              input: {
                runId: run.id,
                seq: run.turnUserSeq,
                text: run.request.displayText ?? run.request.text ?? "",
                createdAt: run.createdAt,
                ...(run.request.attachments?.length
                  ? {
                      attachments: run.request.attachments.map(({ name, mimetype, sizeBytes }) => ({
                        name,
                        mimetype,
                        sizeBytes,
                      })),
                    }
                  : {}),
              },
            }
          : {}),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        ...(goal ? { goal } : {}),
        ...(runtime ? { runtime } : {}),
        ...(partial ? { partial, partialStartOffset: deps.turnStream!.startOffset(runId) } : {}),
        ...(firstBlock
          ? { firstBlock: firstBlock.text, ...(firstBlock.closed ? { firstBlockClosed: true } : {}) }
          : {}),
        ...(surfacePosted ? { surfacePosted: true } : {}),
        ...(alive ? { alive: true } : {}),
        ...(stale ? { stale: true } : {}),
        ...(replying ? { replying: true } : {}),
        ...(replyComplete ? { replyComplete: true } : {}),
        ...(activity && activity.length ? { activity } : {}),
        ...(reasoning.length ? { reasoning } : {}),
      };
    },

    async getRunToolItems(runId, viewer, afterSeq) {
      const run = await deps.runs.get(runId);
      if (!run || run.turnUserSeq === null) return [];
      if (viewer && !(await h.viewerMayUseRun(run, viewer))) return [];
      const session = await deps.sessions.getByThread(run.sessionId);
      if (!session) return [];
      const items = await deps.sessions.getItems(session.id, {
        sinceSeq: Math.max(run.turnUserSeq, (afterSeq ?? -1) + 1),
      });
      const nextRun = items.findIndex((e) => isUserMessage(e) && e.turnId !== null && e.turnId !== runId);
      return items
        .slice(0, nextRun < 0 ? undefined : nextRun)
        .filter((e) => e.kind === "ToolCall" || e.kind === "ToolResult");
    },

    async stopConversation(threadRef, viewer) {
      const session = await deps.sessions.getByThread(threadRef);
      const signals = deps.signals;
      if (!session || !signals || (viewer && !(await h.sessionForViewer(session.id, viewer)))) return false;
      return withSessionTreeLock(deps.advisoryLock, deps.sessions, session, () =>
        stopSessionTree({ sessions: deps.sessions, runs: deps.runs, signals }, session, USER_STOP),
      );
    },

    async activeRunForThread(threadRef, viewer) {
      const inFlight = await deps.runs.inFlightForThread(threadRef);
      const visible: typeof inFlight = [];
      for (const run of inFlight) if (!viewer || (await h.viewerMayUseRun(run, viewer))) visible.push(run);
      const live = visible[0];
      if (!live) return null;
      const queued = visible
        .slice(1)
        .filter((run) => isPersonAuthored(run.request.origin.kind))
        .map((run) => ({
          runId: run.id,
          text: run.request.displayText ?? run.request.text ?? "",
          ...(run.request.attachments?.length ? { hasAttachments: true } : {}),
        }));
      return { runId: live.id, ...(queued.length ? { queued } : {}) };
    },

    async editQueuedRun(runId, text, expectedText, viewer) {
      const run = await deps.runs.get(runId);
      if (!run || (viewer && (!samePerson(run.request.actor.id, viewer) || !(await h.viewerMayUseRun(run, viewer)))))
        return { edited: false, reason: "not_found" };
      if (
        !surfaceHas(run.request.surface, "editableTurns") ||
        run.request.envelopeWrapped ||
        !isPersonAuthored(run.request.origin.kind)
      )
        return { edited: false, reason: "not_editable" };
      if (!text.trim() && !run.request.attachments?.length) return { edited: false, reason: "empty_text" };
      return (await deps.runs.editPendingText(runId, text, expectedText))
        ? { edited: true }
        : { edited: false, reason: "changed_or_started" };
    },

    async withdrawRun(runId, viewer) {
      const run = await deps.runs.get(runId);
      if (!run) return { withdrawn: false, reason: "not_found" };
      if (viewer && !(await h.viewerMayUseRun(run, viewer))) return { withdrawn: false, reason: "not_found" };
      return (await deps.runs.withdraw(runId)) ? { withdrawn: true } : { withdrawn: false, reason: "started" };
    },
  } satisfies Partial<App>;
}

function signalMethods(deps: AppDeps, h: AppHelpers) {
  return {
    async signalRun(runId, signal, viewer) {
      if (!deps.signals) return { accepted: false, reason: "signals_unavailable" };
      const run = await deps.runs.get(runId);
      if (!run) return { accepted: false, reason: "not_found" };
      if (viewer && !(await h.viewerMayUseRun(run, viewer))) return { accepted: false, reason: "not_found" };
      if (
        signal.kind === "steer" &&
        surfaceHas(run.request.surface, "sidebar") &&
        /^web:.+:inbox$/.test(run.request.conversation.threadRef) &&
        !signal.request
      )
        return { accepted: false, reason: "conversation_mismatch" };
      const queuedKey = signal.queuedRunId
        ? `queued-steer:${run.request.conversation.threadRef}:${signal.queuedRunId}`
        : undefined;
      if (queuedKey && (await deps.signals.hasDedupeKey(queuedKey))) return { accepted: true };
      if (isTerminal(run.status)) return { accepted: false, reason: "terminal" };
      if (signal.kind === "abort") {
        const accepted = await stopRunTree(deps, run);
        return accepted ? { accepted: true } : { accepted: false, reason: "terminal" };
      }
      if (signal.kind === "client_result") {
        if (viewer && !samePerson(run.request.actor.id, viewer)) return { accepted: false, reason: "not_found" };
        if (!run.request.clientTools?.length && !run.request.desktopClientId)
          return { accepted: false, reason: "no_client_tools" };
        const sent = await deps.signals.send(runId, {
          kind: "client_result",
          callId: signal.callId,
          result: signal.result,
          dedupeKey: `client:${runId}:${signal.callId}`,
        });
        return sent ? { accepted: true } : { accepted: false, reason: "duplicate" };
      }
      if (signal.queuedRunId) {
        const queued = await deps.runs.get(signal.queuedRunId);
        if (!queued || (viewer && !(await h.viewerMayUseRun(queued, viewer))))
          return { accepted: false, reason: "not_found" };
        if (
          signal.kind !== "steer" ||
          !signal.request ||
          queued.request.conversation.threadRef !== run.request.conversation.threadRef
        )
          return { accepted: false, reason: "conversation_mismatch" };
        if (queued.id === run.id || !isUnstarted(queued)) return { accepted: false, reason: "queued_started" };
        const text = queued.request.displayText ?? queued.request.text;
        signal = {
          ...signal,
          text,
          ts: queuedKey,
          dedupeKey: queuedKey,
          request: { ...signal.request, text, attachments: queued.request.attachments, idempotencyKey: queuedKey },
        };
      }
      if (signal.kind === "steer" && !signal.text?.trim() && !signal.request?.attachments?.length) {
        return { accepted: false, reason: "text_required" };
      }
      if (signal.request && signal.request.conversation.threadRef !== run.request.conversation.threadRef) {
        return { accepted: false, reason: "conversation_mismatch" };
      }
      if (signal.kind === "steer") {
        const principal = viewer ?? signal.request?.actor.externalId ?? run.request.actor.id;
        const account = principal ? await deps.config.getModelAccountDurable(principal) : undefined;
        if (
          !account ||
          run.request.modelAccount !== account ||
          (account !== "company" && run.request.actor.id !== principal)
        ) {
          return { accepted: false, reason: "account_changed: send a new message to use your selected AI account" };
        }
      }
      let outbound = signal;
      if (signal.kind === "steer") {
        const requestActor = signal.request?.actor;
        let steerer: { id: string; displayName?: string | undefined } | undefined;
        if (requestActor) steerer = { id: requestActor.externalId, displayName: requestActor.displayName };
        else if (viewer) {
          steerer = { id: viewer, displayName: (await deps.directory.get(viewer).catch(() => null))?.displayName };
        }
        outbound = {
          ...signal,
          ts: signal.ts ?? `${Date.now()}.${crypto.randomUUID().slice(0, 8)}`,
          ...(steerer ? { text: attributedSteerText(steerer, run.request.actor.id, signal.text ?? "") } : {}),
        };
      }
      if (signal.queuedRunId) {
        if (!(await deps.runs.steerQueued(signal.queuedRunId, runId, outbound))) {
          if (await deps.signals.hasDedupeKey(queuedKey!)) return { accepted: true };
          const queued = await deps.runs.get(signal.queuedRunId);
          return { accepted: false, reason: queued && isUnstarted(queued) ? "queued_changed" : "queued_started" };
        }
      } else await deps.signals.send(runId, outbound);
      const after = await deps.runs.get(runId);
      if (!after || isTerminal(after.status)) {
        const drained = await h.replayOrphanedRunSignals(runId);
        if (signal.kind !== "steer") return { accepted: false, reason: "terminal" };
        const own = drained.find((d) => d.signal.ts === outbound.ts);
        if (own && !own.replayRunId) return { accepted: false, reason: "terminal" };
        return { accepted: false, reason: "terminal", replayed: true };
      }
      return { accepted: true };
    },

    replayOrphanedRunSignals: (runId) => h.replayOrphanedRunSignals(runId).then(() => undefined),
  } satisfies Partial<App>;
}

export function createTurnMethods(deps: AppDeps, h: AppHelpers, ambient: AmbientHelpers) {
  return {
    ...turnMethod(deps, h, ambient),
    ...sessionStateMethods(deps, h),
    ...runViewMethods(deps, h),
    ...signalMethods(deps, h),
  } satisfies Partial<App>;
}
