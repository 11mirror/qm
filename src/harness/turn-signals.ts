// How a running pi turn listens for being stopped or steered: the run's cancel signal (a lost
// lease), and the run-signal poll that delivers user steers and user aborts.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { startSignalPoll, type RunSignalStore } from "../runs/run-signal-store.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import type { ToolContextRef } from "./agent-tools.ts";
import type { HarnessTurnInput } from "./harness.ts";
import type { SteerIntake } from "./harness-shared.ts";
import { recordedMessageTimestamps } from "./replay.ts";

/** Whether the user stopped this turn, and why. */
export interface TurnStop {
  userAborted: boolean;
  abortReason?: string;
}

/**
 * Abort the turn when its cancel signal fires, and poll the run's signals for steers (queued into
 * the live session) and user aborts (recorded on `stop`). `release` detaches both.
 */
export function watchTurnSignals(o: {
  turn: HarnessTurnInput;
  entry: { agentSession: AgentSession; ref: ToolContextRef };
  signals: RunSignalStore | undefined;
  toolAbort: AbortController;
  pendingSteers: Array<SteerIntake & { prompt: string }>;
  stop: TurnStop;
}): { release: () => Promise<void> } {
  const { turn, entry, signals, toolAbort, pendingSteers, stop } = o;
  const onCancel = (): void => {
    toolAbort.abort();
    entry.agentSession.clearQueue();
    void entry.agentSession.abort().catch(swallowAs("pi: lease-lost abort", undefined));
  };
  if (turn.cancel) {
    if (turn.cancel.aborted) onCancel();
    else turn.cancel.addEventListener("abort", onCancel, { once: true });
  }
  const steeredSeen = recordedMessageTimestamps(turn.history);
  const stopSignalPoll =
    signals && turn.runId
      ? startSignalPoll(
          signals,
          turn.runId,
          {
            onSteer: async (text, ts, request, acknowledge) => {
              if (ts && steeredSeen.has(ts)) return;
              const prepared = await turn.prepareSteer?.(text, request);
              const prompt = prepared?.text ?? text;
              if (!entry.agentSession.isStreaming || toolAbort.signal.aborted) return false;
              const steer = {
                text,
                prompt,
                ts,
                attachments: prepared?.attachments,
                images: prepared?.images,
                author: prepared?.author,
                acknowledge,
              };
              pendingSteers.push(steer);
              if (ts) steeredSeen.add(ts);
              if (prepared?.documents?.length)
                entry.ref.documents = [...(entry.ref.documents ?? []), ...prepared.documents];
              entry.ref.silentRequested = false;
              try {
                await entry.agentSession.steer(
                  prompt,
                  prepared?.images?.map((image) => ({
                    type: "image" as const,
                    mimeType: image.mimeType,
                    data: image.dataBase64,
                  })),
                );
              } catch (error) {
                const at = pendingSteers.indexOf(steer);
                if (at >= 0) pendingSteers.splice(at, 1);
                if (ts) steeredSeen.delete(ts);
                throw error;
              }
              return false;
            },
            onAbort: async (reason) => {
              stop.userAborted = true;
              stop.abortReason ??= reason;
              toolAbort.abort();
              entry.agentSession.clearQueue();
              await entry.agentSession.abort();
            },
          },
          { onError: (e) => swallow("pi: run signal poll", e) },
        )
      : null;
  return {
    release: async () => {
      turn.cancel?.removeEventListener("abort", onCancel);
      await stopSignalPoll?.();
    },
  };
}
