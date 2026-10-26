export const SUBAGENT_THREAD_PREFIX = "agent:main:subagent:";

export function isSubagentThreadRef(threadRef: string): boolean {
  return threadRef.startsWith(SUBAGENT_THREAD_PREFIX);
}

export type SessionOrigin = "conversation" | "cron" | "webhook" | "monitor" | "loop" | "swarm";

/** Thread refs carry their origin in one of two live shapes: `agent:main:<origin>:<id>` for a background
 * thread that persists across runs, and `<origin>:<id>[:…]` for one fire (a cron slot, a webhook delivery,
 * a swarm). Both are parsed here and nowhere else. */
const ORIGIN_ALTERNATION = "(cron|webhook|monitor|loop|swarm)";
const AGENT_ORIGIN_RE = new RegExp(`^agent:main:${ORIGIN_ALTERNATION}:[^:]+$`);
const FIRE_ORIGIN_RE = new RegExp(`^${ORIGIN_ALTERNATION}:[^:]+(:.+)?$`);
const AGENT_CRON_ID_RE = /^agent:main:cron:([^:]+)$/;
const FIRE_CRON_ID_RE = /^cron:([^:]+)(:.+)?$/;

export function sessionOrigin(threadRef: string | null | undefined): SessionOrigin {
  const match = AGENT_ORIGIN_RE.exec(threadRef ?? "") ?? FIRE_ORIGIN_RE.exec(threadRef ?? "");
  if (match) return match[1] as SessionOrigin;
  return "conversation";
}

export function cronIdOf(threadRef: string | null | undefined): string | null {
  const m = AGENT_CRON_ID_RE.exec(threadRef ?? "") ?? FIRE_CRON_ID_RE.exec(threadRef ?? "");
  return m ? m[1]! : null;
}
