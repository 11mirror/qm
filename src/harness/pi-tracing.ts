import { startPhase, tracePhase, type Phase } from "../../plugins/chassis/src/error-reporting.ts";

export function createPiTrace(onRequest?: () => void) {
  let firstToken: Phase | undefined;
  let gap: Phase | undefined;
  const finish = (): void => {
    firstToken?.end();
    gap?.end();
    firstToken = gap = undefined;
  };
  return {
    request() {
      finish();
      onRequest?.();
      firstToken = startPhase("model.first_token");
    },
    event(event: { type?: string; message?: unknown }) {
      if (event.type === "message_update" || event.type === "message_end") {
        firstToken?.end();
        firstToken = undefined;
      }
      const message = event.message as { role?: string; stopReason?: string } | undefined;
      if (event.type === "message_end" && message?.role === "assistant" && message.stopReason === "toolUse") {
        gap?.end();
        gap = startPhase("step.gap");
      }
    },
    tool<T>(name: string, work: () => Promise<T>): Promise<T> {
      return tracePhase("step.tool", work, { name, parent: gap });
    },
    finish,
  };
}
