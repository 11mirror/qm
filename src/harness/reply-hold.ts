import type { HarnessTurnInput } from "./harness.ts";

export const REPLY_CHECK_RETRIES = 2;

export interface ReplyHold {
  blockStart(): void;
  delta(text: string): void;
  release(): void;
  drop(): void;
}

export function createReplyHold(sink: Pick<HarnessTurnInput, "onDelta" | "onTextBlockStart">): ReplyHold {
  let ops: Array<() => void> = [];
  return {
    blockStart() {
      ops.push(() => void sink.onTextBlockStart?.());
    },
    delta(text) {
      ops.push(() => sink.onDelta?.(text));
    },
    release() {
      const run = ops;
      ops = [];
      for (const op of run) op();
    },
    drop() {
      ops = [];
    },
  };
}

export const replyCheckPrompt = (note: string): string =>
  `[system] Your reply above was held back by the reply check and will not be shown. ${note.trim()} Write the full reply again now.`;
