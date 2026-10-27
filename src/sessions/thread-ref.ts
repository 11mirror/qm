export const SUBAGENT_THREAD_PREFIX = "agent:main:subagent:";

export function isSubagentThreadRef(threadRef: string): boolean {
  return threadRef.startsWith(SUBAGENT_THREAD_PREFIX);
}

export function isWebInboxThreadRef(threadRef: string): boolean {
  const [surface, ...rest] = threadRef.split(":");
  return surface === "web" && rest.length >= 2 && rest.at(-1) === "inbox" && rest.slice(0, -1).join(":") !== "";
}

export type SessionOrigin = "conversation" | "cron" | "webhook" | "monitor" | "loop" | "swarm";

const ORIGINS: ReadonlySet<string> = new Set(["cron", "webhook", "monitor", "loop", "swarm"]);
const AGENT_PREFIX = "agent:main:";

function parseThreadRef(threadRef: string | null | undefined): { origin: SessionOrigin; id: string } | null {
  const ref = threadRef ?? "";
  const agent = ref.startsWith(AGENT_PREFIX);
  const [origin = "", id, ...rest] = (agent ? ref.slice(AGENT_PREFIX.length) : ref).split(":");
  if (!ORIGINS.has(origin) || !id || (agent ? rest.length > 0 : rest.length === 1 && !rest[0])) return null;
  return { origin: origin as SessionOrigin, id };
}

export function sessionOrigin(threadRef: string | null | undefined): SessionOrigin {
  return parseThreadRef(threadRef)?.origin ?? "conversation";
}

export function cronIdOf(threadRef: string | null | undefined): string | null {
  const parsed = parseThreadRef(threadRef);
  return parsed?.origin === "cron" ? parsed.id : null;
}
