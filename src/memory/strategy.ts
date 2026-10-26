import type { ScopeId } from "../types.ts";
import type { MemoryCaptureMetadata } from "./facts.ts";

export interface MemoryStrategy {
  onTurnEnd?(
    ctx: MemoryCaptureMetadata & {
      scopeId: ScopeId;
      input: string;
      reply: string;
      actorId?: string;
      autonomous?: boolean;
      conversationScopeId?: ScopeId;
      sessionId?: string;
      idempotencyKey?: string;
    },
  ): Promise<void>;
  promptLines?(): string[];
}
