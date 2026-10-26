import type { ActorAssertion } from "./identity.ts";

export function parseAllowFrom(raw: string | undefined): string[] {
  const entries = (raw ?? "").split(/[\s,]+/).map((part) => part.trim().toLowerCase().replace(/^@+/, ""));
  return [...new Set(entries.filter(Boolean))];
}

export function normalizeAllowFrom(entries: readonly unknown[] | undefined): string[] {
  if (!entries) return [];
  return parseAllowFrom(entries.filter((e) => typeof e === "string").join(","));
}

export type ActorGate = (actor: ActorAssertion) => boolean;

export function createActorGate(entries: readonly string[] | undefined): ActorGate | undefined {
  if (!entries?.length) return undefined;
  const allowed = new Set(entries);
  return (actor: ActorAssertion): boolean => {
    if (actor.isBot || actor.isExternalGuest) return false;
    const email = actor.externalId.trim().toLowerCase();
    const at = email.lastIndexOf("@");
    return at > 0 && (allowed.has(email) || allowed.has(email.slice(at + 1)));
  };
}

export interface DenyResponder {
  message: string;
  shouldSend(key: string): boolean;
}

export function createDenyResponder(message: string | undefined, ttlMs = 60 * 60_000): DenyResponder | undefined {
  const text = message?.trim();
  if (!text) return undefined;
  const lastSent = new Map<string, number>();
  return {
    message: text,
    shouldSend(key: string): boolean {
      const now = Date.now();
      const prev = lastSent.get(key);
      if (prev !== undefined && now - prev < ttlMs) return false;
      if (lastSent.size >= 5000) {
        for (const [k, at] of lastSent) {
          if (now - at >= ttlMs) lastSent.delete(k);
        }
        if (lastSent.size >= 5000) lastSent.clear();
      }
      lastSent.set(key, now);
      return true;
    },
  };
}
