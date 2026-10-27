import type { BackgroundWakeTrigger } from "../types.ts";

const WAKE_TRIGGERS: ReadonlySet<string> = new Set(["cron", "webhook", "monitor"]);

export const isWakeTrigger = (trigger: string): trigger is BackgroundWakeTrigger => WAKE_TRIGGERS.has(trigger);

export interface ParsedWakeFireKey {
  trigger: BackgroundWakeTrigger;
  sourceId: string;
  fireSlot: string | null;
  fireKey: string;
}

export function wakeTriggerLabel(trigger: string | undefined | null): string {
  switch ((trigger ?? "").toLowerCase()) {
    case "cron":
      return "Cron";
    case "monitor":
      return "Monitor wake";
    case "webhook":
      return "Webhook wake";
    default:
      return "Background wake";
  }
}

export function parseWakeFireKey(fireKey: string | undefined | null): ParsedWakeFireKey | null {
  if (!fireKey) return null;
  const [trigger = "", sourceId, ...slot] = fireKey.split(":");
  const fireSlot = slot.join(":");
  if (!isWakeTrigger(trigger) || !sourceId || (slot.length > 0 && !fireSlot)) return null;
  return { trigger, sourceId, fireSlot: slot.length ? fireSlot : null, fireKey };
}
