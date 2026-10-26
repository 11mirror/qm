import type { App } from "../../app.ts";
import { parseScopeId, type Cron, type Session } from "../../../types.ts";
import type { SessionSummary } from "../../../sessions/session-store.ts";
import { parseWakeFireKey, wakeTriggerLabel } from "../../../triggers/provenance.ts";
import { pick } from "./common.ts";

const ADMIN_CRON_FIELDS = [
  "id",
  "ownerScopeId",
  "title",
  "action",
  "message",
  "owner",
  "createdBy",
  "enabled",
  "archived",
  "schedule",
  "createdAt",
  "lastFiredAt",
] as const;

type AdminCronOrigin = {
  kind: "cron";
  label: string;
  cronId: string;
  fireKey: string;
  fireSlot: string | null;
  monologue?: boolean;
  cron: Pick<Cron, (typeof ADMIN_CRON_FIELDS)[number]> | null;
};

type AdminWakeOrigin = {
  kind: "background_wake";
  label: string;
  trigger: string;
  fireKey: string;
  fireSlot: string | null;
  sourceId: string | null;
  sourceScopeId?: string;
  sourceThreadRef?: string;
  monologue?: boolean;
};

type AdminOrigin = AdminCronOrigin | AdminWakeOrigin;

export type AdminSessionOrigin = "cron" | "other_background";

type AdminWakeRef = NonNullable<ReturnType<typeof parseWakeFireKey>> & { monologue?: boolean };

export function parseSessionWakeRef(threadRef: string | undefined | null): AdminWakeRef | null {
  const fire = parseWakeFireKey(threadRef);
  if (fire) return fire;
  const stable = /^agent:main:([a-z][a-z0-9_-]*):([^:]+)$/.exec(threadRef ?? "");
  if (!stable) return null;
  const parsed = parseWakeFireKey(`${stable[1]}:${stable[2]}`);
  return parsed ? { ...parsed, fireKey: threadRef!, monologue: true } : null;
}

export function sessionKind(session: Pick<Session, "type" | "threadRef"> | SessionSummary): string {
  const wake = parseSessionWakeRef(session.threadRef);
  if (!wake) return session.type;
  return wake.monologue ? `${wake.trigger}_monologue` : `${wake.trigger}_wake`;
}

const MONOLOGUE_LABELS = new Map([
  ["cron", "Cron monologue"],
  ["monitor", "Monitor monologue"],
  ["webhook", "Webhook monologue"],
]);

const wakeSessionLabel = (trigger: string, monologue?: boolean): string =>
  monologue ? (MONOLOGUE_LABELS.get(trigger) ?? "Background monologue") : wakeTriggerLabel(trigger);

async function cronWakeOrigin(
  app: App,
  parsed: AdminWakeRef,
  requestedScope: string,
  sourceScope: string,
  cronLookup?: Map<string, Cron>,
): Promise<AdminCronOrigin> {
  const cron = cronLookup ? (cronLookup.get(parsed.sourceId) ?? null) : await app.getCron(parsed.sourceId);
  const orgWide = parseScopeId(requestedScope).kind === "org";
  return {
    kind: "cron",
    label: wakeSessionLabel("cron", parsed.monologue),
    cronId: parsed.sourceId,
    fireKey: parsed.fireKey,
    fireSlot: parsed.fireSlot,
    ...(parsed.monologue ? { monologue: true } : {}),
    cron: cron && (orgWide || cron.ownerScopeId === sourceScope) ? pick(cron, ADMIN_CRON_FIELDS) : null,
  };
}

export async function sessionOrigin(
  app: App,
  session: Pick<Session, "threadRef" | "scopeId">,
  requestedScope: string,
  cronLookup?: Map<string, Cron>,
): Promise<AdminOrigin | null> {
  const parsed = parseSessionWakeRef(session.threadRef);
  if (!parsed) return null;
  if (parsed.trigger === "cron") return cronWakeOrigin(app, parsed, requestedScope, session.scopeId, cronLookup);
  return {
    kind: "background_wake",
    label: wakeSessionLabel(parsed.trigger, parsed.monologue),
    trigger: parsed.trigger,
    fireKey: parsed.fireKey,
    fireSlot: parsed.fireSlot,
    sourceId: parsed.sourceId,
    ...(parsed.monologue ? { monologue: true } : {}),
  };
}
