import type { TurnRequest } from "../../src/types.ts";

export function dmFor(actor: TurnRequest["actor"]): (text: string, thread: string) => TurnRequest {
  return (text, thread) => ({
    origin: { kind: "direct" },
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: thread },
    text,
  });
}
